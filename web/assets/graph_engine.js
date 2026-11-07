/**
 * 농어촌 소방차량 스마트 진입로 판정 그래프 라우팅 엔진 (방식 B: vworld_api 기본 구동)
 *
 * 핵심 기능:
 * 1. 방식 B 단일 수치(mw, ew, xw) 고속 처리 + 백단 레거시 객체 스키마({vworld_api, or_fusion, defrag, old}) 호환 보존
 * 2. 15° 교차로 진입 방향 그룹 판정 (동일 방향 접근 간선 최악 폭 연동)
 * 3. NFA/KFI 아커만 기하학 회전반경(Swept-Path) 코너 유효폭 판정:
 *    - 교차로 꺾임각 theta >= 20° 회전 시 ΔW(theta) = extra90M * sin(min(theta, 120°)) 가산
 *    - min(직전간선 진출폭 xw, 다음간선 진입폭 ew) < threshold + ΔW(theta) 이면 회전 반경 부족 차단
 * 4. 2단계(1차 소방차 진입 + 2차 소방호스 연장) 다익스트라 경로 탐색 및 최단 소화용수 거점 매칭
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FirewayGraphEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VEHICLE_SPECS = {
    '2.0': {
      key: 2.0,
      name: '경형펌프/구급차',
      widthM: 1.99,
      threshold: 2.0,
      lengthM: 5.25,
      wheelbaseM: 3.27,
      frontOverhangM: 0.90,
      minTurnRadiusM: 5.80,
      extra90M: 0.65
    },
    '2.2': {
      key: 2.2,
      name: '소형펌프차(농촌주력)',
      widthM: 2.19,
      threshold: 2.2,
      lengthM: 6.78,
      wheelbaseM: 3.75,
      frontOverhangM: 1.15,
      minTurnRadiusM: 6.80,
      extra90M: 0.92
    },
    '2.5': {
      key: 2.5,
      name: '중형펌프/물탱크차',
      widthM: 2.45,
      threshold: 2.5,
      lengthM: 7.40,
      wheelbaseM: 4.10,
      frontOverhangM: 1.25,
      minTurnRadiusM: 7.60,
      extra90M: 1.02
    },
    '2.8': {
      key: 2.8,
      name: '대형펌프/특수차',
      widthM: 2.49,
      threshold: 2.8,
      lengthM: 7.80,
      wheelbaseM: 4.35,
      frontOverhangM: 1.35,
      minTurnRadiusM: 8.20,
      extra90M: 1.12
    }
  };

  const DIR_GROUP_TOL_RAD = (15.0 * Math.PI) / 180.0;

  function getVehicleSpec(threshold) {
    const thr = Number(threshold) || 2.5;
    if (thr <= 2.0) return VEHICLE_SPECS['2.0'];
    if (thr <= 2.2) return VEHICLE_SPECS['2.2'];
    if (thr <= 2.5) return VEHICLE_SPECS['2.5'];
    return VEHICLE_SPECS['2.8'];
  }

  function resolveWidthValue(rawVal, mode) {
    if (rawVal === null || rawVal === undefined) return null;
    if (typeof rawVal === 'number') {
      return Number.isFinite(rawVal) ? rawVal : null;
    }
    if (typeof rawVal === 'object') {
      const m = mode || 'vworld_api';
      const v = rawVal[m] !== undefined ? rawVal[m] : rawVal.vworld_api;
      return v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
    }
    const parsed = Number(rawVal);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function getEdgeWidth(edge, mode) {
    return resolveWidthValue(edge.mw, mode);
  }

  function getEntryWidth(edge, mode) {
    const ew = resolveWidthValue(edge.ew, mode);
    return ew !== null ? ew : getEdgeWidth(edge, mode);
  }

  function getExitWidth(edge, mode) {
    const xw = resolveWidthValue(edge.xw, mode);
    return xw !== null ? xw : getEdgeWidth(edge, mode);
  }

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000.0;
    const dLat = ((lat2 - lat1) * Math.PI) / 180.0;
    const dLng = ((lng2 - lng1) * Math.PI) / 180.0;
    const a =
      Math.sin(dLat * 0.5) * Math.sin(dLat * 0.5) +
      Math.cos((lat1 * Math.PI) / 180.0) *
        Math.cos((lat2 * Math.PI) / 180.0) *
        Math.sin(dLng * 0.5) *
        Math.sin(dLng * 0.5);
    return 2.0 * R * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0.0, 1.0 - a)));
  }

  function bearingRad(pt0, pt1) {
    const cosLat = Math.cos(((pt0[0] + pt1[0]) * 0.5 * Math.PI) / 180.0);
    const dy = pt1[0] - pt0[0];
    const dx = (pt1[1] - pt0[1]) * cosLat;
    return Math.atan2(dy, dx);
  }

  function angleDiffRad(a, b) {
    let d = Math.abs(a - b) % (2.0 * Math.PI);
    return d > Math.PI ? 2.0 * Math.PI - d : d;
  }

  function buildGraphIndex(graphData) {
    const nodeMap = new Map();
    const nodes = (graphData.nodes || []).map((row) => {
      const obj = {
        id: String(row[0]),
        lat: Number(row[1]),
        lng: Number(row[2]),
        type: String(row[3] || 'intersection'),
        degree: Number(row[4] || 1),
        minWidthM: resolveWidthValue(row[5], 'vworld_api')
      };
      nodeMap.set(obj.id, obj);
      return obj;
    });

    const approachesByNode = new Map();
    const approaches = (graphData.approaches || []).map((row) => {
      const coords = row[5] || [];
      const brg = coords.length >= 2 ? bearingRad(coords[0], coords[coords.length - 1]) : 0.0;
      const obj = {
        nodeId: String(row[0]),
        linkId: Number(row[1]),
        end: String(row[2]),
        mw: row[3],
        internal: Boolean(row[4]),
        coords: coords,
        bearing: brg
      };
      if (!approachesByNode.has(obj.nodeId)) {
        approachesByNode.set(obj.nodeId, []);
      }
      approachesByNode.get(obj.nodeId).push(obj);
      return obj;
    });

    const adj = new Map();
    const allAdj = new Map();
    const paths = (graphData.paths || []).map((row, idx) => {
      const coords = row[12] || [];
      const outBrg =
        coords.length >= 2
          ? bearingRad(coords[0], coords[Math.min(2, coords.length - 1)])
          : 0.0;
      const inBrg =
        coords.length >= 2
          ? bearingRad(coords[Math.max(0, coords.length - 3)], coords[coords.length - 1])
          : 0.0;
      const obj = {
        idx: idx,
        nodeId: String(row[0]),
        nodeType: String(row[1] || 'intersection'),
        linkId: Number(row[2]),
        end: String(row[3] || 'start'),
        toNodeId: row[4] !== null && row[4] !== undefined ? String(row[4]) : null,
        mw: row[5],
        ew: row[6],
        xw: row[7],
        lengthM: Number(row[8] || 1.0),
        hops: Number(row[9] || 1),
        deadEnd: Boolean(row[10]),
        source: String(row[11] || 'vworld_api'),
        coords: coords,
        outBearing: outBrg,
        inBearing: inBrg
      };
      if (!adj.has(obj.nodeId)) adj.set(obj.nodeId, []);
      adj.get(obj.nodeId).push(obj);

      if (!allAdj.has(obj.nodeId)) allAdj.set(obj.nodeId, []);
      allAdj.get(obj.nodeId).push(obj);
      return obj;
    });

    const villageMap = new Map();
    const villages = (graphData.villages || []).map((v) => {
      villageMap.set(v.id, v);
      return v;
    });

    // Build undirected connected components for topological reachability within village scopes
    const undirAdj = new Map();
    nodes.forEach((n) => undirAdj.set(n.id, []));
    paths.forEach((p) => {
      if (p.nodeId && p.toNodeId && nodeMap.has(p.nodeId) && nodeMap.has(p.toNodeId)) {
        undirAdj.get(p.nodeId).push(p.toNodeId);
        undirAdj.get(p.toNodeId).push(p.nodeId);
      }
    });
    const nodeToComp = new Map();
    const comps = [];
    nodes.forEach((n) => {
      if (nodeToComp.has(n.id)) return;
      const cid = comps.length;
      const compNodes = [];
      const queue = [n.id];
      nodeToComp.set(n.id, cid);
      while (queue.length > 0) {
        const cur = queue.shift();
        compNodes.push(cur);
        const nbList = undirAdj.get(cur) || [];
        for (let i = 0; i < nbList.length; i++) {
          const nb = nbList[i];
          if (!nodeToComp.has(nb)) {
            nodeToComp.set(nb, cid);
            queue.push(nb);
          }
        }
      }
      comps.push(compNodes);
    });

    const defaultEntryNodes = nodes
      .filter((n) => n.minWidthM !== null && n.minWidthM >= 2.8 && n.type !== 'dead_end')
      .map((n) => n.id);
    if (defaultEntryNodes.length === 0 && nodes.length > 0) {
      const sorted = [...nodes].sort((a, b) => (b.minWidthM || 0) - (a.minWidthM || 0));
      for (let i = 0; i < Math.min(16, sorted.length); i++) {
        defaultEntryNodes.push(sorted[i].id);
      }
    }

    return {
      code: graphData.code,
      name: graphData.name,
      center: graphData.center,
      bbox: graphData.bbox,
      nodes: nodes,
      nodeMap: nodeMap,
      paths: paths,
      approaches: approaches,
      approachesByNode: approachesByNode,
      adj: adj,
      allAdj: allAdj,
      undirAdj: undirAdj,
      nodeToComp: nodeToComp,
      comps: comps,
      villages: villages,
      villageMap: villageMap,
      buildings: graphData.buildings || [],
      hydrants: graphData.hydrants || [],
      defaultEntryNodes: defaultEntryNodes
    };
  }

  /**
   * Step 1 반영: 2D C-Space 스윕 폭(W_swept) 및 SoftMin 코리더 폭이 이미 반영된 간선 유효폭 판정 +
   * 협소 주거 골목 진입 시 급회전(>=70°) 코너 유효폭 판정
   * status: 0 = 통과 가능, 1 = 폭 미상, 2 = 진입 불가(폭 부족 또는 회전반경 부족)
   */
  function evaluateEdgeTransition(index, edge, prevEdge, threshold, mode) {
    const thr = Number(threshold) || 2.5;
    const w = getEdgeWidth(edge, mode);

    if (w === null) {
      return { status: 1, reason: 'unknown', widthM: null };
    }
    if (w < thr) {
      return { status: 2, reason: 'width_narrow', widthM: w, requiredWidthM: thr };
    }

    // Step 1: 급회전(>= 70°)으로 협소 주거 골목(w < thr + 0.25)에 진입할 때만 코너 스윕 추가 검증
    if (prevEdge && prevEdge.linkId !== edge.linkId && w < thr + 0.25) {
      const turnRad = angleDiffRad(prevEdge.inBearing, edge.outBearing);
      const turnDeg = (turnRad * 180.0) / Math.PI;
      if (turnDeg >= 70.0) {
        const prevExitW = getExitWidth(prevEdge, mode);
        const nextEntryW = getEntryWidth(edge, mode);
        const wIn = prevExitW !== null ? prevExitW : w;
        const wOut = nextEntryW !== null ? nextEntryW : w;
        const cornerW = Math.min(Math.sqrt(wIn * wOut), Math.min(wIn, wOut) + 0.65);
        const reqCornerW = Number((thr + 0.15).toFixed(2));
        if (cornerW < reqCornerW) {
          return {
            status: 2,
            reason: 'turn_radius',
            widthM: w,
            turnAngleDeg: Math.round(turnDeg),
            cornerWidthM: Number(cornerW.toFixed(2)),
            requiredCornerWidthM: reqCornerW
          };
        }
      }
    }

    return { status: 0, reason: 'passable', widthM: w };
  }

  const USER_START_ID = '__USER_START__';

  /**
   * 현재 분석된 마을(v)의 표시 경계(displayBounds)와 순수 VWorld 그래프 탐색 경계(searchBounds)를 분리 반환합니다.
   * - displayBounds: 화면 줌/경계 클리핑용 (docMapBounds 존재 시 일치시키고, 미존재 시 순수 VWorld v.bbox 폴백)
   * - searchBounds: 그래프 위상 탐색용 (순수 VWorld v.bbox와 displayBounds의 합집합을 사용하여 문서 경계에 의한 탐색 단절 차단)
   */
  function getVillageAnalyzedBounds(index, v) {
    if (!v) return null;
    const vb = Array.isArray(v.bbox) && v.bbox.length === 4 ? v.bbox.map(Number) : null;
    const db = Array.isArray(v.docMapBounds) && v.docMapBounds.length === 4 ? v.docMapBounds.map(Number) : null;
    const displayBounds = db || vb;
    if (!displayBounds) return null;

    const searchBounds =
      db && vb
        ? [
            Math.min(db[0], vb[0]),
            Math.min(db[1], vb[1]),
            Math.max(db[2], vb[2]),
            Math.max(db[3], vb[3])
          ]
        : displayBounds.slice();

    return {
      displayBounds: displayBounds,
      searchBounds: searchBounds
    };
  }

  function isPointInVillageScope(index, v, lat, lng, padDeg) {
    if (!v || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
    const bObj = getVillageAnalyzedBounds(index, v);
    if (!bObj) return false;
    const b = bObj.displayBounds;
    const pad = Number.isFinite(Number(padDeg)) ? Number(padDeg) : 0.0008;
    const pLat = Number(lat);
    const pLng = Number(lng);
    return pLat >= b[0] - pad && pLng >= b[1] - pad && pLat <= b[2] + pad && pLng <= b[3] + pad;
  }

  function getVillageEntrancePoint(index, v) {
    if (!v) return null;
    if (Array.isArray(v.entryNodeIds) && v.entryNodeIds.length > 0 && index && index.nodeMap) {
      for (let i = 0; i < v.entryNodeIds.length; i++) {
        const n = index.nodeMap.get(v.entryNodeIds[i]);
        if (n) {
          return {
            name: `${v.name}마을 입구`,
            lat: Number(n.lat.toFixed(6)),
            lng: Number(n.lng.toFixed(6)),
            badgeLat: Number(n.lat.toFixed(6)),
            badgeLng: Number(n.lng.toFixed(6))
          };
        }
      }
    }
    if (Array.isArray(v.center) && v.center.length === 2) {
      return {
        name: `${v.name}마을 입구`,
        lat: Number(Number(v.center[0]).toFixed(6)),
        lng: Number(Number(v.center[1]).toFixed(6)),
        badgeLat: Number(Number(v.center[0]).toFixed(6)),
        badgeLng: Number(Number(v.center[1]).toFixed(6))
      };
    }
    return null;
  }

  function getVillageScopeNodeSet(index, v) {
    if (!index || !v) return null;
    const bObj = getVillageAnalyzedBounds(index, v);
    if (!bObj) return null;
    const b = bObj.searchBounds;
    const pad = 0.0014;
    const set = new Set();
    for (let i = 0; i < index.nodes.length; i++) {
      const n = index.nodes[i];
      if (n.lat >= b[0] - pad && n.lng >= b[1] - pad && n.lat <= b[2] + pad && n.lng <= b[3] + pad) {
        set.add(n.id);
      }
    }
    if (Array.isArray(v.entryNodeIds)) {
      for (let i = 0; i < v.entryNodeIds.length; i++) {
        if (index.nodeMap.has(v.entryNodeIds[i])) {
          set.add(v.entryNodeIds[i]);
        }
      }
    }
    return set.size > 0 ? set : null;
  }

  function findAnalyzedVillageForPoint(index, lat, lng, preferredVillageId) {
    if (!index || !Array.isArray(index.villages)) return null;
    const pLat = Number(lat);
    const pLng = Number(lng);
    if (!Number.isFinite(pLat) || !Number.isFinite(pLng)) return null;

    if (preferredVillageId && index.villageMap && index.villageMap.has(preferredVillageId)) {
      const prefV = index.villageMap.get(preferredVillageId);
      if (isPointInVillageScope(index, prefV, pLat, pLng, 0.0008)) {
        return prefV;
      }
    }

    let bestStrict = null;
    let bestStrictDist = Infinity;
    for (let i = 0; i < index.villages.length; i++) {
      const v = index.villages[i];
      if (isPointInVillageScope(index, v, pLat, pLng, 0.0004)) {
        const c = v.center || [pLat, pLng];
        const d = haversineMeters(pLat, pLng, c[0], c[1]);
        if (d < bestStrictDist) {
          bestStrictDist = d;
          bestStrict = v;
        }
      }
    }
    if (bestStrict) return bestStrict;

    let bestPadded = null;
    let bestPaddedDist = Infinity;
    for (let i = 0; i < index.villages.length; i++) {
      const v = index.villages[i];
      if (isPointInVillageScope(index, v, pLat, pLng, 0.0012)) {
        const c = v.center || [pLat, pLng];
        const d = haversineMeters(pLat, pLng, c[0], c[1]);
        if (d < bestPaddedDist) {
          bestPaddedDist = d;
          bestPadded = v;
        }
      }
    }
    return bestPadded;
  }

  function polylineLengthM(coords) {
    if (!coords || coords.length < 2) return 0.0;
    let total = 0.0;
    for (let i = 0; i < coords.length - 1; i++) {
      total += haversineMeters(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    }
    return total;
  }

  function dedupCoords(coords) {
    const out = [];
    for (let i = 0; i < (coords || []).length; i++) {
      const pt = coords[i];
      if (
        out.length === 0 ||
        Math.abs(out[out.length - 1][0] - pt[0]) > 1e-7 ||
        Math.abs(out[out.length - 1][1] - pt[1]) > 1e-7
      ) {
        out.push([Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))]);
      }
    }
    return out;
  }

  /**
   * 사용자가 클릭한 실제 좌표 [lat, lng] 또는 마을 범위 진입 좌표를
   * 가장 가까운 도로 선형(edge polyline) 위의 투영점(projPt)에서 양방향 정점으로 이어지는
   * 가상 출발 간선(virtualEdges)으로 생성합니다.
   */
  function projectPointToRoad(index, lat, lng, threshold, mode, scopeNodeSet, preferredCompId, projOpts) {
    const startPt = [Number(Number(lat).toFixed(6)), Number(Number(lng).toFixed(6))];
    if (!index || !index.paths || index.paths.length === 0) {
      return null;
    }

    const pOpts = projOpts || {};
    const isBoundarySnap = Boolean(pOpts.boundarySnap);
    const maxCompPassSnapM = Number.isFinite(Number(pOpts.maxCompPassSnapM))
      ? Number(pOpts.maxCompPassSnapM)
      : isBoundarySnap
      ? 35.0
      : 180.0;
    const maxPassSnapM = Number.isFinite(Number(pOpts.maxPassSnapM))
      ? Number(pOpts.maxPassSnapM)
      : isBoundarySnap
      ? 35.0
      : 65.0;
    const maxCompSnapM = Number.isFinite(Number(pOpts.maxCompSnapM))
      ? Number(pOpts.maxCompSnapM)
      : 45.0;

    const thr = Number(threshold) || 2.5;
    const evalMode = mode || 'vworld_api';
    const kx = 111320.0 * Math.cos((lat * Math.PI) / 180.0);
    const ky = 110540.0;

    let bestEdge = null;
    let bestSegIdx = 0;
    let bestProjLat = lat;
    let bestProjLng = lng;
    let bestDistM = Infinity;

    let bestPassEdge = null;
    let bestPassSegIdx = 0;
    let bestPassProjLat = lat;
    let bestPassProjLng = lng;
    let bestPassDistM = Infinity;

    let bestCompEdge = null;
    let bestCompSegIdx = 0;
    let bestCompProjLat = lat;
    let bestCompProjLng = lng;
    let bestCompDistM = Infinity;

    let bestCompPassEdge = null;
    let bestCompPassSegIdx = 0;
    let bestCompPassProjLat = lat;
    let bestCompPassProjLng = lng;
    let bestCompPassDistM = Infinity;

    for (let i = 0; i < index.paths.length; i++) {
      const edge = index.paths[i];
      if (scopeNodeSet && !scopeNodeSet.has(edge.nodeId) && !scopeNodeSet.has(edge.toNodeId)) {
        continue;
      }
      const coords = edge.coords || [];
      const w = getEdgeWidth(edge, evalMode);
      const isPassableWidth = w !== null && w >= thr;
      const edgeComp =
        index.nodeToComp && index.nodeToComp.has(edge.nodeId)
          ? index.nodeToComp.get(edge.nodeId)
          : index.nodeToComp && index.nodeToComp.has(edge.toNodeId)
          ? index.nodeToComp.get(edge.toNodeId)
          : null;
      const isPreferredComp =
        preferredCompId !== undefined && preferredCompId !== null && edgeComp === preferredCompId;

      for (let k = 0; k < coords.length - 1; k++) {
        const A = coords[k];
        const B = coords[k + 1];
        const ax = (A[1] - lng) * kx;
        const ay = (A[0] - lat) * ky;
        const bx = (B[1] - lng) * kx;
        const by = (B[0] - lat) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const denom = dx * dx + dy * dy;
        const t = denom > 1e-12 ? Math.max(0.0, Math.min(1.0, -(ax * dx + ay * dy) / denom)) : 0.0;
        const pLat = A[0] + t * (B[0] - A[0]);
        const pLng = A[1] + t * (B[1] - A[1]);
        const dM = Math.hypot(ax + t * dx, ay + t * dy);
        if (dM < bestDistM) {
          bestDistM = dM;
          bestEdge = edge;
          bestSegIdx = k;
          bestProjLat = pLat;
          bestProjLng = pLng;
        }
        if (isPreferredComp && dM < bestCompDistM) {
          bestCompDistM = dM;
          bestCompEdge = edge;
          bestCompSegIdx = k;
          bestCompProjLat = pLat;
          bestCompProjLng = pLng;
        }
        if (isPassableWidth && dM < bestPassDistM) {
          bestPassDistM = dM;
          bestPassEdge = edge;
          bestPassSegIdx = k;
          bestPassProjLat = pLat;
          bestPassProjLng = pLng;
        }
        if (isPassableWidth && isPreferredComp && dM < bestCompPassDistM) {
          bestCompPassDistM = dM;
          bestCompPassEdge = edge;
          bestCompPassSegIdx = k;
          bestCompPassProjLat = pLat;
          bestCompPassProjLng = pLng;
        }
      }
    }

    if (isBoundarySnap) {
      if (bestCompPassEdge && bestCompPassDistM <= Math.min(maxCompPassSnapM, bestDistM + 28.0)) {
        bestEdge = bestCompPassEdge;
        bestSegIdx = bestCompPassSegIdx;
        bestProjLat = bestCompPassProjLat;
        bestProjLng = bestCompPassProjLng;
        bestDistM = bestCompPassDistM;
      } else if (bestPassEdge && bestPassDistM <= Math.min(maxPassSnapM, bestDistM + 24.0)) {
        bestEdge = bestPassEdge;
        bestSegIdx = bestPassSegIdx;
        bestProjLat = bestPassProjLat;
        bestProjLng = bestPassProjLng;
        bestDistM = bestPassDistM;
      } else if (bestCompEdge && bestCompDistM <= Math.min(maxCompSnapM, bestDistM + 30.0)) {
        bestEdge = bestCompEdge;
        bestSegIdx = bestCompSegIdx;
        bestProjLat = bestCompProjLat;
        bestProjLng = bestCompProjLng;
        bestDistM = bestCompDistM;
      }
    } else {
      if (bestCompPassEdge && bestCompPassDistM <= Math.max(maxCompPassSnapM, bestDistM + 140.0)) {
        bestEdge = bestCompPassEdge;
        bestSegIdx = bestCompPassSegIdx;
        bestProjLat = bestCompPassProjLat;
        bestProjLng = bestCompPassProjLng;
        bestDistM = bestCompPassDistM;
      } else if (bestPassEdge && bestPassDistM <= Math.max(maxPassSnapM, bestDistM + 40.0)) {
        bestEdge = bestPassEdge;
        bestSegIdx = bestPassSegIdx;
        bestProjLat = bestPassProjLat;
        bestProjLng = bestPassProjLng;
        bestDistM = bestPassDistM;
      }
    }

    if (!bestEdge && scopeNodeSet) {
      return projectPointToRoad(index, lat, lng, threshold, mode, null, preferredCompId, projOpts);
    }
    if (!bestEdge) return null;

    const projPt = [Number(bestProjLat.toFixed(6)), Number(bestProjLng.toFixed(6))];
    const offRoadM = haversineMeters(startPt[0], startPt[1], projPt[0], projPt[1]);
    const startAtProj = Boolean(pOpts.startAtProjPoint);

    // Forward partial polyline: (startPt ->) projPt -> bestEdge.toNodeId
    const polyFwd = dedupCoords([projPt, ...bestEdge.coords.slice(bestSegIdx + 1)]);
    const coordsFwd = startAtProj
      ? polyFwd
      : dedupCoords(offRoadM > 0.5 ? [startPt, ...polyFwd] : [startPt, ...polyFwd.slice(1)]);
    const lenFwd = Math.max(0.5, polylineLengthM(polyFwd) + (startAtProj ? 0.0 : offRoadM));

    // Backward partial polyline: (startPt ->) projPt -> bestEdge.nodeId
    const polyBwd = dedupCoords([projPt, ...bestEdge.coords.slice(0, bestSegIdx + 1).reverse()]);
    const coordsBwd = startAtProj
      ? polyBwd
      : dedupCoords(offRoadM > 0.5 ? [startPt, ...polyBwd] : [startPt, ...polyBwd.slice(1)]);
    const lenBwd = Math.max(0.5, polylineLengthM(polyBwd) + (startAtProj ? 0.0 : offRoadM));

    // Find reverse edge on the same linkId if present
    let revEdge = null;
    const revCandidates = index.adj.get(bestEdge.toNodeId) || [];
    for (let i = 0; i < revCandidates.length; i++) {
      if (revCandidates[i].linkId === bestEdge.linkId && revCandidates[i].toNodeId === bestEdge.nodeId) {
        revEdge = revCandidates[i];
        break;
      }
    }

    const virtualEdges = [];
    if (bestEdge.toNodeId && index.nodeMap.has(bestEdge.toNodeId)) {
      virtualEdges.push({
        idx: bestEdge.idx,
        nodeId: USER_START_ID,
        nodeType: 'user_start',
        linkId: bestEdge.linkId,
        end: bestEdge.end,
        toNodeId: bestEdge.toNodeId,
        mw: bestEdge.mw,
        ew: bestEdge.ew,
        xw: bestEdge.xw,
        lengthM: Number(lenFwd.toFixed(1)),
        hops: 1,
        deadEnd: bestEdge.deadEnd,
        source: bestEdge.source,
        coords: coordsFwd.length >= 2 ? coordsFwd : [projPt, [index.nodeMap.get(bestEdge.toNodeId).lat, index.nodeMap.get(bestEdge.toNodeId).lng]],
        outBearing: coordsFwd.length >= 2 ? bearingRad(coordsFwd[0], coordsFwd[1]) : bestEdge.outBearing,
        inBearing: coordsFwd.length >= 2 ? bearingRad(coordsFwd[coordsFwd.length - 2], coordsFwd[coordsFwd.length - 1]) : bestEdge.inBearing
      });
    }

    if (bestEdge.nodeId && index.nodeMap.has(bestEdge.nodeId)) {
      const bwdInBrg =
        coordsBwd.length >= 2
          ? bearingRad(coordsBwd[coordsBwd.length - 2], coordsBwd[coordsBwd.length - 1])
          : revEdge
          ? revEdge.inBearing
          : bestEdge.outBearing;
      virtualEdges.push({
        idx: revEdge ? revEdge.idx : bestEdge.idx,
        nodeId: USER_START_ID,
        nodeType: 'user_start',
        linkId: bestEdge.linkId,
        end: revEdge ? revEdge.end : 'end',
        toNodeId: bestEdge.nodeId,
        mw: revEdge ? revEdge.mw : bestEdge.mw,
        ew: revEdge ? revEdge.ew : bestEdge.xw,
        xw: revEdge ? revEdge.xw : bestEdge.ew,
        lengthM: Number(lenBwd.toFixed(1)),
        hops: 1,
        deadEnd: revEdge ? revEdge.deadEnd : false,
        source: bestEdge.source,
        coords: coordsBwd.length >= 2 ? coordsBwd : [projPt, [index.nodeMap.get(bestEdge.nodeId).lat, index.nodeMap.get(bestEdge.nodeId).lng]],
        outBearing: coordsBwd.length >= 2 ? bearingRad(coordsBwd[0], coordsBwd[1]) : (revEdge ? revEdge.outBearing : bestEdge.outBearing),
        inBearing: bwdInBrg
      });
    }

    // Legacy non-boundary mode only: optional bridge edge
    if (
      !isBoundarySnap &&
      !pOpts.disableBridgeEdge &&
      preferredCompId !== undefined &&
      preferredCompId !== null &&
      bestCompPassEdge &&
      bestCompPassEdge !== bestEdge
    ) {
      const gwNodeId = bestCompPassEdge.nodeId;
      const gwNode = index.nodeMap.get(gwNodeId);
      if (gwNode) {
        const bridgeLen = Math.max(1.0, haversineMeters(startPt[0], startPt[1], gwNode.lat, gwNode.lng));
        const bridgeCoords = [startPt, [Number(gwNode.lat.toFixed(6)), Number(gwNode.lng.toFixed(6))]];
        const brg = bearingRad(bridgeCoords[0], bridgeCoords[1]);
        virtualEdges.push({
          idx: bestCompPassEdge.idx,
          nodeId: USER_START_ID,
          nodeType: 'user_start',
          linkId: bestCompPassEdge.linkId,
          end: bestCompPassEdge.end,
          toNodeId: gwNodeId,
          mw: bestCompPassEdge.mw,
          ew: bestCompPassEdge.ew,
          xw: bestCompPassEdge.xw,
          lengthM: Number(bridgeLen.toFixed(1)),
          hops: 1,
          deadEnd: false,
          source: bestCompPassEdge.source,
          coords: bridgeCoords,
          outBearing: brg,
          inBearing: brg
        });
      }
    }

    return {
      startPoint: startPt,
      projPoint: projPt,
      offRoadDistM: Number(offRoadM.toFixed(1)),
      edge: bestEdge,
      revEdge: revEdge,
      virtualEdges: virtualEdges
    };
  }

  function getEntryNodesForScope(index, villageId) {
    if (villageId && index.villageMap.has(villageId)) {
      const v = index.villageMap.get(villageId);
      if (v.entryNodeIds && v.entryNodeIds.length > 0) {
        const combined = new Set(
          v.entryNodeIds.filter((nid) => {
            const n = index.nodeMap.get(nid);
            return n && n.type !== 'dead_end';
          })
        );
        for (let i = 0; i < index.defaultEntryNodes.length; i++) {
          combined.add(index.defaultEntryNodes[i]);
        }
        return Array.from(combined);
      }
    }
    return index.defaultEntryNodes;
  }

  function resolveEntryNodes(index, opts) {
    const o = opts || {};
    if (
      o.startLat !== undefined &&
      o.startLat !== null &&
      o.startLng !== undefined &&
      o.startLng !== null &&
      Number.isFinite(Number(o.startLat)) &&
      Number.isFinite(Number(o.startLng))
    ) {
      const proj = projectPointToRoad(
        index,
        Number(o.startLat),
        Number(o.startLng),
        Number(o.threshold) || 2.5,
        o.mode || 'vworld_api',
        o.scopeNodeSet || null,
        o.preferredCompId !== undefined ? o.preferredCompId : null
      );
      if (proj) {
        return {
          entryNodeIds: [USER_START_ID],
          isCustomStart: true,
          customStartNodeId: o.customStartNodeId || '마을입구',
          customStartPoint: proj.startPoint,
          customStartProj: proj
        };
      }
    }
    if (o.startNodeId && index.nodeMap.has(o.startNodeId)) {
      const n = index.nodeMap.get(o.startNodeId);
      return {
        entryNodeIds: [o.startNodeId],
        isCustomStart: true,
        customStartNodeId: o.startNodeId,
        customStartPoint: [n.lat, n.lng],
        customStartProj: null
      };
    }
    return {
      entryNodeIds: getEntryNodesForScope(index, o.villageId || null),
      isCustomStart: false,
      customStartNodeId: null,
      customStartPoint: null,
      customStartProj: null
    };
  }

  function runVehicleDijkstra(index, entryNodeIds, threshold, mode, customStartProj, scopeNodeSet) {
    const dist = new Map();
    const prevEdgeMap = new Map();
    const prevNodeMap = new Map();
    const originNodeMap = new Map();
    const visited = new Set();
    const reachablePathIdxs = new Set();
    const turnBlockedByPathIdx = new Map();

    // Simple binary heap priority queue
    const pq = [];
    function pushPQ(d, u) {
      pq.push([d, u]);
      let i = pq.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (pq[p][0] <= pq[i][0]) break;
        const tmp = pq[p];
        pq[p] = pq[i];
        pq[i] = tmp;
        i = p;
      }
    }
    function popPQ() {
      const top = pq[0];
      const last = pq.pop();
      if (pq.length > 0) {
        pq[0] = last;
        let i = 0;
        while (true) {
          let l = i * 2 + 1;
          let r = l + 1;
          let s = i;
          if (l < pq.length && pq[l][0] < pq[s][0]) s = l;
          if (r < pq.length && pq[r][0] < pq[s][0]) s = r;
          if (s === i) break;
          const tmp = pq[i];
          pq[i] = pq[s];
          pq[s] = tmp;
          i = s;
        }
      }
      return top;
    }

    if (customStartProj && entryNodeIds && entryNodeIds[0] === USER_START_ID) {
      dist.set(USER_START_ID, 0.0);
      prevEdgeMap.set(USER_START_ID, null);
      prevNodeMap.set(USER_START_ID, null);
      originNodeMap.set(USER_START_ID, USER_START_ID);
      pushPQ(0.0, USER_START_ID);
      for (let i = 1; i < entryNodeIds.length; i++) {
        const s = entryNodeIds[i];
        if (index.nodeMap.has(s) && (!scopeNodeSet || scopeNodeSet.has(s))) {
          dist.set(s, 0.0);
          prevEdgeMap.set(s, null);
          prevNodeMap.set(s, null);
          originNodeMap.set(s, s);
          pushPQ(0.0, s);
        }
      }
    } else {
      const starts = entryNodeIds && entryNodeIds.length > 0 ? entryNodeIds : index.defaultEntryNodes;
      for (let i = 0; i < starts.length; i++) {
        const s = starts[i];
        if (index.nodeMap.has(s) && (!scopeNodeSet || scopeNodeSet.has(s))) {
          dist.set(s, 0.0);
          prevEdgeMap.set(s, null);
          prevNodeMap.set(s, null);
          originNodeMap.set(s, s);
          pushPQ(0.0, s);
        }
      }
    }

    while (pq.length > 0) {
      const [dU, u] = popPQ();
      if (visited.has(u)) continue;
      visited.add(u);

      const pe = prevEdgeMap.get(u) || null;
      const outEdges =
        u === USER_START_ID && customStartProj ? customStartProj.virtualEdges : index.adj.get(u) || [];
      for (let i = 0; i < outEdges.length; i++) {
        const edge = outEdges[i];
        const v = edge.toNodeId;
        if (scopeNodeSet && u !== USER_START_ID && v && !scopeNodeSet.has(v)) {
          continue;
        }
        const ev = evaluateEdgeTransition(index, edge, pe, threshold, mode);
        if (ev.status !== 0) {
          if (ev.reason === 'turn_radius') {
            turnBlockedByPathIdx.set(edge.idx, ev);
          }
          continue;
        }
        reachablePathIdxs.add(edge.idx);
        if (!v || !index.nodeMap.has(v)) continue;
        const nd = dU + edge.lengthM;
        const curV = dist.has(v) ? dist.get(v) : Infinity;
        if (nd < curV) {
          dist.set(v, nd);
          prevEdgeMap.set(v, edge);
          prevNodeMap.set(v, u);
          originNodeMap.set(v, originNodeMap.get(u) || u);
          pushPQ(nd, v);
        }
      }
    }

    return {
      dist: dist,
      prevEdgeMap: prevEdgeMap,
      prevNodeMap: prevNodeMap,
      originNodeMap: originNodeMap,
      reachablePathIdxs: reachablePathIdxs,
      turnBlockedByPathIdx: turnBlockedByPathIdx
    };
  }

  function evaluateNetwork(index, options) {
    const opts = options || {};
    const thr = Number(opts.threshold) || 2.5;
    const mode = opts.mode || 'vworld_api';
    const villageId = opts.villageId || null;

    // 도로망 전체 주행성 판정은 의령소방서 단일 좌표 왜곡을 받지 않도록 광역 관문 다중 시작점을 유지합니다.
    const evalOpts = Object.assign({}, opts, {
      startLat: null,
      startLng: null,
      startNodeId: null
    });
    const resolved = resolveEntryNodes(index, evalOpts);
    const entryNodeIds = resolved.entryNodeIds;
    const dijk = runVehicleDijkstra(index, entryNodeIds, thr, mode, null, null);

    let passableCount = 0;
    let blockedCount = 0;
    let turnBlockedCount = 0;
    let unknownCount = 0;
    let totalLengthM = 0.0;

    const vObj = villageId && index.villageMap.has(villageId) ? index.villageMap.get(villageId) : null;
    const vBoundsObj = vObj ? getVillageAnalyzedBounds(index, vObj) : null;
    const villageBbox = vBoundsObj ? vBoundsObj.displayBounds : null;

    const pathStatuses = index.paths.map((edge) => {
      const w = getEdgeWidth(edge, mode);
      let status = 'unknown';
      let turnInfo = null;

      if (dijk.reachablePathIdxs.has(edge.idx)) {
        status = 'passable';
      } else if (w === null) {
        status = 'unknown';
      } else if (w < thr) {
        status = 'blocked_width';
      } else if (dijk.turnBlockedByPathIdx.has(edge.idx)) {
        status = 'blocked_turn';
        turnInfo = dijk.turnBlockedByPathIdx.get(edge.idx);
      } else {
        status = 'disconnected';
      }

      let inScope = true;
      if (villageBbox && edge.coords.length > 0) {
        const pt = edge.coords[0];
        inScope =
          pt[0] >= villageBbox[0] - 0.0012 &&
          pt[1] >= villageBbox[1] - 0.0012 &&
          pt[0] <= villageBbox[2] + 0.0012 &&
          pt[1] <= villageBbox[3] + 0.0012;
      }

      if (inScope) {
        totalLengthM += edge.lengthM * 0.5;
        if (status === 'passable') passableCount++;
        else if (status === 'blocked_turn') {
          blockedCount++;
          turnBlockedCount++;
        } else if (status === 'blocked_width' || status === 'disconnected') {
          blockedCount++;
        } else {
          unknownCount++;
        }
      }

      return {
        idx: edge.idx,
        status: status,
        widthM: w,
        turnInfo: turnInfo
      };
    });

    return {
      threshold: thr,
      mode: mode,
      villageId: villageId,
      entryNodeIds: entryNodeIds,
      isCustomStart: false,
      customStartNodeId: null,
      dijkstra: dijk,
      pathStatuses: pathStatuses,
      summary: {
        passableCount: passableCount,
        blockedCount: blockedCount,
        turnBlockedCount: turnBlockedCount,
        unknownCount: unknownCount,
        totalLengthM: Math.round(totalLengthM)
      }
    };
  }

  function findNearestNode(index, lat, lng, scopeNodeSet) {
    let bestNode = null;
    let bestDist = Infinity;
    for (let i = 0; i < index.nodes.length; i++) {
      const n = index.nodes[i];
      if (scopeNodeSet && !scopeNodeSet.has(n.id)) continue;
      const d = haversineMeters(lat, lng, n.lat, n.lng);
      if (d < bestDist) {
        bestDist = d;
        bestNode = n;
      }
    }
    if (!bestNode && scopeNodeSet) {
      return findNearestNode(index, lat, lng, null);
    }
    return { node: bestNode, distanceM: bestDist };
  }

  function findNearestHydrant(index, lat, lng) {
    if (!index.hydrants || index.hydrants.length === 0) return null;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < index.hydrants.length; i++) {
      const h = index.hydrants[i];
      const d = haversineMeters(lat, lng, h[0], h[1]);
      if (d < bestDist) {
        bestDist = d;
        best = { lat: h[0], lng: h[1], label: h[2] || '소화전', distanceM: Math.round(d) };
      }
    }
    return best;
  }

  const FIRE_STATION = {
    name: '의령소방서(의병로 108-17)',
    lat: 35.319599,
    lng: 128.248343
  };

  const SPEED_PARAMS = {
    WALK_MS: 1.0,
    HOSE_SEC: 20,
    V_TRUNK_KMH: 45,
    V_WIDE_KMH: 20,
    V_MID_KMH: 15,
    V_NARROW_KMH: 10,
    V_UNKNOWN_KMH: 15
  };

  function speedMpsForWidth(w) {
    const val = Number(w) || 0;
    const kmh =
      val >= 6
        ? SPEED_PARAMS.V_WIDE_KMH
        : val >= 4
        ? SPEED_PARAMS.V_MID_KMH
        : val > 0
        ? SPEED_PARAMS.V_NARROW_KMH
        : SPEED_PARAMS.V_UNKNOWN_KMH;
    return kmh / 3.6;
  }

  function reconstructEdgeChain(prevEdgeMap, prevNodeMap, endNodeId) {
    const edges = [];
    const nodeIds = [];
    let cur = endNodeId;
    const guard = new Set();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      nodeIds.push(cur);
      const pe = prevEdgeMap.get(cur);
      if (!pe) break;
      edges.push(pe);
      cur = prevNodeMap.get(cur);
    }
    edges.reverse();
    nodeIds.reverse();
    const coords = [];
    let driveSec = 0.0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      driveSec += (e.lengthM || 0) / speedMpsForWidth(e.mw);
      const ec = e.coords || [];
      for (let j = 0; j < ec.length; j++) {
        if (
          coords.length === 0 ||
          coords[coords.length - 1][0] !== ec[j][0] ||
          coords[coords.length - 1][1] !== ec[j][1]
        ) {
          coords.push(ec[j]);
        }
      }
    }
    return {
      edges: edges,
      nodeIds: nodeIds,
      coords: coords,
      driveSec: Math.round(driveSec)
    };
  }

  function shortestUnconstrainedNodeIds(index, startId, endId) {
    if (!startId || !endId) return null;
    if (startId === endId) return [startId];
    const dist = new Map();
    const prev = new Map();
    const visited = new Set();
    const pq = [[0.0, startId]];
    dist.set(startId, 0.0);

    while (pq.length > 0) {
      pq.sort((a, b) => a[0] - b[0]);
      const [dU, u] = pq.shift();
      if (visited.has(u)) continue;
      visited.add(u);
      if (u === endId) break;
      const outEdges = index.allAdj.get(u) || [];
      for (let i = 0; i < outEdges.length; i++) {
        const edge = outEdges[i];
        const v = edge.toNodeId;
        if (!v || !index.nodeMap.has(v)) continue;
        const nd = dU + edge.lengthM;
        const curV = dist.has(v) ? dist.get(v) : Infinity;
        if (nd < curV) {
          dist.set(v, nd);
          prev.set(v, u);
          pq.push([nd, v]);
        }
      }
    }
    if (!dist.has(endId)) return null;
    const out = [];
    let cur = endId;
    const guard = new Set();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      out.push(cur);
      if (cur === startId) break;
      cur = prev.get(cur);
    }
    return out.reverse();
  }

  function samplePointAlongPolyline(coords, frac) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const segLens = [];
    let total = 0.0;
    for (let i = 0; i < coords.length - 1; i++) {
      const d = haversineMeters(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
      segLens.push(d);
      total += d;
    }
    if (total < 15.0) return null;
    const target = total * Math.max(0.1, Math.min(0.9, frac));
    let acc = 0.0;
    for (let i = 0; i < segLens.length; i++) {
      const seg = segLens[i];
      if (acc + seg >= target || i === segLens.length - 1) {
        const t = seg > 1e-6 ? Math.max(0.0, Math.min(1.0, (target - acc) / seg)) : 0.0;
        const lat = coords[i][0] + t * (coords[i + 1][0] - coords[i][0]);
        const lng = coords[i][1] + t * (coords[i + 1][1] - coords[i][1]);
        return [Number(lat.toFixed(6)), Number(lng.toFixed(6))];
      }
      acc += seg;
    }
    return null;
  }

  /**
   * 자체 방식 B 안전 경로(safeNodeIds)와 일반 최단거리 경로를 비교하여
   * TMAP passList 및 내비게이션 앱(티맵·네이버·카카오)에 전달할 안전 우회/안내 경유점 추출
   */
  function extractNavVia(index, rawSafeNodeIds, vehCoords, startPoint, stagingPoint) {
    const isVirtualStart = Array.isArray(rawSafeNodeIds) && rawSafeNodeIds[0] === USER_START_ID;
    const safeNodeIds = (rawSafeNodeIds || []).filter((id) => index.nodeMap.has(id));
    const last = safeNodeIds.length - 1;
    const viaIndices = [];

    if (safeNodeIds.length >= 3) {
      const safeSet = new Set(safeNodeIds);
      const pos = [0];

      function buildMimic() {
        let out = [safeNodeIds[0]];
        const pts = [...pos, last];
        for (let k = 0; k + 1 < pts.length; k++) {
          const seg = shortestUnconstrainedNodeIds(index, safeNodeIds[pts[k]], safeNodeIds[pts[k + 1]]);
          if (!seg) return null;
          out = out.concat(seg.slice(1));
        }
        return out;
      }

      function deviatesFromSafe(mimicIds) {
        if (!mimicIds) return true;
        for (let i = 0; i < mimicIds.length; i++) {
          if (!safeSet.has(mimicIds[i])) return true;
        }
        return false;
      }

      let mimic = buildMimic();
      let isBad = deviatesFromSafe(mimic);

      while (isBad && pos.length < 4) {
        const onMimic = new Set(mimic || []);
        const mimicNodes = (mimic || []).map((id) => index.nodeMap.get(id)).filter(Boolean);
        let bestJ = -1;
        let bestDist = 5.0;

        for (let j = 1; j < last; j++) {
          const candId = safeNodeIds[j];
          if (onMimic.has(candId) || pos.includes(j)) continue;
          const candNode = index.nodeMap.get(candId);
          if (!candNode) continue;
          let minD = Infinity;
          for (let q = 0; q < mimicNodes.length; q++) {
            const d = haversineMeters(candNode.lat, candNode.lng, mimicNodes[q].lat, mimicNodes[q].lng);
            if (d < minD) minD = d;
          }
          if (minD > bestDist) {
            bestDist = minD;
            bestJ = j;
          }
        }
        if (bestJ < 0) break;
        pos.push(bestJ);
        pos.sort((a, b) => a - b);
        mimic = buildMimic();
        isBad = deviatesFromSafe(mimic);
      }

      pos.forEach((idx) => {
        if (idx > 0 && idx < last) viaIndices.push(idx);
      });
    }

    const refStart =
      Array.isArray(startPoint) && startPoint.length === 2
        ? startPoint
        : safeNodeIds.length > 0 && index.nodeMap.get(safeNodeIds[0])
        ? [index.nodeMap.get(safeNodeIds[0]).lat, index.nodeMap.get(safeNodeIds[0]).lng]
        : null;
    const refEnd =
      Array.isArray(stagingPoint) && stagingPoint.length === 2
        ? stagingPoint
        : safeNodeIds.length > 0 && index.nodeMap.get(safeNodeIds[last])
        ? [index.nodeMap.get(safeNodeIds[last]).lat, index.nodeMap.get(safeNodeIds[last]).lng]
        : null;

    if (isVirtualStart && safeNodeIds.length >= 2 && refStart && refEnd) {
      const n0 = index.nodeMap.get(safeNodeIds[0]);
      if (n0) {
        const dFromStart = haversineMeters(refStart[0], refStart[1], n0.lat, n0.lng);
        const dToEnd = haversineMeters(refEnd[0], refEnd[1], n0.lat, n0.lng);
        if (dFromStart >= 10.0 && dToEnd >= 10.0 && !viaIndices.includes(0)) {
          viaIndices.unshift(0);
        }
      }
    }

    const startCandIdx = isVirtualStart ? 0 : 1;
    if (viaIndices.length === 0 && last > startCandIdx && refStart && refEnd) {
      for (let j = startCandIdx; j < last && viaIndices.length < 3; j++) {
        const nMid = index.nodeMap.get(safeNodeIds[j]);
        if (!nMid) continue;
        const dStart = haversineMeters(refStart[0], refStart[1], nMid.lat, nMid.lng);
        const dEnd = haversineMeters(refEnd[0], refEnd[1], nMid.lat, nMid.lng);
        if (dStart >= 12.0 && dEnd >= 12.0) {
          if (
            viaIndices.length === 0 ||
            haversineMeters(
              index.nodeMap.get(safeNodeIds[viaIndices[viaIndices.length - 1]]).lat,
              index.nodeMap.get(safeNodeIds[viaIndices[viaIndices.length - 1]]).lng,
              nMid.lat,
              nMid.lng
            ) >= 25.0
          ) {
            viaIndices.push(j);
          }
        }
      }
    }

    const viaList = viaIndices.slice(0, 4).map((j) => {
      const n = index.nodeMap.get(safeNodeIds[j]);
      return {
        nodeId: n.id,
        lat: Number(n.lat.toFixed(6)),
        lng: Number(n.lng.toFixed(6))
      };
    });

    if (viaList.length === 0 && Array.isArray(vehCoords) && vehCoords.length >= 2) {
      const polyLen = polylineLengthM(vehCoords);
      if (polyLen >= 25.0) {
        const pt = samplePointAlongPolyline(vehCoords, 0.5);
        if (pt) {
          viaList.push({
            nodeId: '마을내경유1',
            lat: pt[0],
            lng: pt[1]
          });
        }
      }
    }

    return viaList;
  }

  function buildRouteSeq(startPoint, navVia, stagingPoint) {
    const raw = [];
    if (startPoint && startPoint.length === 2) raw.push([Number(startPoint[0].toFixed(6)), Number(startPoint[1].toFixed(6))]);
    (navVia || []).slice(0, 5).forEach((v) => {
      raw.push([Number(v.lat.toFixed(6)), Number(v.lng.toFixed(6))]);
    });
    if (stagingPoint && stagingPoint.length === 2) {
      raw.push([Number(stagingPoint[0].toFixed(6)), Number(stagingPoint[1].toFixed(6))]);
    }
    const dedup = [];
    for (let i = 0; i < raw.length; i++) {
      if (
        dedup.length === 0 ||
        haversineMeters(dedup[dedup.length - 1][0], dedup[dedup.length - 1][1], raw[i][0], raw[i][1]) > 2.0
      ) {
        dedup.push(raw[i]);
      }
    }
    if (dedup.length === 1 && stagingPoint) {
      dedup.push([Number(stagingPoint[0].toFixed(6)), Number(stagingPoint[1].toFixed(6))]);
    }
    return dedup.slice(0, 7);
  }

  function buildRoadPolylineBetweenNodes(index, startNodeId, endNodeId) {
    const nodeIds = shortestUnconstrainedNodeIds(index, startNodeId, endNodeId);
    if (!nodeIds || nodeIds.length < 2) return null;
    const coords = [];
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const u = nodeIds[i];
      const v = nodeIds[i + 1];
      const outEdges = index.allAdj.get(u) || [];
      let bestE = null;
      let bestLen = Infinity;
      for (let j = 0; j < outEdges.length; j++) {
        if (outEdges[j].toNodeId === v && (outEdges[j].lengthM || 0) < bestLen) {
          bestLen = outEdges[j].lengthM || 0;
          bestE = outEdges[j];
        }
      }
      if (bestE && Array.isArray(bestE.coords) && bestE.coords.length > 0) {
        for (let k = 0; k < bestE.coords.length; k++) {
          coords.push(bestE.coords[k]);
        }
      } else {
        const nu = index.nodeMap.get(u);
        const nv = index.nodeMap.get(v);
        if (nu) coords.push([nu.lat, nu.lng]);
        if (nv) coords.push([nv.lat, nv.lng]);
      }
    }
    return dedupCoords(coords);
  }

  function isInsideRect(pt, r, pad) {
    if (!pt || !r || r.length < 4) return false;
    const p = Number(pad) || 0.0;
    return (
      pt[0] >= r[0] - p &&
      pt[1] >= r[1] - p &&
      pt[0] <= r[2] + p &&
      pt[1] <= r[3] + p
    );
  }

  /**
   * Liang-Barsky parametric line-rectangle clipping on segment A -> B against [south, west, north, east]
   */
  function clipSegmentEnterRect(A, B, r, pad) {
    if (!A || !B || !r || r.length < 4) return null;
    const p = Number(pad) || 0.0;
    const minLat = r[0] - p;
    const minLng = r[1] - p;
    const maxLat = r[2] + p;
    const maxLng = r[3] + p;

    const dLat = B[0] - A[0];
    const dLng = B[1] - A[1];

    const pArr = [-dLat, dLat, -dLng, dLng];
    const qArr = [A[0] - minLat, maxLat - A[0], A[1] - minLng, maxLng - A[1]];

    let t0 = 0.0;
    let t1 = 1.0;

    for (let i = 0; i < 4; i++) {
      const pk = pArr[i];
      const qk = qArr[i];
      if (Math.abs(pk) < 1e-12) {
        if (qk < 0.0) return null;
      } else {
        const t = qk / pk;
        if (pk < 0.0) {
          if (t > t1) return null;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return null;
          if (t < t1) t1 = t;
        }
      }
    }

    if (t0 > t1) return null;
    const hitLat = Number((A[0] + t0 * dLat).toFixed(6));
    const hitLng = Number((A[1] + t0 * dLng).toFixed(6));
    return {
      point: [hitLat, hitLng],
      tEnter: t0
    };
  }

  function clipPolylineAtRectEntry(coords, rect, searchRect, targetLat, targetLng) {
    let entryPt = null;
    let clippedTrunk = null;
    let entryMode = 'boundary_intersection';

    if (rect && coords.length >= 2) {
      for (let i = 0; i < coords.length - 1; i++) {
        if (i === 0 && isInsideRect(coords[0], rect, 0)) {
          entryPt = [Number(coords[0][0].toFixed(6)), Number(coords[0][1].toFixed(6))];
          clippedTrunk = [entryPt];
          entryMode = 'already_inside';
          break;
        }
        const hit = clipSegmentEnterRect(coords[i], coords[i + 1], rect, 0);
        if (hit) {
          entryPt = hit.point;
          clippedTrunk = dedupCoords([...coords.slice(0, i + 1), entryPt]);
          entryMode = 'boundary_intersection';
          break;
        }
      }
    }

    const sRect = searchRect || rect;
    if (!entryPt && sRect && coords.length >= 2) {
      for (let i = 0; i < coords.length - 1; i++) {
        const hit = clipSegmentEnterRect(coords[i], coords[i + 1], sRect, 0.0006);
        if (hit) {
          entryPt = hit.point;
          clippedTrunk = dedupCoords([...coords.slice(0, i + 1), entryPt]);
          entryMode = 'search_bounds_intersection';
          break;
        }
      }
    }

    if (!entryPt) {
      let bestIdx = coords.length - 1;
      let bestD = Infinity;
      for (let i = 0; i < coords.length; i++) {
        const d = haversineMeters(targetLat, targetLng, coords[i][0], coords[i][1]);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      entryPt = [Number(coords[bestIdx][0].toFixed(6)), Number(coords[bestIdx][1].toFixed(6))];
      clippedTrunk = dedupCoords(coords.slice(0, bestIdx + 1));
      entryMode = 'closest_vertex';
    }

    if (!clippedTrunk || clippedTrunk.length === 0) {
      clippedTrunk = [entryPt];
    }
    if (clippedTrunk.length === 1 && coords.length >= 2) {
      const firstPt = [Number(coords[0][0].toFixed(6)), Number(coords[0][1].toFixed(6))];
      if (haversineMeters(firstPt[0], firstPt[1], entryPt[0], entryPt[1]) > 1.0) {
        clippedTrunk = [firstPt, entryPt];
      }
    }

    return {
      entryPoint: entryPt,
      clippedTrunk: clippedTrunk,
      entryMode: entryMode
    };
  }

  /**
   * 1단계 외부 도로망(TMAP/OSRM) 또는 그래프 간선 경로가 분석된 마을 경계(docMapBounds)에
   * 진입하는 정확한 시점(boundaryEntryPoint)을 계산하여 2단계 자체 주행성 경로로 핸드오프합니다.
   */
  function computeBoundaryEntryHandoff(index, vObj, externalRouteCoords, targetLat, targetLng, options) {
    const opts = options || {};
    const stationPoint = [FIRE_STATION.lat, FIRE_STATION.lng];
    const bObj = getVillageAnalyzedBounds(index, vObj);
    const rect = bObj ? bObj.displayBounds : null;
    const searchRect = bObj ? bObj.searchBounds : rect;

    // Case A: 1st-stage external route polyline (TMAP/OSRM) is provided
    if (Array.isArray(externalRouteCoords) && externalRouteCoords.length >= 2) {
      const clipped = clipPolylineAtRectEntry(externalRouteCoords, rect, searchRect, targetLat, targetLng);
      const trunkDistanceM = Math.max(10, Math.round(polylineLengthM(clipped.clippedTrunk)));
      const totalExtLen = Math.max(1.0, polylineLengthM(externalRouteCoords));
      const trunkDriveSec =
        Number(opts.externalRouteTimeS) > 0
          ? Math.max(5, Math.round(Number(opts.externalRouteTimeS) * (trunkDistanceM / totalExtLen)))
          : Math.max(5, Math.round(trunkDistanceM / (SPEED_PARAMS.V_TRUNK_KMH / 3.6)));

      return {
        entryPoint: clipped.entryPoint,
        trunkRouteCoords: clipped.clippedTrunk,
        trunkDistanceM: trunkDistanceM,
        trunkDriveSec: trunkDriveSec,
        entryMode: clipped.entryMode,
        isExternalTrunk: true
      };
    }

    // Case B: Offline / standalone fallback (externalRouteCoords not provided)
    const scopeNodeSet = getVillageScopeNodeSet(index, vObj);
    const tgtNearest = findNearestNode(index, targetLat, targetLng, scopeNodeSet);
    const targetNode = tgtNearest ? tgtNearest.node : null;
    const stNearest = findNearestNode(index, FIRE_STATION.lat, FIRE_STATION.lng, null);

    // Subcase B1: FIRE_STATION is inside or close to the current graph index (e.g. eup_uiryeong)
    if (stNearest && stNearest.node && stNearest.distanceM < 1500 && targetNode && rect) {
      const graphRoadPoly = buildRoadPolylineBetweenNodes(index, stNearest.node.id, targetNode.id);
      if (graphRoadPoly && graphRoadPoly.length >= 2) {
        const fullRoadCoords = dedupCoords([stationPoint, ...graphRoadPoly]);
        const clipped = clipPolylineAtRectEntry(fullRoadCoords, rect, searchRect, targetLat, targetLng);
        const trunkDistanceM = Math.max(10, Math.round(polylineLengthM(clipped.clippedTrunk)));
        const trunkDriveSec = Math.max(5, Math.round(trunkDistanceM / (SPEED_PARAMS.V_TRUNK_KMH / 3.6)));
        return {
          entryPoint: clipped.entryPoint,
          trunkRouteCoords: clipped.clippedTrunk,
          trunkDistanceM: trunkDistanceM,
          trunkDriveSec: trunkDriveSec,
          entryMode: 'graph_road_' + clipped.entryMode,
          isExternalTrunk: false
        };
      }
    }

    // Subcase B2: Other Eup/Myeon offline fallback -> trace exterior approach road in index crossing rect toward targetNode
    if (targetNode && rect && index && Array.isArray(index.nodes)) {
      const targetCompId =
        index.nodeToComp && index.nodeToComp.has(targetNode.id) ? index.nodeToComp.get(targetNode.id) : null;
      let bestOuterNode = null;
      let bestOuterScore = Infinity;

      for (let i = 0; i < index.nodes.length; i++) {
        const n = index.nodes[i];
        if (n.type === 'dead_end') continue;
        if (targetCompId !== null && index.nodeToComp.get(n.id) !== targetCompId) continue;
        if (isInsideRect([n.lat, n.lng], rect, -0.0001)) continue;
        const dTarget = haversineMeters(n.lat, n.lng, targetLat, targetLng);
        if (dTarget > 2500) continue;
        const dStation = haversineMeters(FIRE_STATION.lat, FIRE_STATION.lng, n.lat, n.lng);
        const score = dStation + 0.65 * dTarget;
        if (score < bestOuterScore) {
          bestOuterScore = score;
          bestOuterNode = n;
        }
      }

      if (bestOuterNode) {
        const approachPoly = buildRoadPolylineBetweenNodes(index, bestOuterNode.id, targetNode.id);
        if (approachPoly && approachPoly.length >= 2) {
          const clipped = clipPolylineAtRectEntry(approachPoly, rect, searchRect, targetLat, targetLng);
          const directM = haversineMeters(stationPoint[0], stationPoint[1], clipped.entryPoint[0], clipped.entryPoint[1]);
          const trunkDistanceM = Math.max(20, Math.round(directM * 1.32));
          const trunkDriveSec = Math.max(5, Math.round(trunkDistanceM / (SPEED_PARAMS.V_TRUNK_KMH / 3.6)));
          return {
            entryPoint: clipped.entryPoint,
            trunkRouteCoords: dedupCoords([stationPoint, ...clipped.clippedTrunk]),
            trunkDistanceM: trunkDistanceM,
            trunkDriveSec: trunkDriveSec,
            entryMode: 'offline_approach_' + clipped.entryMode,
            isExternalTrunk: false
          };
        }
      }
    }

    // Subcase B3: Boundary node in vObj facing FIRE_STATION
    const candidateNodes = [];
    if (vObj && Array.isArray(vObj.entryNodeIds) && index && index.nodeMap) {
      for (let i = 0; i < vObj.entryNodeIds.length; i++) {
        const n = index.nodeMap.get(vObj.entryNodeIds[i]);
        if (n && n.type !== 'dead_end') candidateNodes.push(n);
      }
    }
    if (candidateNodes.length === 0 && scopeNodeSet && index && index.nodeMap) {
      scopeNodeSet.forEach((nid) => {
        const n = index.nodeMap.get(nid);
        if (n && n.type !== 'dead_end') candidateNodes.push(n);
      });
    }
    let bestBoundaryNode = targetNode;
    let bestDistFromStation = Infinity;
    for (let i = 0; i < candidateNodes.length; i++) {
      const n = candidateNodes[i];
      const d = haversineMeters(FIRE_STATION.lat, FIRE_STATION.lng, n.lat, n.lng);
      if (d < bestDistFromStation) {
        bestDistFromStation = d;
        bestBoundaryNode = n;
      }
    }

    const fallbackPt = bestBoundaryNode
      ? [Number(bestBoundaryNode.lat.toFixed(6)), Number(bestBoundaryNode.lng.toFixed(6))]
      : [Number(Number(targetLat).toFixed(6)), Number(Number(targetLng).toFixed(6))];
    const directStationToEntM = haversineMeters(stationPoint[0], stationPoint[1], fallbackPt[0], fallbackPt[1]);
    const trunkDistanceM = Math.max(20, Math.round(directStationToEntM * 1.32));
    const trunkDriveSec = Math.max(5, Math.round(trunkDistanceM / (SPEED_PARAMS.V_TRUNK_KMH / 3.6)));

    return {
      entryPoint: fallbackPt,
      trunkRouteCoords: [stationPoint, fallbackPt],
      trunkDistanceM: trunkDistanceM,
      trunkDriveSec: trunkDriveSec,
      entryMode: 'offline_boundary_node',
      isExternalTrunk: false
    };
  }

  function attachTimingAndNavFields(index, baseRoute, vehChain) {
    const vehCoords =
      Array.isArray(baseRoute.vehicleRouteCoords) && baseRoute.vehicleRouteCoords.length >= 2
        ? baseRoute.vehicleRouteCoords
        : vehChain
        ? vehChain.coords
        : [];
    const entryRef = baseRoute.boundaryEntryPoint || baseRoute.villageEntrance || null;
    const entrancePt = entryRef
      ? [entryRef.lat, entryRef.lng]
      : baseRoute.startPoint;

    const internalVia = extractNavVia(
      index,
      vehChain ? vehChain.nodeIds : [],
      vehCoords,
      entrancePt,
      baseRoute.stagingPoint
    );

    // 마을 범위 진입점을 1번 안내 지점(navVia[0])으로 설정합니다. (기존 마을 입구 강제 경유 폐지)
    const navVia = [];
    if (entryRef) {
      navVia.push({
        nodeId: `${baseRoute.villageName || ''}마을범위진입점`,
        label: `${baseRoute.villageName || ''}마을 범위 진입점`,
        lat: Number(entryRef.lat.toFixed(6)),
        lng: Number(entryRef.lng.toFixed(6)),
        isBoundaryEntry: true,
        isMandatoryEntrance: false
      });
    }
    for (let i = 0; i < internalVia.length && navVia.length < 5; i++) {
      const iv = internalVia[i];
      if (
        navVia.length === 0 ||
        haversineMeters(navVia[navVia.length - 1].lat, navVia[navVia.length - 1].lng, iv.lat, iv.lng) >= 8.0
      ) {
        navVia.push(iv);
      }
    }

    const routeSeq = buildRouteSeq(baseRoute.startPoint, navVia, baseRoute.stagingPoint);
    const localDriveSec = vehChain ? vehChain.driveSec : Math.round((baseRoute.villageVehicleDistanceM || 0) / (15 / 3.6));
    const trunkDriveSec = Number(baseRoute.trunkDriveSec) || 0;
    const villageDriveSec = trunkDriveSec + localDriveSec;
    const hoseDist = baseRoute.hoseDistanceM || 0;
    const hoseCount = hoseDist > 3 ? Math.ceil(hoseDist / 15.0) : 0;
    const hoseWithSpare = hoseCount + 1;
    const walkSec = Math.round(hoseDist / SPEED_PARAMS.WALK_MS);
    const hoseDeploySec = hoseCount * SPEED_PARAMS.HOSE_SEC;
    const totalMissionSec = villageDriveSec + walkSec + hoseDeploySec;

    return Object.assign(baseRoute, {
      navVia: navVia,
      routeSeq: routeSeq,
      localDriveSec: localDriveSec,
      trunkDriveSec: trunkDriveSec,
      villageDriveSec: villageDriveSec,
      walkSec: walkSec,
      hoseDeploySec: hoseDeploySec,
      totalMissionSec: totalMissionSec,
      requiredHose15mCount: Math.max(1, hoseCount),
      requiredHoseWithSpareCount: hoseWithSpare,
      hoseFormula: `보행 ${Math.round(hoseDist)}m ÷ 15m = ${Math.max(1, hoseCount)}본 (예비 +1포함 ${hoseWithSpare}매)`
    });
  }

  /**
   * 의령소방서 고정 출발 + 마을 범위 진입 시점(boundaryEntryPoint) 자동 핸드오프 +
   * 분석된 마을 범위 내 2단계(1차 차량 + 2차 호스) 하이브리드 임무 경로 산출
   */
  function findMissionRoute(index, targetLat, targetLng, options) {
    const opts = options || {};
    const thr = Number(opts.threshold) || 2.5;
    const mode = opts.mode || 'vworld_api';
    const spec = getVehicleSpec(thr);

    let vObj = null;
    if (opts.villageId && index.villageMap && index.villageMap.has(opts.villageId)) {
      const prefV = index.villageMap.get(opts.villageId);
      if (isPointInVillageScope(index, prefV, targetLat, targetLng, 0.0012)) {
        vObj = prefV;
      }
    }
    if (!vObj) {
      vObj = findAnalyzedVillageForPoint(index, targetLat, targetLng, opts.villageId || null);
    }
    if (!vObj && opts.strictVillageScope === false && opts.villageId && index.villageMap.has(opts.villageId)) {
      vObj = index.villageMap.get(opts.villageId);
    }

    if (!vObj) {
      return {
        found: false,
        outOfVillageScope: true,
        message: '선택하신 위치는 분석된 마을 영역 밖입니다. 분석된 마을 범위 내 주소를 검색하거나 선택해 주세요.'
      };
    }

    const strictScope = opts.strictVillageScope !== false;
    if (strictScope && !isPointInVillageScope(index, vObj, targetLat, targetLng, 0.0012)) {
      const bObj = getVillageAnalyzedBounds(index, vObj);
      return {
        found: false,
        outOfVillageScope: true,
        villageId: vObj.id,
        villageName: vObj.name,
        villageBounds: bObj ? bObj.displayBounds : null,
        message: `선택하신 위치는 현재 분석된 마을(${index.name || ''} ${vObj.name}마을) 영역 밖입니다. 현재 분석된 마을 범위 내에서만 경로를 탐색합니다.`
      };
    }

    const scopeNodeSet = getVillageScopeNodeSet(index, vObj);
    const nearest = findNearestNode(index, targetLat, targetLng, scopeNodeSet);
    if (!nearest.node) {
      return { found: false };
    }

    const targetNode = nearest.node;
    const offRoadDistM = Math.round(nearest.distanceM);
    const targetCompId =
      index.nodeToComp && index.nodeToComp.has(targetNode.id) ? index.nodeToComp.get(targetNode.id) : null;

    // 1단계 외부 도로망 → 마을 분석 범위(docMapBounds) 진입 시점 핸드오프 산출
    const handoff = computeBoundaryEntryHandoff(
      index,
      vObj,
      opts.externalRouteCoords || null,
      targetLat,
      targetLng,
      opts
    );

    // 마을 범위 진입점(handoff.entryPoint)을 진입 지점 인근(<= 35m) 마을 도로에 스냅 (마을 건너편 점프 방지)
    const entProj = projectPointToRoad(
      index,
      handoff.entryPoint[0],
      handoff.entryPoint[1],
      thr,
      mode,
      scopeNodeSet,
      targetCompId,
      {
        boundarySnap: true,
        maxCompPassSnapM: 35.0,
        maxPassSnapM: 35.0,
        maxCompSnapM: 45.0,
        startAtProjPoint: true,
        disableBridgeEdge: true
      }
    );

    const entProjPt = entProj ? entProj.projPoint : handoff.entryPoint;
    const stationPoint = [FIRE_STATION.lat, FIRE_STATION.lng];
    const trunkRouteCoords = Array.isArray(handoff.trunkRouteCoords) && handoff.trunkRouteCoords.length > 0
      ? handoff.trunkRouteCoords.slice()
      : [stationPoint, entProjPt];
    const lastTrunkPt = trunkRouteCoords[trunkRouteCoords.length - 1];
    if (!lastTrunkPt || haversineMeters(lastTrunkPt[0], lastTrunkPt[1], entProjPt[0], entProjPt[1]) > 1.0) {
      trunkRouteCoords.push(entProjPt);
    }
    const trunkDistanceM = handoff.trunkDistanceM;
    const trunkDriveSec = handoff.trunkDriveSec;
    const bObj = getVillageAnalyzedBounds(index, vObj);

    const boundaryEntryObj = {
      name: `${vObj.name}마을 범위 진입점`,
      lat: Number(entProjPt[0].toFixed(6)),
      lng: Number(entProjPt[1].toFixed(6)),
      badgeLat: Number(entProjPt[0].toFixed(6)),
      badgeLng: Number(entProjPt[1].toFixed(6)),
      projPoint: entProjPt,
      rawEntryPoint: handoff.entryPoint,
      entryMode: handoff.entryMode
    };

    // 2단계: 마을 범위 진입점(USER_START_ID = entProj)에서 로컬 주행성 다익스트라 수행
    const vehDijk = runVehicleDijkstra(index, [USER_START_ID], thr, mode, entProj, scopeNodeSet);

    function ensureEntrancePrefix(coords) {
      const out = Array.isArray(coords) ? coords.slice() : [];
      if (out.length === 0) {
        return [entProjPt];
      }
      const d0 = haversineMeters(entProjPt[0], entProjPt[1], out[0][0], out[0][1]);
      if (d0 > 1.5) {
        out.unshift(entProjPt);
      }
      return dedupCoords(out);
    }

    // Case 1: Target node is directly reachable by the fire vehicle from boundary entry point
    if (vehDijk.dist.has(targetNode.id)) {
      const localVehDist = Number(vehDijk.dist.get(targetNode.id).toFixed(1));
      const chain = reconstructEdgeChain(vehDijk.prevEdgeMap, vehDijk.prevNodeMap, targetNode.id);
      const hydrant = findNearestHydrant(index, targetNode.lat, targetNode.lng);
      const hoseDist = offRoadDistM;
      const localCoords = ensureEntrancePrefix(
        chain.coords.length > 0 ? chain.coords : [entProjPt, [targetNode.lat, targetNode.lng]]
      );

      return attachTimingAndNavFields(
        index,
        {
          found: true,
          directVehicleAccess: true,
          isCustomStart: true,
          isExactStart: true,
          startNodeId: '의령소방서',
          startPoint: stationPoint,
          villageId: vObj.id,
          villageName: vObj.name,
          villageBounds: bObj ? bObj.displayBounds : null,
          boundaryEntryPoint: boundaryEntryObj,
          villageEntrance: boundaryEntryObj,
          trunkDistanceM: trunkDistanceM,
          trunkDriveSec: trunkDriveSec,
          trunkRouteCoords: trunkRouteCoords,
          villageVehicleDistanceM: localVehDist,
          vehicleSpec: spec,
          targetLat: targetLat,
          targetLng: targetLng,
          targetNodeId: targetNode.id,
          stagingNodeId: targetNode.id,
          stagingPoint: [targetNode.lat, targetNode.lng],
          vehicleDistanceM: Number((trunkDistanceM + localVehDist).toFixed(1)),
          vehicleRouteCoords: localCoords,
          hoseDistanceM: hoseDist,
          requiredHose15mCount: Math.max(1, Math.ceil(hoseDist / 15.0)),
          hoseRouteCoords: hoseDist > 3 ? [[targetNode.lat, targetNode.lng], [targetLat, targetLng]] : [],
          bottleneck: null,
          nearestHydrant: hydrant
        },
        chain
      );
    }

    // Case 2: Vehicle cannot reach targetNode -> Run 2nd-stage hose/foot Dijkstra from reachable vehicle nodes (including USER_START_ID)
    function runHoseSearch(restrictSet) {
      const hoseDistMap = new Map();
      const hosePrevEdge = new Map();
      const hosePrevNode = new Map();
      const hoseOriginStaging = new Map();
      const visited = new Set();
      const pq = [];

      vehDijk.dist.forEach((vDist, uId) => {
        const score = vDist * 0.05;
        hoseDistMap.set(uId, 0.0);
        hoseOriginStaging.set(uId, uId);
        pq.push([score, 0.0, uId]);
      });

      pq.sort((a, b) => a[0] - b[0]);

      while (pq.length > 0) {
        const [scoreU, hDistU, u] = pq.shift();
        if (visited.has(u)) continue;
        visited.add(u);
        if (u === targetNode.id) break;

        const outEdges = u === USER_START_ID && entProj ? entProj.virtualEdges : index.allAdj.get(u) || [];
        for (let i = 0; i < outEdges.length; i++) {
          const edge = outEdges[i];
          const v = edge.toNodeId;
          if (!v || !index.nodeMap.has(v)) continue;
          if (restrictSet && !restrictSet.has(v)) continue;
          const newHoseDist = hDistU + edge.lengthM;
          const curHoseDist = hoseDistMap.has(v) ? hoseDistMap.get(v) : Infinity;
          if (newHoseDist < curHoseDist) {
            hoseDistMap.set(v, newHoseDist);
            hosePrevEdge.set(v, edge);
            hosePrevNode.set(v, u);
            const stg = hoseOriginStaging.get(u);
            hoseOriginStaging.set(v, stg);
            const vDist = vehDijk.dist.get(stg) || 0.0;
            pq.push([newHoseDist + vDist * 0.05, newHoseDist, v]);
            pq.sort((a, b) => a[0] - b[0]);
          }
        }
      }

      return {
        hoseDistMap: hoseDistMap,
        hosePrevEdge: hosePrevEdge,
        hosePrevNode: hosePrevNode,
        hoseOriginStaging: hoseOriginStaging
      };
    }

    let hoseRes = runHoseSearch(scopeNodeSet);
    if (!hoseRes.hoseOriginStaging.has(targetNode.id) && scopeNodeSet) {
      hoseRes = runHoseSearch(null);
    }

    const hoseDistMap = hoseRes.hoseDistMap;
    const hosePrevEdge = hoseRes.hosePrevEdge;
    const hosePrevNode = hoseRes.hosePrevNode;
    const hoseOriginStaging = hoseRes.hoseOriginStaging;

    const stagingId = hoseOriginStaging.get(targetNode.id);
    if (!stagingId) {
      // Fallback within analyzed village: pick closest vehicle-reachable node to target
      let bestStg = null;
      let bestStgRawId = USER_START_ID;
      let bestD = Infinity;
      vehDijk.dist.forEach((_, uId) => {
        const nObj =
          uId === USER_START_ID
            ? { id: `${vObj.name}마을 범위 진입점`, lat: entProjPt[0], lng: entProjPt[1] }
            : index.nodeMap.get(uId);
        if (!nObj) return;
        const d = haversineMeters(targetLat, targetLng, nObj.lat, nObj.lng);
        if (d < bestD) {
          bestD = d;
          bestStg = nObj;
          bestStgRawId = uId;
        }
      });
      if (!bestStg) {
        bestStg = { id: `${vObj.name}마을 범위 진입점`, lat: entProjPt[0], lng: entProjPt[1] };
        bestStgRawId = USER_START_ID;
        bestD = haversineMeters(targetLat, targetLng, entProjPt[0], entProjPt[1]);
      }
      const vehChain = reconstructEdgeChain(vehDijk.prevEdgeMap, vehDijk.prevNodeMap, bestStgRawId);
      const localVehDist = Number((vehDijk.dist.get(bestStgRawId) || 0).toFixed(1));
      const totalHose = Math.round(bestD);
      const localCoords =
        bestStgRawId === USER_START_ID || localVehDist <= 0.1
          ? [entProjPt]
          : ensureEntrancePrefix(vehChain.coords.length > 0 ? vehChain.coords : [entProjPt, [bestStg.lat, bestStg.lng]]);

      return attachTimingAndNavFields(
        index,
        {
          found: true,
          directVehicleAccess: false,
          isCustomStart: true,
          isExactStart: true,
          startNodeId: '의령소방서',
          startPoint: stationPoint,
          villageId: vObj.id,
          villageName: vObj.name,
          villageBounds: bObj ? bObj.displayBounds : null,
          boundaryEntryPoint: boundaryEntryObj,
          villageEntrance: boundaryEntryObj,
          trunkDistanceM: trunkDistanceM,
          trunkDriveSec: trunkDriveSec,
          trunkRouteCoords: trunkRouteCoords,
          villageVehicleDistanceM: localVehDist,
          vehicleSpec: spec,
          targetLat: targetLat,
          targetLng: targetLng,
          targetNodeId: targetNode.id,
          stagingNodeId: bestStg.id,
          stagingPoint: [bestStg.lat, bestStg.lng],
          vehicleDistanceM: Number((trunkDistanceM + localVehDist).toFixed(1)),
          vehicleRouteCoords: localCoords,
          hoseDistanceM: totalHose,
          requiredHose15mCount: Math.max(1, Math.ceil(totalHose / 15.0)),
          hoseRouteCoords: [[bestStg.lat, bestStg.lng], [targetLat, targetLng]],
          bottleneck: { reason: 'width_narrow', message: '마을 내 협소 골목 폭원 미달 구간' },
          nearestHydrant: findNearestHydrant(index, bestStg.lat, bestStg.lng)
        },
        vehChain
      );
    }

    const stagingNode =
      stagingId === USER_START_ID
        ? { id: `${vObj.name}마을 범위 진입점`, lat: entProjPt[0], lng: entProjPt[1] }
        : index.nodeMap.get(stagingId);
    const vehChain = reconstructEdgeChain(vehDijk.prevEdgeMap, vehDijk.prevNodeMap, stagingId);
    const hoseChain = reconstructEdgeChain(hosePrevEdge, hosePrevNode, targetNode.id);
    if (offRoadDistM > 3) {
      hoseChain.coords.push([targetLat, targetLng]);
    }

    const firstHoseEdge = hoseChain.edges.length > 0 ? hoseChain.edges[0] : (entProj ? entProj.edge : null);
    const prevVehEdge = vehDijk.prevEdgeMap.get(stagingId) || null;
    let bottleneck = { reason: 'width_narrow', message: '협소 골목 폭원 미달' };
    if (firstHoseEdge) {
      const ev = evaluateEdgeTransition(index, firstHoseEdge, prevVehEdge, thr, mode);
      if (ev.reason === 'turn_radius') {
        bottleneck = {
          reason: 'turn_radius',
          turnAngleDeg: ev.turnAngleDeg,
          cornerWidthM: ev.cornerWidthM,
          requiredCornerWidthM: ev.requiredCornerWidthM,
          message: `교차로 ${ev.turnAngleDeg}° 회전반경 부족 (코너 유효폭 ${ev.cornerWidthM}m < 요구 ${ev.requiredCornerWidthM}m)`
        };
      } else {
        const fw = getEdgeWidth(firstHoseEdge, mode);
        bottleneck = {
          reason: ev.reason,
          widthM: fw,
          requiredWidthM: thr,
          message: fw !== null ? `도로 폭원 부족 (유효폭 ${fw}m < 차량 기준 ${thr}m)` : '도로 폭원 미상 구간'
        };
      }
    }

    const totalHoseM = Number(((hoseDistMap.get(targetNode.id) || 0) + offRoadDistM).toFixed(1));
    const localVehDistM = stagingId === USER_START_ID ? 0 : Number((vehDijk.dist.get(stagingId) || 0).toFixed(1));
    const localCoords =
      stagingId === USER_START_ID || localVehDistM <= 0.1
        ? [entProjPt]
        : ensureEntrancePrefix(
            vehChain.coords.length > 0 ? vehChain.coords : [entProjPt, [stagingNode.lat, stagingNode.lng]]
          );

    return attachTimingAndNavFields(
      index,
      {
        found: true,
        directVehicleAccess: false,
        isCustomStart: true,
        isExactStart: true,
        startNodeId: '의령소방서',
        startPoint: stationPoint,
        villageId: vObj.id,
        villageName: vObj.name,
        villageBounds: bObj ? bObj.displayBounds : null,
        boundaryEntryPoint: boundaryEntryObj,
        villageEntrance: boundaryEntryObj,
        trunkDistanceM: trunkDistanceM,
        trunkDriveSec: trunkDriveSec,
        trunkRouteCoords: trunkRouteCoords,
        villageVehicleDistanceM: localVehDistM,
        vehicleSpec: spec,
        targetLat: targetLat,
        targetLng: targetLng,
        targetNodeId: targetNode.id,
        stagingNodeId: stagingNode.id,
        stagingPoint: [stagingNode.lat, stagingNode.lng],
        vehicleDistanceM: Number((trunkDistanceM + localVehDistM).toFixed(1)),
        vehicleRouteCoords: localCoords,
        hoseDistanceM: totalHoseM,
        requiredHose15mCount: Math.max(1, Math.ceil(totalHoseM / 15.0)),
        hoseRouteCoords: hoseChain.coords,
        bottleneck: bottleneck,
        nearestHydrant: findNearestHydrant(index, stagingNode.lat, stagingNode.lng)
      },
      vehChain
    );
  }

  return {
    VEHICLE_SPECS: VEHICLE_SPECS,
    FIRE_STATION: FIRE_STATION,
    SPEED_PARAMS: SPEED_PARAMS,
    getVehicleSpec: getVehicleSpec,
    getEdgeWidth: getEdgeWidth,
    getEntryWidth: getEntryWidth,
    getExitWidth: getExitWidth,
    buildGraphIndex: buildGraphIndex,
    getVillageAnalyzedBounds: getVillageAnalyzedBounds,
    isPointInVillageScope: isPointInVillageScope,
    getVillageEntrancePoint: getVillageEntrancePoint,
    findAnalyzedVillageForPoint: findAnalyzedVillageForPoint,
    computeBoundaryEntryHandoff: computeBoundaryEntryHandoff,
    evaluateEdgeTransition: evaluateEdgeTransition,
    evaluateNetwork: evaluateNetwork,
    findNearestNode: findNearestNode,
    projectPointToRoad: projectPointToRoad,
    extractNavVia: extractNavVia,
    buildRouteSeq: buildRouteSeq,
    findMissionRoute: findMissionRoute
  };
});
