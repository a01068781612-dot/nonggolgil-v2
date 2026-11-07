/**
 * Cloudflare Pages Functions: GET /api/building?lat=...&lng=...
 * 하드코딩 기본값 없이 VWorld(LT_C_SPBD 도로명주소 건물 + LT_C_BLDGINFO GIS건물통합정보 표제부 + 역지오코딩)
 * 및 공공데이터포털 건축물대장 표제부(BldRgstHubService/getBrTitleInfo)를 실시간 조회합니다.
 */

const PURPOSE_CODE_MAP = {
  '01000': '단독주택',
  '01001': '단독주택',
  '01002': '다중주택',
  '01003': '다가구주택',
  '01004': '공관',
  '02000': '공동주택',
  '02001': '아파트',
  '02002': '연립주택',
  '02003': '다세대주택',
  '02004': '기숙사',
  '03000': '제1종근린생활시설',
  '04000': '제2종근린생활시설',
  '05000': '문화및집회시설',
  '06000': '종교시설',
  '07000': '판매시설',
  '08000': '운수시설',
  '09000': '의료시설',
  '10000': '교육연구시설',
  '11000': '노유자시설',
  '12000': '수련시설',
  '13000': '운동시설',
  '14000': '업무시설',
  '15000': '숙박시설',
  '16000': '위락시설',
  '17000': '공장',
  '18000': '창고시설',
  '19000': '위험물저장및처리시설',
  '20000': '자동차관련시설',
  '21000': '동물및식물관련시설',
  '22000': '자원순환관련시설',
  '23000': '교정및군사시설',
  '24000': '방송통신시설',
  '25000': '발전시설',
  '26000': '묘지관련시설',
  '27000': '관광휴게시설',
  '28000': '가설건축물',
  '29000': '장례시설',
  '30000': '야영장시설'
};

const STRCT_CODE_MAP = {
  '11': '벽돌구조',
  '12': '블록구조',
  '13': '석구조',
  '14': '스틸하우스조',
  '19': '기타조적구조',
  '21': '철근콘크리트구조',
  '22': '프리스트레스트콘크리트구조',
  '23': '강구조',
  '24': '복합구조',
  '29': '기타콘크리트구조',
  '31': '일반철골구조',
  '32': '경량철골구조',
  '33': '강관구조',
  '34': '트러스구조',
  '39': '기타강구조',
  '41': '철골철근콘크리트구조',
  '42': '철골콘크리트구조',
  '49': '기타철골철근콘크리트구조',
  '51': '일반목구조',
  '52': '통나무구조',
  '53': '한옥목구조',
  '59': '기타목구조',
  '61': '시멘트블록조',
  '62': '토담조',
  '63': '컨테이너조',
  '64': '철파이프조',
  '65': '슬레이트조',
  '99': '기타구조'
};

function decodePurposeCode(code) {
  const c = String(code || '').trim();
  if (!c) return '';
  if (PURPOSE_CODE_MAP[c]) return PURPOSE_CODE_MAP[c];
  const prefix = c.slice(0, 2) + '000';
  return PURPOSE_CODE_MAP[prefix] || `용도코드(${c})`;
}

function decodeStrctCode(code) {
  const c = String(code || '').trim();
  if (!c) return '';
  return STRCT_CODE_MAP[c] || `구조코드(${c})`;
}

function ringOfFeature(feat) {
  const g = feat && feat.geometry;
  if (!g || !g.coordinates || !g.coordinates.length) return [];
  return g.type === 'MultiPolygon' ? g.coordinates[0][0] : g.coordinates[0];
}

function pointInRing(ring, lat, lng) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const x1 = ring[i][0];
    const y1 = ring[i][1];
    const x2 = ring[j][0];
    const y2 = ring[j][1];
    if (y1 > lat !== y2 > lat && lng < ((x2 - x1) * (lat - y1)) / (y2 - y1 + 1e-15) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

function distToFeatureM(feat, lat, lng) {
  const ring = ringOfFeature(feat);
  if (!ring || !ring.length) return 1e9;
  if (pointInRing(ring, lat, lng)) return 0;
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  let best = 1e9;
  for (let i = 0; i < ring.length; i++) {
    const x1 = ring[i][0];
    const y1 = ring[i][1];
    const x2 = ring[(i + 1) % ring.length][0];
    const y2 = ring[(i + 1) % ring.length][1];
    const ax = (x1 - lng) * kx;
    const ay = (y1 - lat) * 110540;
    const bx = (x2 - lng) * kx;
    const by = (y2 - lat) * 110540;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy + 1e-12)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function formatUseAprDay(val) {
  const s = String(val || '').trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

function positiveNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function buildTacticalNotes(mainUse, structure, roof, grndFlr, useAprDay) {
  const notes = [];
  const st = `${structure || ''} ${roof || ''}`;
  if (/목/.test(st)) {
    notes.push('목구조 — 연소 확대가 빠름, 초기 대량 방수 및 인접 건물 방어 필요');
  }
  if (/샌드위치|패널/.test(st)) {
    notes.push('샌드위치패널 — 급격한 연소·붕괴 위험, 내부 진입 신중');
  }
  if (/철골|강구조|파이프/.test(st)) {
    notes.push('철골/강구조 — 장시간 가열 시 강도 저하·붕괴 위험');
  }
  if (/슬레이트|기와/.test(st)) {
    notes.push(`${/슬레이트/.test(st) ? '슬레이트' : '기와'} 지붕 — 낙하물 주의`);
  }
  if (grndFlr && grndFlr >= 3) {
    notes.push(`지상 ${grndFlr}층 건축물 — 상층부 연소 확대 대비 및 고소 방수 검토`);
  }
  const yr = parseInt(String(useAprDay || '').slice(0, 4), 10);
  if (yr > 1900 && yr <= 1996) {
    notes.push(`사용승인 ${yr}년 — 30년 이상 노후 건축물, 구조체 약화 주의`);
  }
  if (/노유자/.test(mainUse || '')) {
    notes.push('노유자시설 — 거동불편자 최우선 인명 검색 및 대피 유도');
  } else if (/동물|식물|창고/.test(mainUse || '')) {
    notes.push('축사·창고시설 — 내부 가연물 및 지붕 붕괴 주의');
  }
  return notes;
}

async function fetchDataGoKrBrTitle(bldApiKey, bdMgtSn) {
  if (!bldApiKey || !bdMgtSn || String(bdMgtSn).length < 19) return [];
  const pnu = String(bdMgtSn).slice(0, 19);
  if (!/^\d{19}$/.test(pnu)) return [];
  const q = new URLSearchParams({
    serviceKey: bldApiKey,
    sigunguCd: pnu.slice(0, 5),
    bjdongCd: pnu.slice(5, 10),
    platGbCd: pnu[10] === '2' ? '1' : '0',
    bun: pnu.slice(11, 15),
    ji: pnu.slice(15, 19),
    numOfRows: '10',
    pageNo: '1',
    _type: 'json'
  });
  try {
    const r = await fetch(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?${q}`);
    if (!r.ok) return [];
    const j = await r.json();
    const items = j.response?.body?.items;
    let it = items && typeof items === 'object' ? items.item : [];
    it = Array.isArray(it) ? it : it ? [it] : [];
    return it.map((x) => ({
      mainUse: x.mainPurpsCdNm || '',
      etcUse: x.etcPurps || '',
      structure: x.strctCdNm || '',
      roof: x.roofCdNm || x.etcRoof || '',
      groundFloors: x.grndFlrCnt,
      undergroundFloors: x.ugrndFlrCnt,
      totalAreaM2: x.totArea,
      archAreaM2: x.archArea,
      platAreaM2: x.platArea,
      useAprDay: formatUseAprDay(x.useAprDay || ''),
      buildingName: x.bldNm || '',
      dongName: x.dongNm || ''
    }));
  } catch (_) {
    return [];
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lng = parseFloat(url.searchParams.get('lng'));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return new Response(JSON.stringify({ error: 'Invalid lat/lng parameters' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  const vworldKey = (context.env && (context.env.VWORLD_API_KEY || context.env.VWORLD_KEY)) || '';
  const bldApiKey = (context.env && context.env.BLD_API_KEY) || '';
  const vworldDomain = (context.env && context.env.VWORLD_DOMAIN) || 'localhost';

  let roadAddress = '';
  let parcelAddress = '';
  let buildingName = '';
  let dongName = '';
  let bdMgtSn = '';
  let pnu = '';
  let distM = null;
  let foundBuilding = false;

  // 1. VWorld Reverse Geocoding
  try {
    const geoUrl =
      `https://api.vworld.kr/req/address?service=address&request=getAddress&version=2.0` +
      `&crs=epsg:4326&point=${lng},${lat}&format=json&type=both&zipcode=true&simple=false&key=${vworldKey}`;
    const resp = await fetch(geoUrl);
    const data = await resp.json();
    const results = (data.response && data.response.result) || [];
    for (const item of results) {
      if (item.type === 'road') {
        roadAddress = item.text || '';
        if (item.structure && item.structure.detail) {
          buildingName = item.structure.detail;
        }
      } else if (item.type === 'parcel') {
        parcelAddress = item.text || '';
      }
    }
  } catch (_) {}

  const d = 0.0007;
  const boxFilter = `BOX(${(lng - d).toFixed(6)},${(lat - d).toFixed(6)},${(lng + d).toFixed(6)},${(lat + d).toFixed(6)})`;
  let spbdProps = {};
  let bldginfoProps = {};

  // 2. VWorld LT_C_SPBD
  try {
    const spbdUrl =
      `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_SPBD` +
      `&key=${vworldKey}&domain=${vworldDomain}&geomFilter=${encodeURIComponent(boxFilter)}` +
      `&size=100&format=json&crs=EPSG:4326&geometry=true&attribute=true`;
    const rSpbd = await (await fetch(spbdUrl)).json();
    if (rSpbd.response && rSpbd.response.status === 'OK') {
      const feats = rSpbd.response.result?.featureCollection?.features || [];
      const scored = feats.map((f) => ({ d: distToFeatureM(f, lat, lng), f })).sort((a, b) => a.d - b.d);
      if (scored.length > 0 && scored[0].d <= 60) {
        distM = Math.round(scored[0].d * 10) / 10;
        spbdProps = scored[0].f.properties || {};
        foundBuilding = true;
        bdMgtSn = String(spbdProps.bd_mgt_sn || '').trim();
        if (bdMgtSn.length >= 19) pnu = bdMgtSn.slice(0, 19);
        if (!roadAddress) {
          roadAddress = [spbdProps.sido, spbdProps.sigungu, spbdProps.gu, spbdProps.rd_nm, spbdProps.buld_no]
            .filter(Boolean)
            .join(' ');
        }
        if (spbdProps.buld_nm) buildingName = spbdProps.buld_nm;
      }
    }
  } catch (_) {}

  // 3. VWorld LT_C_BLDGINFO (GIS건물통합정보 = 국토부 건축물대장 표제부 공간연계)
  try {
    const infoUrl =
      `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_C_BLDGINFO` +
      `&key=${vworldKey}&domain=${vworldDomain}&geomFilter=${encodeURIComponent(boxFilter)}` +
      `&size=100&format=json&crs=EPSG:4326&geometry=true&attribute=true`;
    const rInfo = await (await fetch(infoUrl)).json();
    if (rInfo.response && rInfo.response.status === 'OK') {
      const feats = rInfo.response.result?.featureCollection?.features || [];
      const near = feats
        .map((f) => ({ d: distToFeatureM(f, lat, lng), f }))
        .filter((x) => x.d <= 60)
        .sort((a, b) => a.d - b.d);
      if (near.length > 0) {
        foundBuilding = true;
        if (distM === null || near[0].d < distM) {
          distM = Math.round(near[0].d * 10) / 10;
        }
        const registered = near.filter((x) => {
          const p = x.f.properties || {};
          return x.d <= Math.max(15, near[0].d + 10) && (p.usability || p.strct_cd || parseFloat(p.totalarea || 0) > 0);
        });
        const chosen = registered.length > 0 ? registered[0].f : near[0].f;
        bldginfoProps = chosen.properties || {};
      }
    }
  } catch (_) {}

  // 4. 공공데이터포털 BldRgstHubService/getBrTitleInfo
  const hubRecords = await fetchDataGoKrBrTitle(bldApiKey, bdMgtSn);
  const hubPrimary = hubRecords[0] || {};

  const mainUse = hubPrimary.mainUse || decodePurposeCode(bldginfoProps.usability) || null;
  const etcUse = hubPrimary.etcUse || null;
  const structure = hubPrimary.structure || decodeStrctCode(bldginfoProps.strct_cd) || null;
  const roof = hubPrimary.roof || null;

  const rawGrnd = hubPrimary.groundFloors || bldginfoProps.grnd_flr || spbdProps.gro_flo_co;
  const rawUgrnd = hubPrimary.undergroundFloors || bldginfoProps.ugrnd_flr;
  const grndFlr = /^\d+$/.test(String(rawGrnd || '')) && parseInt(rawGrnd, 10) > 0 ? parseInt(rawGrnd, 10) : null;
  const ugrndFlr = /^\d+$/.test(String(rawUgrnd || '')) && parseInt(rawUgrnd, 10) > 0 ? parseInt(rawUgrnd, 10) : 0;

  let floorsStr = null;
  if (grndFlr !== null) {
    floorsStr = `지상 ${grndFlr}층` + (ugrndFlr > 0 ? ` / 지하 ${ugrndFlr}층` : '');
  }

  const totalAreaM2 = positiveNum(hubPrimary.totalAreaM2 || bldginfoProps.totalarea);
  const archAreaM2 = positiveNum(hubPrimary.archAreaM2 || bldginfoProps.archarea);
  const platAreaM2 = positiveNum(hubPrimary.platAreaM2 || bldginfoProps.platarea);
  const heightM = positiveNum(bldginfoProps.height);
  const bcRat = positiveNum(bldginfoProps.bc_rat);
  const vlRat = positiveNum(bldginfoProps.vl_rat);
  const useAprDay = hubPrimary.useAprDay || formatUseAprDay(bldginfoProps.useapr_day) || null;

  if (!buildingName) {
    buildingName = hubPrimary.buildingName || bldginfoProps.bld_nm || spbdProps.buld_nm || null;
  }
  dongName = hubPrimary.dongName || bldginfoProps.dong_nm || null;

  const hasLedgerRecord = Boolean(mainUse || structure || totalAreaM2 || archAreaM2 || useAprDay);
  let ledgerStatus = '';
  let sourceLabel = '';
  if (!foundBuilding) {
    ledgerStatus = '반경 60m 내 등록 건축물 없음';
    sourceLabel = 'VWorld 주소조회';
  } else if (hasLedgerRecord) {
    ledgerStatus = '건축물대장 표제부 등재 확인';
    sourceLabel = hubPrimary.mainUse
      ? '건축물대장 표제부 (BldRgstHub/GIS건물통합)'
      : '국토부 건축물대장 표제부 (LT_C_BLDGINFO)';
  } else {
    ledgerStatus = '건축물대장 표제부 미등재 (미등기·가설건축물 등 현장 확인)';
    sourceLabel = 'VWorld 도로명주소 건물 (LT_C_SPBD)';
  }

  const tacticalNotes = buildTacticalNotes(mainUse, structure, roof, grndFlr, useAprDay);

  const payload = {
    found: foundBuilding,
    hasLedgerRecord: hasLedgerRecord,
    ledgerStatus: ledgerStatus,
    distanceM: distM,
    lat: lat,
    lng: lng,
    roadAddress: roadAddress || null,
    parcelAddress: parcelAddress || null,
    buildingName: buildingName,
    dongName: dongName,
    bdMgtSn: bdMgtSn || null,
    pnu: pnu || null,
    mainUse: mainUse,
    etcUse: etcUse,
    structure: structure,
    roof: roof,
    groundFloors: grndFlr,
    undergroundFloors: ugrndFlr,
    floors: floorsStr,
    totalAreaM2: totalAreaM2,
    archAreaM2: archAreaM2,
    platAreaM2: platAreaM2,
    heightM: heightM,
    bcRat: bcRat,
    vlRat: vlRat,
    useAprDay: useAprDay,
    tacticalNotes: tacticalNotes,
    source: sourceLabel
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
