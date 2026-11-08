/**
 * 농어촌 소방차량 스마트 진입로 판정 웹 애플리케이션 메인 컨트롤러 (방식 B 단일 구동)
 * - 의령군 13개 읍·면 239개 전 마을 네비게이션 및 실시간 검색
 * - 온디맨드 그래프 JSON / 진단 레이어 JSON 로딩
 * - 2단계(1차 차량 진입 + 2차 호스 연장) 전술 경로 시각화 및 실시간 건축물대장·AI 브리핑 연동
 */
(function () {
  'use strict';

  const FW_CONFIG = window.FW_CONFIG || {};
  const HYDRANT_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="6.5" y="20" width="11" height="2.6" rx="1" fill="#b91c1c"/><rect x="8" y="9" width="8" height="11.5" fill="#ef4444"/><rect x="6.8" y="7.4" width="10.4" height="2.2" rx=".6" fill="#dc2626"/><path d="M8.6 7.6a3.4 3.4 0 0 1 6.8 0z" fill="#ef4444"/><rect x="11" y="2.6" width="2" height="2.2" rx="1" fill="#dc2626"/><rect x="4.8" y="12.2" width="3.4" height="3" fill="#dc2626"/><rect x="15.8" y="11.6" width="3.4" height="4.2" rx=".6" fill="#dc2626"/></svg>';
  const PIN_SVG = '<svg viewBox="0 0 24 32" width="24" height="32"><path d="M12 1C5.9 1 1 5.9 1 12c0 8.3 11 19 11 19s11-10.7 11-19C23 5.9 18.1 1 12 1z" fill="#ef4444" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="4.3" fill="#fff"/></svg>';
  const VWORLD_KEY = FW_CONFIG.vworldKey || '';
  const VWORLD_DOMAIN = FW_CONFIG.vworldDomain || 'localhost';

  const SAMPLE_SEARCH_ADDRESSES = [
    {
      address: '의령군 용덕면 덕암로 9길 18-1',
      lat: 35.363102,
      lng: 128.265476,
      regionId: 'eup_yongdeok',
      villageId: 'vil_yongdeok_104'
    },
    {
      address: '의령군 벽화로5길 72-9',
      lat: 35.303813,
      lng: 128.259467,
      regionId: 'eup_uiryeong',
      villageId: 'vil_uiryeong_158'
    }
  ];

  let catalog = null;
  const graphCache = new Map();
  const diagCache = new Map();

  let currentRegionCode = null;
  let currentVillageId = '';
  let currentThreshold = 2.5;
  let currentIndex = null;
  let currentNetEval = null;
  let lastMission = null;
  let lastBuildingInfo = null;
  let lastRouteApiResult = null;
  let lastExternalTargetCache = null;
  let lastSearchedAddress = '';
  let lastSyncedSearchInputValue = '';
  let searchActionState = 'search'; // 'search' | 'reset'
  let customStartPoint = null;
  let routeSelectStep = 'idle'; // 'idle' | 'pick_target'
  let useStationStart = true; // 의령소방서 고정 출발 상시 활성화
  let nudgeTimer = null;

  function setSearchButtonMode(mode) {
    searchActionState = mode === 'reset' ? 'reset' : 'search';
    const btn = document.getElementById('btn-address-search');
    if (!btn) return;
    if (searchActionState === 'reset') {
      btn.dataset.mode = 'reset';
      btn.textContent = '검색 초기화';
      btn.title = '현재 탐색된 경로와 주소 검색을 초기화합니다';
      btn.classList.add('btn-search-reset');
    } else {
      btn.dataset.mode = 'search';
      btn.textContent = '주소로 경로탐색';
      btn.title = '입력한 주소(미입력 시 예시 주소)로 경로를 탐색합니다';
      btn.classList.remove('btn-search-reset');
    }
  }

  function matchSampleSearchAddress(rawQuery) {
    const norm = String(rawQuery || '')
      .replace(/^경상남도\s*/g, '')
      .replace(/\s+/g, '')
      .trim();
    if (!norm) return null;
    for (let i = 0; i < SAMPLE_SEARCH_ADDRESSES.length; i++) {
      const s = SAMPLE_SEARCH_ADDRESSES[i];
      const sNorm = s.address.replace(/^경상남도\s*/g, '').replace(/\s+/g, '').trim();
      const sCore = sNorm.replace(/^의령군/, '');
      if (norm === sNorm || norm === sCore) {
        return s;
      }
    }
    return null;
  }

  let map = null;
  let hybridLayer = null;
  let hybridVisible = true;

  let roadLayerGroup = null;
  let buildingLayerGroup = null;
  let hydrantLayerGroup = null;
  let REAL_HYDRANTS = [];
  function roadPxWeight(o) {
    const base = (o.fwBaseW || 3) * 2;
    if (!map || !o.fwWidthM) return base;
    const lat = map.getCenter().lat;
    const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
    return Math.max(base, Math.min(60, o.fwWidthM / mpp));
  }
  function refreshLineWeights() {
    [roadLayerGroup, missionLayerGroup].forEach((g) => {
      if (!g) return;
      g.eachLayer((ly) => {
        if (ly.options && ly.options.fwBaseW && ly.setStyle) ly.setStyle({ weight: roadPxWeight(ly.options) });
      });
    });
  }
  let VILLAGE_BOOK = {};
  fetch('./data/villages_book.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { VILLAGE_BOOK = (d && d.byVillageId) || {}; try { renderVillageInfo(); } catch (_) {} })
    .catch(() => {});

  function escHtml(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // 길찾기 맨 위 요약 4칸 (화재 유형 · 출동 · 최심부 진입 · 마을 내 소화전)
  // 출동 대수: 농골길 dispatch_v1.1 (기본 편성 펌프1·물탱크1·구급1만 확정, 나머지는 가정)
  // 건축물대장 주용도 → 화재 유형 (출동 대수는 가정 — 경남본부 출동 기준 확보 후 교체)
  const FIRE_TYPES = [
    { name: '사회적약자', re: /노유자|의료|요양|아동|노인|장애|유치원|어린이/, v: { 펌프: 3, 물탱크: 3, 구급: 2, 구조: 1, 굴절: 1 } },
    { name: '주택', re: /주택|다가구|다세대|아파트|연립|기숙사/, v: { 펌프: 1, 물탱크: 1, 구급: 1 } },
    { name: '공장', re: /공장|위험물|발전|자원순환|분뇨|쓰레기/, v: { 펌프: 2, 물탱크: 2, 구급: 1, 굴절: 1 } },
    { name: '축사·창고', re: /동물|식물|축사|창고|농업|버섯|온실/, v: { 펌프: 2, 물탱크: 2, 구급: 1, 굴절: 1, 무인방수: 1 } },
    { name: '전기차', re: /자동차|주차|충전/, v: { 펌프: 1, 물탱크: 2, 구급: 1 } }
  ];
  const FIRE_TYPE_ETC = { name: '기타', v: { 펌프: 2, 물탱크: 1, 구급: 1 } };
  const FIRE_TYPE_OUTDOOR = { name: '산불·야외', v: { 펌프: 1, 물탱크: 2, 구급: 1 } };
  function classifyFireType(bi) {
    if (!bi) return null;
    // 주용도로 먼저 판단(기타용도의 '창고' 같은 부속 표기에 끌려가지 않도록), 주용도가 없을 때만 기타용도
    const main = String(bi.mainUse || '').trim();
    const use = main || String(bi.etcUse || '').trim();
    if (!use) return bi.found === false ? FIRE_TYPE_OUTDOOR : FIRE_TYPE_ETC;
    if (/근린|종교|문화|집회|판매|숙박|업무|교육|운동|위락|관광|묘지|장례|교정|방송|국방/.test(main)) return FIRE_TYPE_ETC;
    return FIRE_TYPES.find((t) => t.re.test(use)) || FIRE_TYPE_ETC;
  }
  function updateMissionSummary() {
    const el = document.getElementById('mission-summary');
    if (!el) return;
    if (!lastMission || !lastMission.found) { el.classList.add('hidden'); return; }
    const v = getCurrentAnalyzedVillage();
    const b = v ? VILLAGE_BOOK[v.id] : null;
    const use = (lastBuildingInfo && (lastBuildingInfo.mainUse || '')) || '';
    const ft = classifyFireType(lastBuildingInfo);
    const vehicles = (ft || FIRE_TYPES[1]).v;
    const total = Object.values(vehicles).reduce((a, n) => a + n, 0);
    const vehStr = Object.entries(vehicles).map(([k, n]) => `${k}${n}`).join('·');
    const hoseN = lastMission.requiredHoseWithSpareCount || lastMission.requiredHose15mCount || 0;
    const hyd = b ? (b.hydrant_in === 'O' ? '있음' : '없음') : '-';
    const name = b ? b.village : v ? `${v.name}마을` : '신고 지점';
    const addr = lastSearchedAddress || (lastBuildingInfo && (lastBuildingInfo.roadAddress || lastBuildingInfo.parcelAddress)) || '';
    el.innerHTML = `
      <div class="ms-title">${escHtml(name)}</div>
      <div class="ms-sub">${b ? `${escHtml(b.group)}관리 · 책자 ${b.page}쪽` : ''}${addr ? `${b ? ' · ' : ''}📍 ${escHtml(addr)}` : ''}</div>
      ${b && (b.fire_risk || []).length ? `<span class="vi-risk">⚠ ${escHtml(b.fire_risk[0])}</span>` : ''}
      <div class="ms-grid">
        <div><span>화재 유형</span><b>${ft ? ft.name : '확인 중'}</b><em>${ft ? escHtml(use || (ft === FIRE_TYPE_OUTDOOR ? '주변 건물 없음' : '용도 미등재')) : '건축물대장 조회'}</em></div>
        <div title="${vehStr}"><span>출동</span><b>${total}대</b><em>${vehStr}</em></div>
        <div><span>호스</span><b>${hoseN ? hoseN + '매' : '-'}</b><em>${lastMission.hoseDistanceM ? lastMission.hoseDistanceM + 'm · 예비 포함' : '차량 직접 진입'}</em></div>
        <div><span>마을 내 소화전</span><b class="${hyd === '있음' ? 'vi-o' : hyd === '없음' ? 'vi-x' : ''}">${hyd}</b></div>
      </div>`;
    el.classList.remove('hidden');
  }

  // 차량별 도착 지점(반투명): 구급 2.0m · 펌프 2.5m · 물탱크 2.8m 기준으로 각각 계산
  const VEHICLE_STOPS = [
    { key: '구급', thr: 2.0, color: '#16a34a' },
    { key: '펌프', thr: 2.5, color: '#dc2626' },
    { key: '물탱크', thr: 2.8, color: '#7c3aed' }
  ];
  // 정면 소방차 아이콘(직접 그림) — 차체 색만 바꿔 씀
  function truckSvg(c, size) {
    const w = size || 26;
    return `<svg viewBox="0 0 56 54" width="${w}" height="${Math.round(w * 54 / 56)}"><rect x="0" y="7" width="4.5" height="9" rx="1.2" fill="#111"/><rect x="51.5" y="7" width="4.5" height="9" rx="1.2" fill="#111"/><rect x="9" y="44" width="9" height="10" rx="2" fill="#111"/><rect x="38" y="44" width="9" height="10" rx="2" fill="#111"/><rect x="5" y="2" width="46" height="44" rx="6" fill="${c}" stroke="#fff" stroke-width="1.5"/><rect x="5.8" y="2.8" width="44.4" height="5" rx="3" fill="#111"/><rect x="9.5" y="8" width="37" height="15" rx="3" fill="#fff"/><rect x="20" y="29" width="16" height="8" rx="1" fill="#111"/><rect x="22" y="31" width="12" height="1.2" fill="#fff"/><rect x="22" y="33.5" width="12" height="1.2" fill="#fff"/><rect x="9" y="29" width="3" height="6" fill="#facc15"/><rect x="12" y="29" width="7" height="6" fill="#fff"/><rect x="37" y="29" width="7" height="6" fill="#fff"/><rect x="44" y="29" width="3" height="6" fill="#facc15"/><rect x="9" y="39" width="7" height="3.5" rx="1.5" fill="#fff"/><rect x="40" y="39" width="7" height="3.5" rx="1.5" fill="#fff"/><path d="M22 25 q6 -4 12 0 q-6 2 -12 0z" fill="#facc15"/></svg>`;
  }
  let vehStopLayer = null;
  function drawVehicleStops(lat, lng, baseOpts, found) {
    if (!map) return;
    if (!vehStopLayer) vehStopLayer = L.layerGroup();
    vehStopLayer.clearLayers();
    const on = document.getElementById('chk-layer-vstops');
    if (on && !on.checked) map.removeLayer(vehStopLayer); else vehStopLayer.addTo(map);
    if (!found) return;
    const groups = new Map();
    VEHICLE_STOPS.forEach((vs) => {
      const r = window.FirewayGraphEngine.findMissionRoute(currentIndex, lat, lng, Object.assign({}, baseOpts, { threshold: vs.thr }));
      if (!r || !r.found || !r.stagingPoint) return;
      const k = r.stagingPoint.map((x) => Number(x).toFixed(6)).join(',');
      if (!groups.has(k)) groups.set(k, { pt: r.stagingPoint, items: [] });
      groups.get(k).items.push({ vs, hose: r.requiredHoseWithSpareCount || r.requiredHose15mCount, dist: r.hoseDistanceM });
    });
    groups.forEach((g) => {
      const label = g.items.map((it) => it.vs.key).join('·');
      const icons = g.items.map((it) => truckSvg(it.vs.color, 38)).join('');
      const tip = g.items.map((it) => `${it.vs.key} 도착 · 호스 ${it.hose}매 (${it.dist}m)`).join('<br>');
      L.marker(g.pt, {
        icon: L.divIcon({ className: 'fw-vstop-icon', html: `<div class="vstop"><div class="vstop-trucks">${icons}</div><span>${label} 도착</span></div>`, iconSize: null }),
        zIndexOffset: 400
      }).bindTooltip(tip, { direction: 'top', offset: [0, -14] }).addTo(vehStopLayer);
    });
  }

  // 책자 '불가' 지점을 지도에 표시
  let zoneLayer = null;
  function drawBookZones(b) {
    if (!map) return;
    if (!zoneLayer) zoneLayer = L.layerGroup().addTo(map);
    zoneLayer.clearLayers();
    ((b && b.zones) || []).forEach((z) => {
      const label = /^불가/.test(z.label) ? z.label : '불가';
      L.marker(z.ll, {
        icon: L.divIcon({ className: 'fw-zone-icon', html: `<span>⛔ ${escHtml(label)}</span>`, iconSize: null }),
        zIndexOffset: 500
      })
        .bindTooltip(escHtml(z.label), { direction: 'top' })
        .addTo(zoneLayer);
    });
  }

  // 마을정보 탭: 농골길 책자(길라잡이) 내용
  function renderVillageInfo() {
    const box = document.getElementById('village-info-box');
    if (!box) return;
    const v = typeof getCurrentAnalyzedVillage === 'function' ? getCurrentAnalyzedVillage() : null;
    if (!v) { box.innerHTML = '<p class="muted-text">주소를 검색하거나 마을 안을 누르면 책자 정보가 나옵니다.</p>'; return; }
    const b = VILLAGE_BOOK[v.id];
    drawBookZones(b);
    setTimeout(updateMissionSummary, 0);
    if (!b) { box.innerHTML = `<div class="vi-head"><div class="vi-name">${escHtml(v.eupName)} ${escHtml(v.name)}마을</div></div><p class="muted-text">이 마을은 책자 정보가 없습니다.</p>`; return; }
    const ox = (x) => `<span class="${x === 'O' ? 'vi-o' : 'vi-x'}">${escHtml(x || '-')}</span>`;
    const kinds = ['펌프', '물탱크', '구급', '굴절'];
    const ve = b.vehicle_entry || [];
    const table = ve.length
      ? `<table class="vi-table"><tr><th></th>${kinds.map((k) => `<th>${k}</th>`).join('')}</tr>${ve
          .map((z) => `<tr><td>${escHtml(z.zone)}</td>${kinds.map((k) => `<td>${ox((z.veh || {})[k])}</td>`).join('')}</tr>`)
          .join('')}</table>`
      : '';
    const li = (arr) => (arr || []).map((t) => `<li>${escHtml(t)}</li>`).join('');
    const hyd = (b.hydrants || [])
      .map((h) => `<div class="vi-hyd"><span>${escHtml(h.code)}</span><span>${escHtml(h.dist)} · ${escHtml(h.place)}</span></div>`)
      .join('');
    const first = (b.hydrants || [])[0];
    const hydHead = b.hydrant_in === 'O' ? '마을 안 소화전 있음' : `마을 안 소화전 없음 → 물탱크 중계 급수${first ? ` (가장 가까운 ${escHtml(first.code)} ${escHtml(first.dist)})` : ''}`;
    box.innerHTML = `
      <div class="vi-head">
        <div class="vi-name">${escHtml(b.village)}</div>
        <div class="vi-sub">${escHtml(b.group)}관리 · 책자 ${b.page}쪽 · ${escHtml(b.address)}</div>
        ${(b.fire_risk || []).map((r) => `<span class="vi-risk">⚠ ${escHtml(r)}</span>`).join('')}
        <div class="vi-stats">
          <div><span>최심부 진입</span><b class="${b.deep_entry === 'O' ? 'vi-o' : 'vi-x'}">${b.deep_entry === 'O' ? '가능' : '불가'}</b></div>
          <div><span>호스</span><b>${b.hose ? b.hose + '매' : '-'}</b></div>
          <div><span>마을 내 소화전</span><b class="${b.hydrant_in === 'O' ? 'vi-o' : 'vi-x'}">${b.hydrant_in === 'O' ? '있음' : '없음'}</b></div>
        </div>
      </div>
      ${(b.zones || []).length ? `<div class="bi-card"><div class="bi-title">진입곤란 구간 (책자 · 지도에 ⛔ 표시)</div>${table}<ul class="vi-list">${li(b.difficult_zone)}${li(b.road_notes)}${li(b.alt_route)}${li(b.deep_hose_note)}</ul></div>` : ''}
      <div class="bi-card"><div class="bi-title">급수 · 소화전</div><div class="vi-hyd-head">${hydHead}</div>${hyd}</div>
      ${(b.tactics || []).length ? `<div class="bi-card"><div class="bi-title">마을별 화재진압작전 (책자 원문)</div><ul class="vi-list">${li(b.tactics)}</ul></div>` : ''}
    `;
  }
  fetch('./data/hydrants.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      REAL_HYDRANTS = (d && d.hydrants) || [];
      try { if (map && hydrantLayerGroup && currentIndex) renderMapLayers(); } catch (_) {}
    })
    .catch(() => {});
  let nodeLayerGroup = null;
  let diagLayerGroup = null;
  let docMapLayerGroup = null;
  let trunkRouteLayerGroup = null;
  let startMarkerLayerGroup = null;
  let missionLayerGroup = null;

  function initMap() {
    map = L.map('map', {
      center: [35.322, 128.261],
      zoom: 13,
      preferCanvas: true,
      zoomControl: true
    });

    L.tileLayer(
      `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Satellite/{z}/{y}/{x}.jpeg`,
      {
        maxZoom: 19,
        attribution: '&copy; VWorld 국토교통부 위성영상'
      }
    ).addTo(map);

    hybridLayer = L.tileLayer(
      `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Hybrid/{z}/{y}/{x}.png`,
      {
        maxZoom: 19,
        opacity: 0.85
      }
    ).addTo(map);

    docMapLayerGroup = L.layerGroup().addTo(map);
    buildingLayerGroup = L.layerGroup().addTo(map);
    roadLayerGroup = L.layerGroup().addTo(map);
    diagLayerGroup = L.layerGroup().addTo(map);
    nodeLayerGroup = L.layerGroup();
    hydrantLayerGroup = L.layerGroup().addTo(map);
    trunkRouteLayerGroup = L.layerGroup().addTo(map);
    startMarkerLayerGroup = L.layerGroup().addTo(map);
    missionLayerGroup = L.layerGroup().addTo(map);

    map.on('click', (e) => {
      handleMapOrLayerClick(e.latlng.lat, e.latlng.lng, null);
    });
    // 도로·경로 선 굵기: 확대하면 실제 도로 폭(m)만큼, 멀리서는 최소 2배
    map.on('zoomend', refreshLineWeights);
    // 멀리 볼 때는 소화전 아이콘 숨김(복잡함 방지)
    const syncZoomClass = () => map.getContainer().classList.toggle('zoom-low', map.getZoom() < 14);
    map.on('zoomend', syncZoomClass);
    syncZoomClass();

    map.on('contextmenu', (e) => {
      handleMapOrLayerClick(e.latlng.lat, e.latlng.lng, null);
    });
  }

  function getCurrentAnalyzedVillage() {
    if (!currentIndex) return null;
    if (currentVillageId && currentIndex.villageMap && currentIndex.villageMap.has(currentVillageId)) {
      return currentIndex.villageMap.get(currentVillageId);
    }
    if (
      lastMission &&
      lastMission.villageId &&
      currentIndex.villageMap &&
      currentIndex.villageMap.has(lastMission.villageId)
    ) {
      return currentIndex.villageMap.get(lastMission.villageId);
    }
    return null;
  }

  function getRouteEntryPoint(route) {
    if (!route) return null;
    const bp = route.boundaryEntryPoint || route.villageEntrance;
    if (!bp) return null;
    if (Array.isArray(bp) && bp.length >= 2) {
      return {
        lat: Number(bp[0]),
        lng: Number(bp[1]),
        name: `${route.villageName || ''}마을 범위 진입점`.trim()
      };
    }
    if (Number.isFinite(Number(bp.lat)) && Number.isFinite(Number(bp.lng))) {
      const rawName = bp.name ? String(bp.name) : `${route.villageName || ''}마을 범위 진입점`;
      return {
        lat: Number(bp.lat),
        lng: Number(bp.lng),
        name: rawName.replace(/마을\s*입구/g, '마을 범위 진입점').trim()
      };
    }
    return null;
  }

  function syncActiveVillageUI(vid) {
    setTimeout(() => { try { renderVillageInfo(); } catch (_) {} }, 0);
    currentVillageId = vid || '';
    const vSel = document.getElementById('village-select');
    if (vSel && vSel.value !== currentVillageId) {
      vSel.value = currentVillageId;
    }
    document.querySelectorAll('.village-chip').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.vid === currentVillageId);
    });
    const sTitle = document.getElementById('scope-title');
    const sDesc = document.getElementById('scope-desc');
    if (currentVillageId && currentIndex && currentIndex.villageMap && currentIndex.villageMap.has(currentVillageId)) {
      const v = currentIndex.villageMap.get(currentVillageId);
      if (sTitle) sTitle.textContent = `${v.eupName} ${v.name}마을 판정 현황`;
      if (sDesc) {
        sDesc.textContent =
          `${v.eupName} ${v.name}마을: 소방서→마을 입구는 T맵, 마을 안은 골목 폭을 따져 길을 찾습니다.`;
      }
    } else if (currentIndex) {
      if (sTitle) sTitle.textContent = `${currentIndex.name} 전체 현황`;
      if (sDesc) {
        sDesc.textContent =
          '주소를 검색하거나 마을 안을 누르면 소방차·호스 길을 찾습니다.';
      }
    }
  }

  function showNudgeBanner(msg, durationMs) {
    const banner = document.getElementById('map-pick-banner');
    if (!banner) return;
    if (nudgeTimer) clearTimeout(nudgeTimer);
    banner.textContent = msg;
    banner.classList.remove('hidden');
    nudgeTimer = setTimeout(() => {
      if (routeSelectStep === 'idle') {
        banner.classList.add('hidden');
      }
    }, durationMs || 3400);
  }

  function setRouteSelectStep(step) {
    routeSelectStep = step === 'pick_target' ? 'pick_target' : 'idle';
    if (nudgeTimer) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
    const isSelecting = routeSelectStep === 'pick_target';
    document.body.classList.toggle('pick-start-mode', isSelecting);

    const banner = document.getElementById('map-pick-banner');
    const btnHeader = document.getElementById('btn-route-search');
    const btnDrawerRoute = document.getElementById('btn-drawer-show-all');
    const btnPick = document.getElementById('btn-pick-start');
    const statusBadge = document.getElementById('mission-status-badge');
    const curV = getCurrentAnalyzedVillage();
    const vLabel = curV ? `${curV.eupName} ${curV.name}마을 (전체 239개 마을 선택 가능)` : '의령군 239개 분석 마을';

    if (routeSelectStep === 'pick_target') {
      if (banner) {
        banner.textContent =
          `[화점 선택 · ${vLabel}]: 위 검색창에 주소를 넣거나 주황 점선 마을 안을 누르세요 (ESC 취소)`;
        banner.classList.remove('hidden');
      }
      if (btnHeader) {
        btnHeader.classList.add('active');
        btnHeader.textContent = '화점 선택 중...';
      }
      if (btnDrawerRoute) {
        btnDrawerRoute.classList.add('active');
        btnDrawerRoute.textContent = '화점 선택 중...';
      }
      if (btnPick) {
        btnPick.classList.add('active');
        btnPick.textContent = '화점 선택 대기 중...';
      }
      if (statusBadge) {
        statusBadge.textContent = '화점 선택 대기';
        statusBadge.className = 'badge badge-warn';
      }
    } else {
      if (banner) banner.classList.add('hidden');
      if (btnHeader) {
        btnHeader.classList.remove('active');
        btnHeader.textContent = '경로탐색';
      }
      if (btnDrawerRoute) {
        btnDrawerRoute.classList.remove('active');
        btnDrawerRoute.textContent = '경로탐색';
      }
      if (btnPick) {
        btnPick.classList.remove('active');
        btnPick.textContent = '경로탐색';
      }
      if (statusBadge && (!lastMission || !lastMission.found)) {
        statusBadge.textContent = '주소 검색 대기';
        statusBadge.className = 'badge badge-neutral';
      }
    }
    updateStartPointUI();
  }

  function startRouteSearchFlow() {
    if (routeSelectStep !== 'idle') {
      setRouteSelectStep('idle');
      return;
    }
    ensureRouteSectionVisible();
    setRouteSelectStep('pick_target');
    const searchInput = document.getElementById('village-search');
    if (searchInput) {
      searchInput.focus();
    }
  }

  async function handleMapOrLayerClick(lat, lng, bldgRing, force) {
    if (!currentIndex) return;
    if (!force && lastMission && map) {
      const wrap = document.createElement('div');
      wrap.className = 'dest-pop';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dest-pop-btn';
      btn.textContent = '여기를 도착지점으로';
      btn.addEventListener('click', () => {
        map.closePopup();
        handleMapOrLayerClick(lat, lng, bldgRing, true);
      });
      wrap.appendChild(btn);
      L.popup({ className: 'dest-popup', closeButton: false, offset: [0, -4] }).setLatLng([lat, lng]).setContent(wrap).openOn(map);
      return;
    }

    let matchedV =
      window.FirewayGraphEngine && window.FirewayGraphEngine.findAnalyzedVillageForPoint
        ? window.FirewayGraphEngine.findAnalyzedVillageForPoint(currentIndex, lat, lng, currentVillageId)
        : null;

    if (matchedV) {
      syncActiveVillageUI(matchedV.id);
      renderDocMapOverlay();
      setRouteSelectStep('idle');
      ensureRouteSectionVisible();
      lastSearchedAddress = '';
      await dispatchMissionTo(lat, lng, bldgRing, false);
      return;
    }

    const catV = findCatalogVillageContainingPoint(lat, lng);
    if (catV) {
      if (catV.regionId && catV.regionId !== currentRegionCode) {
        const rSel = document.getElementById('region-select');
        if (rSel) rSel.value = catV.regionId;
        await selectRegion(catV.regionId, catV.id);
      } else {
        syncActiveVillageUI(catV.id);
        renderDocMapOverlay();
      }
      setRouteSelectStep('idle');
      ensureRouteSectionVisible();
      lastSearchedAddress = '';
      await dispatchMissionTo(lat, lng, bldgRing, false);
      return;
    }

    showNudgeBanner(
      '⚠️ 선택하신 지점은 분석된 239개 마을 사각형 범위 밖입니다. 분석된 마을 범위 내에서만 경로를 탐색합니다.',
      4200
    );
  }

  function updateStartPointUI() {
    const statusEl = document.getElementById('start-point-status');
    const entEl = document.getElementById('waypoint-entrance-status');
    const vilEl = document.getElementById('analyzed-village-status');
    const addrEl = document.getElementById('target-address-status');
    const resetBtn = document.getElementById('btn-reset-start');

    if (statusEl) {
      statusEl.textContent = '🚒 의령소방서 (의병로 108-17) [고정]';
      statusEl.classList.add('custom-active');
    }

    const curV = getCurrentAnalyzedVillage();
    if (entEl) {
      const ep = lastMission && lastMission.found ? getRouteEntryPoint(lastMission) : null;
      if (ep) {
        entEl.textContent = `🔶 ${ep.name} (${ep.lat.toFixed(5)}, ${ep.lng.toFixed(5)}) [마을 입구]`;
      } else if (curV && window.FirewayGraphEngine && window.FirewayGraphEngine.getVillageEntrancePoint) {
        const ent = window.FirewayGraphEngine.getVillageEntrancePoint(currentIndex, curV);
        if (ent) {
          entEl.textContent = `🔶 ${curV.eupName} ${curV.name}마을 범위 진입점 (${ent.lat.toFixed(5)}, ${ent.lng.toFixed(5)}) [마을 입구]`;
        } else {
          entEl.textContent = `🔶 ${curV.eupName} ${curV.name}마을 입구`;
        }
      } else {
        entEl.textContent = '🔶 마을 입구';
      }
    }

    if (vilEl) {
      vilEl.textContent = curV
        ? `${curV.eupName} ${curV.name}마을 (전체 239개 분석 마을 선택 가능)`
        : '의령군 239개 전 분석 마을 (클릭·주소검색 시 자동 매칭)';
    }

    if (addrEl) {
      if (lastMission && lastMission.found) {
        const addrStr =
          lastSearchedAddress ||
          (lastBuildingInfo && (lastBuildingInfo.roadAddress || lastBuildingInfo.parcelAddress)) ||
          `화점 좌표 (${Number(lastMission.targetLat).toFixed(5)}, ${Number(lastMission.targetLng).toFixed(5)})`;
        addrEl.textContent = addrStr;
      } else if (routeSelectStep === 'pick_target') {
        addrEl.textContent = '상단 주소 검색창에 주소 입력 또는 239개 분석 마을 범위 내 건물 클릭';
      } else {
        addrEl.textContent = '상단 주소 검색창에서 주소 검색 또는 분석 마을 내 지점 클릭';
      }
    }

    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !(lastMission && lastMission.found));
    }
  }

  function renderStartMarker() {
    if (!startMarkerLayerGroup) return;
    startMarkerLayerGroup.clearLayers();
    if (!currentIndex) return;

    if (window.FirewayGraphEngine && window.FirewayGraphEngine.FIRE_STATION) {
      const st = window.FirewayGraphEngine.FIRE_STATION;
      const stMarker = L.circleMarker([st.lat, st.lng], {
        radius: 9,
        color: '#fff',
        weight: 2.5,
        fillColor: '#f59e0b',
        fillOpacity: 1
      }).addTo(startMarkerLayerGroup);
      stMarker.bindTooltip(`🚒 출발지(고정): ${st.name}`, {
        permanent: true,
        direction: 'top'
      });
    }
  }

  function setExactStartPoint(lat, lng) {
    // 출발지는 의령소방서로 고정되어 있으므로 클릭 지점을 화점 탐색으로 전달합니다.
    handleMapOrLayerClick(lat, lng, null);
  }

  function toggleStationStart() {
    useStationStart = true;
    updateStartPointUI();
    renderStartMarker();
  }

  function resetCustomStart() {
    customStartPoint = null;
    lastMission = null;
    lastBuildingInfo = null;
    lastRouteApiResult = null;
    if (vehStopLayer) vehStopLayer.clearLayers();
    setTimeout(updateMissionSummary, 0);
    lastExternalTargetCache = null;
    lastSearchedAddress = '';
    lastSyncedSearchInputValue = '';
    useStationStart = true;

    const searchInput = document.getElementById('village-search');
    if (searchInput) {
      searchInput.value = '';
    }
    const drop = document.getElementById('village-search-results');
    if (drop) {
      drop.classList.add('hidden');
    }

    setSearchButtonMode('search');
    setRouteSelectStep('idle');
    if (missionLayerGroup) missionLayerGroup.clearLayers();
    if (trunkRouteLayerGroup) trunkRouteLayerGroup.clearLayers();

    const emptyEl = document.getElementById('mission-empty');
    if (emptyEl) emptyEl.classList.remove('hidden');
    const resultEl = document.getElementById('mission-result');
    if (resultEl) resultEl.classList.add('hidden');

    const statusBadge = document.getElementById('mission-status-badge');
    if (statusBadge) {
      statusBadge.textContent = '주소 검색 대기';
      statusBadge.className = 'badge badge-neutral';
    }

    const bldgBadge = document.getElementById('bldg-api-badge');
    if (bldgBadge) {
      bldgBadge.textContent = '실시간 연동';
    }
    const bldgBox = document.getElementById('building-info-box');
    if (bldgBox) {
      bldgBox.innerHTML =
        '<p class="muted-text">지도에서 건물을 누르면 주소와 건축물대장(용도·구조·층수)이 나옵니다.</p>';
    }
    const aiBox = document.getElementById('ai-brief-box');
    if (aiBox) {
      aiBox.innerHTML =
        '경로를 찾은 뒤 [AI 전술 생성]을 누르면 건물 정보와 진입·호스 판정을 바탕으로 전술을 만들어 줍니다.';
    }

    updateStartPointUI();
    refreshNetworkAndLayers();
  }

  function setLoading(isLoading, msg) {
    const el = document.getElementById('map-loading');
    if (!el) return;
    if (msg) el.textContent = msg;
    el.classList.toggle('hidden', !isLoading);
  }

  async function loadCatalog() {
    setLoading(true, '의령군 13개 읍·면 239개 마을 카탈로그 로드 중...');
    if (window.__INLINE_BUNDLE__ && window.__INLINE_BUNDLE__.index) {
      catalog = window.__INLINE_BUNDLE__.index;
    } else {
      const resp = await fetch('./data/graphs/index.json');
      catalog = await resp.json();
    }
    populateRegionSelect();
    setupSearchBox();
    const initialRegion = catalog.defaultRegion || (catalog.regions[0] && catalog.regions[0].code);
    if (initialRegion) {
      await selectRegion(initialRegion, '');
    }
    setLoading(false);
  }

  function populateRegionSelect() {
    const sel = document.getElementById('region-select');
    sel.innerHTML = '';

    const eupGroup = document.createElement('optgroup');
    eupGroup.label = '의령군 13개 읍·면 (239개 마을)';
    const pilotGroup = document.createElement('optgroup');
    pilotGroup.label = '시범 검증 도엽 (5개)';

    (catalog.regions || []).forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.code;
      opt.textContent = r.name;
      if (r.group === 'eup_cluster') {
        eupGroup.appendChild(opt);
      } else {
        pilotGroup.appendChild(opt);
      }
    });

    sel.appendChild(eupGroup);
    sel.appendChild(pilotGroup);
  }

  function populateVillageUI(villages) {
    const sel = document.getElementById('village-select');
    const chipContainer = document.getElementById('village-chip-list');
    const countBadge = document.getElementById('eup-village-count');

    const allVillages = catalog && Array.isArray(catalog.villages) ? catalog.villages : villages;
    if (sel) {
      sel.innerHTML = `<option value="">현재 읍·면 전체 도로망 보기 (전체 ${allVillages.length}개 마을 선택 가능)</option>`;
    }
    if (chipContainer) chipContainer.innerHTML = '';
    if (countBadge) countBadge.textContent = `${villages.length}개`;

    if (villages.length > 0) {
      const curEupName = villages[0].eupName || '현재 읍·면';
      const curGroup = document.createElement('optgroup');
      curGroup.label = `📍 [현재 지역] ${curEupName} (${villages.length}개 마을)`;
      villages.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.dataset.regionId = v.regionId || currentRegionCode;
        opt.textContent = `${v.name}마을 (${v.eupName})`;
        curGroup.appendChild(opt);

        if (chipContainer) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'village-chip';
          chip.dataset.vid = v.id;
          chip.textContent = v.name;
          chip.addEventListener('click', () => {
            if (sel) sel.value = v.id;
            selectVillage(v.id, true);
          });
          chipContainer.appendChild(chip);
        }
      });
      if (sel) sel.appendChild(curGroup);
    }

    if (allVillages.length > 0 && sel) {
      const byEup = new Map();
      allVillages.forEach((v) => {
        if (v.regionId === currentRegionCode) return;
        const key = v.eupName || v.regionId;
        if (!byEup.has(key)) byEup.set(key, []);
        byEup.get(key).push(v);
      });
      byEup.forEach((vList, eupName) => {
        const grp = document.createElement('optgroup');
        grp.label = `${eupName} (${vList.length}개 마을)`;
        vList.forEach((v) => {
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.dataset.regionId = v.regionId;
          opt.textContent = `${v.name}마을 (${v.eupName})`;
          grp.appendChild(opt);
        });
        sel.appendChild(grp);
      });
    }
  }

  function pickRepresentativeVillageTarget(index, v) {
    if (!index || !v) return null;
    const bObj = window.FirewayGraphEngine.getVillageAnalyzedBounds(index, v);
    const b = bObj ? bObj.searchBounds : v.bbox;
    if (b && Array.isArray(index.buildings)) {
      let bestCenter = null;
      let bestDist = Infinity;
      const cLat = v.center ? v.center[0] : (b[0] + b[2]) * 0.5;
      const cLng = v.center ? v.center[1] : (b[1] + b[3]) * 0.5;
      for (let i = 0; i < index.buildings.length; i++) {
        const ring = index.buildings[i];
        if (!ring || ring.length === 0) continue;
        let latSum = 0;
        let lngSum = 0;
        for (let k = 0; k < ring.length; k++) {
          latSum += ring[k][0];
          lngSum += ring[k][1];
        }
        const mLat = latSum / ring.length;
        const mLng = lngSum / ring.length;
        if (mLat >= b[0] - 0.0005 && mLng >= b[1] - 0.0005 && mLat <= b[2] + 0.0005 && mLng <= b[3] + 0.0005) {
          const d = Math.hypot(mLat - cLat, mLng - cLng);
          if (d < bestDist) {
            bestDist = d;
            bestCenter = { lat: mLat, lng: mLng, ring: ring };
          }
        }
      }
      if (bestCenter) return bestCenter;
    }
    const near = window.FirewayGraphEngine.findNearestNode(
      index,
      v.center ? v.center[0] : 35.32,
      v.center ? v.center[1] : 128.26
    );
    if (near && near.node) {
      return { lat: near.node.lat, lng: near.node.lng, ring: null };
    }
    return v.center ? { lat: v.center[0], lng: v.center[1], ring: null } : null;
  }

  async function jumpToAnyVillage(v, autoDispatchTarget) {
    if (!v) return;
    const drop = document.getElementById('village-search-results');
    const input = document.getElementById('village-search');
    if (drop) drop.classList.add('hidden');
    if (input && !autoDispatchTarget) {
      input.value = `경상남도 의령군 ${v.eupName} ${v.name}마을`;
    }
    if (v.regionId && currentRegionCode !== v.regionId) {
      document.getElementById('region-select').value = v.regionId;
      await selectRegion(v.regionId, v.id);
    } else {
      document.getElementById('village-select').value = v.id;
      selectVillage(v.id, true);
    }

    const vObj = currentIndex && currentIndex.villageMap ? currentIndex.villageMap.get(v.id) : null;
    if (vObj) {
      const target = autoDispatchTarget || pickRepresentativeVillageTarget(currentIndex, vObj);
      if (target && Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
        lastSearchedAddress =
          (autoDispatchTarget && autoDispatchTarget.addressText) ||
          `경상남도 의령군 ${v.eupName} ${v.name}마을 중심 건축물`;
        ensureRouteSectionVisible();
        await dispatchMissionTo(target.lat, target.lng, target.ring || null, false);
      }
    }
  }

  function isPointInsideCatalogVillage(v, lat, lng, padDeg) {
    const b = (Array.isArray(v.docMapBounds) && v.docMapBounds.length === 4 ? v.docMapBounds : v.bbox) || null;
    if (!b) return false;
    const pad = Number.isFinite(Number(padDeg)) ? Number(padDeg) : 0.0008;
    return lat >= b[0] - pad && lng >= b[1] - pad && lat <= b[2] + pad && lng <= b[3] + pad;
  }

  function findCatalogVillageContainingPoint(lat, lng, preferredVid) {
    if (!catalog || !Array.isArray(catalog.villages)) return null;
    if (preferredVid) {
      const pv = catalog.villages.find((x) => x.id === preferredVid);
      if (pv && isPointInsideCatalogVillage(pv, lat, lng, 0.0012)) {
        return pv;
      }
    }
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < catalog.villages.length; i++) {
      const v = catalog.villages[i];
      if (isPointInsideCatalogVillage(v, lat, lng, 0.0008)) {
        const c = v.center || [lat, lng];
        const d = approxDistM(lat, lng, c[0], c[1]);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
    }
    return best;
  }

  async function searchVWorldAddressCandidates(rawQuery) {
    const q = (rawQuery || '').trim();
    if (!q || q.length < 2) return [];
    const fullQ = q.includes('의령') ? q : `경상남도 의령군 ${q}`;

    const calls = [
      vworldJsonp('https://api.vworld.kr/req/search', {
        service: 'search',
        request: 'search',
        version: '2.0',
        crs: 'EPSG:4326',
        size: '10',
        page: '1',
        query: fullQ,
        type: 'address',
        category: 'road',
        format: 'json'
      }),
      vworldJsonp('https://api.vworld.kr/req/search', {
        service: 'search',
        request: 'search',
        version: '2.0',
        crs: 'EPSG:4326',
        size: '10',
        page: '1',
        query: fullQ,
        type: 'address',
        category: 'parcel',
        format: 'json'
      }),
      vworldJsonp('https://api.vworld.kr/req/search', {
        service: 'search',
        request: 'search',
        version: '2.0',
        crs: 'EPSG:4326',
        size: '10',
        page: '1',
        query: fullQ,
        type: 'place',
        format: 'json'
      })
    ];

    const settled = await Promise.allSettled(calls);
    const items = [];
    const seen = new Set();

    settled.forEach((res, idx) => {
      if (res.status !== 'fulfilled') return;
      const list = res.value?.response?.result?.items || [];
      list.forEach((it) => {
        const lng = parseFloat(it.point?.x);
        const lat = parseFloat(it.point?.y);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const roadAddr = it.address?.road || '';
        const parcelAddr = it.address?.parcel || '';
        const title = (it.title || '').replace(/<[^>]+>/g, '').trim();
        const addrText = roadAddr || parcelAddr || title;
        if (!addrText) return;
        if (!addrText.includes('의령') && (lat < 35.15 || lat > 35.55 || lng < 128.05 || lng > 128.50)) {
          return;
        }
        const key = `${lat.toFixed(5)}_${lng.toFixed(5)}_${addrText}`;
        if (seen.has(key)) return;
        seen.add(key);

        const curV = getCurrentAnalyzedVillage();
        const matchedInIndex =
          currentIndex && window.FirewayGraphEngine && window.FirewayGraphEngine.findAnalyzedVillageForPoint
            ? window.FirewayGraphEngine.findAnalyzedVillageForPoint(currentIndex, lat, lng, curV ? curV.id : currentVillageId)
            : null;
        const inCurrentScope = Boolean(matchedInIndex && (!curV || matchedInIndex.id === curV.id));
        const matchedCatalogV = matchedInIndex || findCatalogVillageContainingPoint(lat, lng, curV ? curV.id : '');

        items.push({
          lat: lat,
          lng: lng,
          title: title || addrText,
          addressText: roadAddr && parcelAddr ? `${roadAddr} (${parcelAddr})` : addrText,
          kind: idx === 0 ? '도로명주소' : idx === 1 ? '지번주소' : '장소·건물',
          inCurrentScope: inCurrentScope,
          matchedVillage: matchedCatalogV
        });
      });
    });

    items.sort((a, b) => {
      if (a.inCurrentScope !== b.inCurrentScope) return a.inCurrentScope ? -1 : 1;
      if (Boolean(a.matchedVillage) !== Boolean(b.matchedVillage)) return a.matchedVillage ? -1 : 1;
      return 0;
    });

    return items;
  }

  function getLocalAnalyzedVillageBuildingCandidates(rawQuery) {
    if (!currentIndex || !Array.isArray(currentIndex.buildings)) return [];
    const curV = getCurrentAnalyzedVillage();
    const villagesToScan = [];
    if (curV) villagesToScan.push(curV);
    (currentIndex.villages || []).forEach((v) => {
      if (!curV || v.id !== curV.id) villagesToScan.push(v);
    });
    if (villagesToScan.length === 0) return [];

    const q = (rawQuery || '').trim();
    const qClean = q.replace(/^경상남도\s*의령군\s*/g, '').replace(/마을$/g, '').trim();
    const out = [];

    for (let vIdx = 0; vIdx < villagesToScan.length && out.length < 8; vIdx++) {
      const v = villagesToScan[vIdx];
      const bObj = window.FirewayGraphEngine.getVillageAnalyzedBounds(currentIndex, v);
      const b = bObj ? bObj.searchBounds : v.bbox;
      if (!b) continue;

      if (qClean && vIdx > 0) {
        const vMatch =
          v.name.includes(qClean) ||
          v.eupName.includes(qClean) ||
          `${v.eupName} ${v.name}`.includes(qClean) ||
          `#${qClean}` === qClean;
        if (!vMatch && out.length >= 4) continue;
      }

      for (let i = 0; i < currentIndex.buildings.length; i++) {
        const ring = currentIndex.buildings[i];
        if (!ring || ring.length === 0) continue;
        let latSum = 0;
        let lngSum = 0;
        for (let k = 0; k < ring.length; k++) {
          latSum += ring[k][0];
          lngSum += ring[k][1];
        }
        const mLat = latSum / ring.length;
        const mLng = lngSum / ring.length;
        if (mLat >= b[0] - 0.0006 && mLng >= b[1] - 0.0006 && mLat <= b[2] + 0.0006 && mLng <= b[3] + 0.0006) {
          const label = `경상남도 의령군 ${v.eupName} ${v.name}마을 건축물 #${i + 1}`;
          if (
            !qClean ||
            label.includes(qClean) ||
            v.name.includes(qClean) ||
            v.eupName.includes(qClean) ||
            `#${i + 1}` === qClean ||
            `${i + 1}` === qClean
          ) {
            out.push({
              lat: mLat,
              lng: mLng,
              ring: ring,
              addressText: label,
              title: `${v.eupName} ${v.name}마을 건축물 #${i + 1}`,
              inCurrentScope: Boolean(curV && curV.id === v.id),
              matchedVillage: v
            });
            if (out.length >= 8) break;
          }
        }
      }
    }
    return out;
  }

  async function resolveAndDispatchCandidatePoint(lat, lng, bldgRing, addressText, shouldFly) {
    let matchedV =
      currentIndex && window.FirewayGraphEngine && window.FirewayGraphEngine.findAnalyzedVillageForPoint
        ? window.FirewayGraphEngine.findAnalyzedVillageForPoint(currentIndex, lat, lng, currentVillageId)
        : null;
    const catV = findCatalogVillageContainingPoint(lat, lng, matchedV ? matchedV.id : currentVillageId);

    if (!matchedV && !catV) {
      showNudgeBanner(
        `⚠️ 검색하신 주소(${addressText || '선택 위치'})는 분석된 239개 마을 사각형 범위 밖입니다. 분석된 마을 범위 내에서만 경로를 탐색합니다.`,
        4500
      );
      return false;
    }

    if (!matchedV && catV) {
      if (catV.regionId && catV.regionId !== currentRegionCode) {
        const rSel = document.getElementById('region-select');
        if (rSel) rSel.value = catV.regionId;
        await selectRegion(catV.regionId, catV.id);
      }
      matchedV =
        (currentIndex && currentIndex.villageMap && currentIndex.villageMap.get(catV.id)) || catV;
    }

    if (matchedV && matchedV.id) {
      syncActiveVillageUI(matchedV.id);
      renderDocMapOverlay();
      if (shouldFly && map) {
        const targetBbox =
          matchedV.docMapBounds && matchedV.docMapBounds.length === 4 ? matchedV.docMapBounds : matchedV.bbox;
        if (targetBbox && targetBbox.length === 4) {
          map.flyToBounds([[targetBbox[0], targetBbox[1]], [targetBbox[2], targetBbox[3]]], {
            padding: [28, 28],
            maxZoom: 18,
            duration: 0.6
          });
        } else {
          map.flyTo([lat, lng], 17, { duration: 0.6 });
        }
      }
    }

    lastSearchedAddress = addressText || '';
    setRouteSelectStep('idle');
    ensureRouteSectionVisible();
    await dispatchMissionTo(lat, lng, bldgRing || null, false);
    return true;
  }

  async function executeAddressRouteSearch(rawQuery) {
    let q = (rawQuery || '').trim();
    const searchInput = document.getElementById('village-search');
    const drop = document.getElementById('village-search-results');
    if (drop) drop.classList.add('hidden');

    if (!q) {
      const sample = SAMPLE_SEARCH_ADDRESSES[Math.floor(Math.random() * SAMPLE_SEARCH_ADDRESSES.length)];
      q = sample.address;
      if (searchInput) {
        searchInput.value = sample.address;
      }
    }

    // 0. Check if query matches one of SAMPLE_SEARCH_ADDRESSES (ignoring spaces)
    const sampleHit = matchSampleSearchAddress(q);
    if (sampleHit) {
      if (searchInput && !searchInput.value.trim()) {
        searchInput.value = sampleHit.address;
      }
      lastSyncedSearchInputValue = (searchInput ? searchInput.value : sampleHit.address).trim();
      if (sampleHit.regionId && sampleHit.regionId !== currentRegionCode) {
        const rSel = document.getElementById('region-select');
        if (rSel) rSel.value = sampleHit.regionId;
        await selectRegion(sampleHit.regionId, sampleHit.villageId);
      } else if (sampleHit.villageId && sampleHit.villageId !== currentVillageId) {
        syncActiveVillageUI(sampleHit.villageId);
        renderDocMapOverlay();
      }

      let targetLat = sampleHit.lat;
      let targetLng = sampleHit.lng;
      let targetAddr = sampleHit.address;
      try {
        const addrItems = await searchVWorldAddressCandidates(q);
        const validAddrHit = addrItems.find((it) => it.inCurrentScope || it.matchedVillage);
        if (validAddrHit && Number.isFinite(validAddrHit.lat) && Number.isFinite(validAddrHit.lng)) {
          targetLat = validAddrHit.lat;
          targetLng = validAddrHit.lng;
          targetAddr = validAddrHit.addressText || sampleHit.address;
        }
      } catch (_) {}

      await resolveAndDispatchCandidatePoint(targetLat, targetLng, null, targetAddr, true);
      return;
    }

    // 1. Check live VWorld Address/Place search results across all 239 analyzed villages
    const addrItems = await searchVWorldAddressCandidates(q);
    const validAddrHit = addrItems.find((it) => it.inCurrentScope || it.matchedVillage);
    if (validAddrHit) {
      await resolveAndDispatchCandidatePoint(
        validAddrHit.lat,
        validAddrHit.lng,
        null,
        validAddrHit.addressText,
        true
      );
      return;
    }

    // 2. Check local building match inside the current region's analyzed villages
    const localBldgs = getLocalAnalyzedVillageBuildingCandidates(q);
    if (localBldgs.length > 0) {
      const bHit = localBldgs[0];
      await resolveAndDispatchCandidatePoint(bHit.lat, bHit.lng, bHit.ring || null, bHit.addressText, true);
      return;
    }

    // 3. Check if query matches one of the 239 analyzed villages directly
    const qClean = q.replace(/^경상남도\s*의령군\s*/g, '').replace(/마을$/g, '').trim();
    if (catalog && Array.isArray(catalog.villages) && qClean) {
      const vHit = catalog.villages.find(
        (v) =>
          v.name === qClean ||
          `${v.eupName} ${v.name}` === qClean ||
          v.name.includes(qClean) ||
          `${v.eupName} ${v.name}`.includes(qClean)
      );
      if (vHit) {
        await jumpToAnyVillage(vHit, null);
        return;
      }
    }

    // 4. If VWorld found an address in Uiryeong-gun outside all 239 analyzed villages:
    if (addrItems.length > 0) {
      const firstAddr = addrItems[0];
      showNudgeBanner(
        `⚠️ 검색하신 주소(${firstAddr.addressText})는 분석된 239개 마을 사각형 범위 밖입니다. 분석된 마을 범위 내에서만 경로를 탐색합니다.`,
        4500
      );
      return;
    }

    showNudgeBanner(
      `⚠️ '${q}'에 해당하는 의령군 239개 분석 마을 내 주소를 찾지 못했습니다. 도로명·지번 주소 또는 마을명을 확인해 주세요.`,
      3800
    );
  }

  function setupSearchBox() {
    const input = document.getElementById('village-search');
    const drop = document.getElementById('village-search-results');
    const btnAddr = document.getElementById('btn-address-search');
    let searchDebounce = null;
    let searchSeq = 0;

    async function renderDropdownList(rawQuery) {
      if (!catalog || !Array.isArray(catalog.villages)) return;
      const mySeq = ++searchSeq;
      const q = (rawQuery || '').trim();
      const qClean = q.replace(/^경상남도\s*의령군\s*/g, '').replace(/마을$/g, '').trim();
      const curV = getCurrentAnalyzedVillage();

      drop.innerHTML = '';

      // 0) 예시 화점 주소 2곳 선택 섹션 (상시 노출)
      const sampleHeader = document.createElement('div');
      sampleHeader.className = 'search-header-bar sample-search-header';
      sampleHeader.innerHTML =
        '<span>📍 예시 화점 주소 선택 (직접 입력 또는 아래 2곳 중 선택)</span><span>클릭 시 즉시 경로탐색</span>';
      drop.appendChild(sampleHeader);

      SAMPLE_SEARCH_ADDRESSES.forEach((sample) => {
        const sRow = document.createElement('div');
        sRow.className = 'search-item sample-search-item';
        sRow.dataset.sampleAddress = sample.address;
        sRow.innerHTML = `<strong>🏠 ${sample.address}</strong><span class="search-item-eup">예시 마을 · 즉시 경로탐색</span>`;
        sRow.addEventListener('click', async () => {
          ++searchSeq;
          if (searchDebounce) clearTimeout(searchDebounce);
          drop.classList.add('hidden');
          input.value = sample.address;
          await executeAddressRouteSearch(sample.address);
        });
        drop.appendChild(sRow);
      });

      // 기존 3대 검색 목록 섹션은 폐기하지 않고 숨김 컨테이너(legacyWrap) 내부에 보존
      const legacyWrap = document.createElement('div');
      legacyWrap.className = 'legacy-search-sections hidden';
      legacyWrap.dataset.legacySearchDropdown = 'true';
      drop.appendChild(legacyWrap);

      drop.classList.remove('hidden');

      // 1) 분석된 마을 내 건물/주소 즉시 후보 표시 (보존·숨김)
      const localBldgs = getLocalAnalyzedVillageBuildingCandidates(qClean);
      if (localBldgs.length > 0) {
        const curHeader = document.createElement('div');
        curHeader.className = 'search-header-bar';
        const headerLabel = curV
          ? `📐 분석 마을 (${curV.eupName} ${curV.name}마을 등) 범위 내 화점 주소`
          : `📐 현재 읍·면 분석 마을 범위 내 화점 주소`;
        curHeader.innerHTML = `<span>${headerLabel}</span><span>클릭 시 즉시 경로탐색</span>`;
        legacyWrap.appendChild(curHeader);

        localBldgs.slice(0, 4).forEach((bItem) => {
          const row = document.createElement('div');
          row.className = 'search-item';
          row.innerHTML = `<strong>🏠 ${bItem.title}</strong><span class="search-item-eup">분석마을 내 · 경로탐색</span>`;
          row.addEventListener('click', async () => {
            drop.classList.add('hidden');
            input.value = bItem.addressText;
            await resolveAndDispatchCandidatePoint(bItem.lat, bItem.lng, bItem.ring || null, bItem.addressText, true);
          });
          legacyWrap.appendChild(row);
        });
      }

      // 2) 검색어가 2글자 이상이면 VWorld 실시간 도로명·지번·건물 주소 검색 결과 병합 (보존·숨김)
      if (qClean.length >= 2) {
        const addrItems = await searchVWorldAddressCandidates(q);
        if (mySeq !== searchSeq) return;
        if (addrItems.length > 0) {
          const addrHeader = document.createElement('div');
          addrHeader.className = 'search-header-bar';
          addrHeader.innerHTML = `<span>📍 도로명·지번 주소 검색 결과 ('${q}')</span><span>${addrItems.length}건</span>`;
          legacyWrap.appendChild(addrHeader);

          addrItems.slice(0, 8).forEach((item) => {
            const row = document.createElement('div');
            row.className = 'search-item';
            let scopeTag = '<span class="search-item-eup" style="color:#ef4444">239개 분석마을 범위 밖 (탐색불가)</span>';
            if (item.inCurrentScope && curV) {
              scopeTag = `<span class="search-item-eup" style="color:#16a34a">✓ ${curV.eupName} ${curV.name}마을 내 · 경로탐색</span>`;
            } else if (item.matchedVillage) {
              scopeTag = `<span class="search-item-eup" style="color:#16a34a">✓ ${item.matchedVillage.eupName} ${item.matchedVillage.name}마을 범위 내 · 경로탐색</span>`;
            }
            row.innerHTML = `<div><strong>${item.addressText}</strong> <small class="muted-text">[${item.kind}]</small></div>${scopeTag}`;
            row.addEventListener('click', async () => {
              drop.classList.add('hidden');
              input.value = item.addressText;
              if (item.inCurrentScope || item.matchedVillage) {
                await resolveAndDispatchCandidatePoint(item.lat, item.lng, null, item.addressText, true);
              } else {
                showNudgeBanner(
                  `⚠️ 선택한 주소(${item.addressText})는 분석된 239개 마을 사각형 범위 밖입니다. 분석된 마을 범위 내에서만 경로를 탐색합니다.`,
                  4500
                );
              }
            });
            legacyWrap.appendChild(row);
          });
        }
      }

      // 3) 분석 대상 마을(239개) 검색 결과 (보존·숨김)
      let matches;
      if (!qClean) {
        const curList = catalog.villages.filter((v) => v.regionId === currentRegionCode);
        const otherList = catalog.villages.filter((v) => v.regionId !== currentRegionCode);
        matches = [...curList, ...otherList];
      } else {
        matches = catalog.villages.filter(
          (v) =>
            v.name.includes(qClean) ||
            v.eupName.includes(qClean) ||
            `${v.eupName} ${v.name}`.includes(qClean) ||
            `${v.name}마을`.includes(qClean)
        );
      }

      const vHeader = document.createElement('div');
      vHeader.className = 'search-header-bar';
      vHeader.innerHTML = qClean
        ? `<span>🏘 분석 마을 검색 ('${qClean}')</span><span>${matches.length}개 마을</span>`
        : `<span>🏘 의령군 239개 분석 마을 목록 (선택 시 해당 마을 범위로 이동 및 경로탐색)</span><span>총 ${matches.length}개</span>`;
      legacyWrap.appendChild(vHeader);

      matches.slice(0, 60).forEach((v) => {
        const row = document.createElement('div');
        row.className = 'search-item' + (v.id === currentVillageId ? ' active' : '');
        row.innerHTML = `<strong>경상남도 의령군 ${v.eupName} ${v.name}마을</strong><span class="search-item-eup">🔶 경로 찾기</span>`;
        row.addEventListener('click', () => {
          jumpToAnyVillage(v, null);
        });
        legacyWrap.appendChild(row);
      });
    }

    setSearchButtonMode('search');

    input.addEventListener('focus', () => {
      renderDropdownList(input.value);
    });

    input.addEventListener('click', () => {
      renderDropdownList(input.value);
    });

    input.addEventListener('input', () => {
      if (
        (searchActionState === 'reset' || (btnAddr && btnAddr.dataset.mode === 'reset')) &&
        input.value.trim() !== lastSyncedSearchInputValue
      ) {
        setSearchButtonMode('search');
      }
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        renderDropdownList(input.value);
      }, 180);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ++searchSeq;
        if (searchDebounce) clearTimeout(searchDebounce);
        drop.classList.add('hidden');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        ++searchSeq;
        if (searchDebounce) clearTimeout(searchDebounce);
        executeAddressRouteSearch(input.value);
      }
    });

    if (btnAddr) {
      btnAddr.addEventListener('click', () => {
        if (searchActionState === 'reset' || btnAddr.dataset.mode === 'reset') {
          resetCustomStart();
          return;
        }
        if (input.value.trim() === '') {
          const sample = SAMPLE_SEARCH_ADDRESSES[Math.floor(Math.random() * SAMPLE_SEARCH_ADDRESSES.length)];
          input.value = sample.address;
          executeAddressRouteSearch(sample.address);
          return;
        }
        executeAddressRouteSearch(input.value);
      });
    }

    document.addEventListener('click', (e) => {
      if (
        !input.contains(e.target) &&
        !drop.contains(e.target) &&
        (!btnAddr || !btnAddr.contains(e.target))
      ) {
        drop.classList.add('hidden');
      }
    });
  }

  async function selectRegion(regionCode, targetVillageId) {
    currentRegionCode = regionCode;
    currentVillageId = targetVillageId || '';
    customStartPoint = null;
    lastMission = null;
    lastRouteApiResult = null;
    lastExternalTargetCache = null;
    if (missionLayerGroup) missionLayerGroup.clearLayers();
    if (trunkRouteLayerGroup) trunkRouteLayerGroup.clearLayers();
    setRouteSelectStep('idle');
    setLoading(true, `${regionCode} 도로망 그래프 로드 중...`);

    if (!graphCache.has(regionCode)) {
      let rawData = null;
      if (window.__INLINE_BUNDLE__ && window.__INLINE_BUNDLE__.graphs && window.__INLINE_BUNDLE__.graphs[regionCode]) {
        rawData = window.__INLINE_BUNDLE__.graphs[regionCode];
      } else {
        const resp = await fetch(`./data/graphs/${regionCode}.json`);
        rawData = await resp.json();
      }
      const idx = window.FirewayGraphEngine.buildGraphIndex(rawData);
      graphCache.set(regionCode, idx);
    }

    currentIndex = graphCache.get(regionCode);
    populateVillageUI(currentIndex.villages || []);

    const validVid =
      currentVillageId && currentIndex.villageMap.has(currentVillageId)
        ? currentVillageId
        : '';

    if (validVid) {
      document.getElementById('village-select').value = validVid;
      selectVillage(validVid, true);
    } else {
      currentVillageId = '';
      document.getElementById('village-select').value = '';
      selectVillage('', false);
      const b = currentIndex.bbox;
      if (b && b.length === 4) {
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: [20, 20] });
      }
    }

    setLoading(false);
  }

  function selectVillage(villageId, flyTo) {
    currentVillageId = villageId || '';
    customStartPoint = null;
    lastMission = null;
    lastRouteApiResult = null;
    lastExternalTargetCache = null;
    lastSearchedAddress = '';
    if (missionLayerGroup) missionLayerGroup.clearLayers();
    if (trunkRouteLayerGroup) trunkRouteLayerGroup.clearLayers();
    setRouteSelectStep('idle');
    syncActiveVillageUI(currentVillageId);

    if (currentVillageId && currentIndex && currentIndex.villageMap.has(currentVillageId)) {
      const v = currentIndex.villageMap.get(currentVillageId);
      const targetBbox = v.docMapBounds && v.docMapBounds.length === 4 ? v.docMapBounds : v.bbox;
      if (flyTo && targetBbox && targetBbox.length === 4) {
        map.flyToBounds([[targetBbox[0], targetBbox[1]], [targetBbox[2], targetBbox[3]]], {
          padding: [28, 28],
          maxZoom: 18,
          duration: 0.6
        });
      }
    } else if (currentIndex) {
      if (flyTo && currentIndex.bbox) {
        const b = currentIndex.bbox;
        map.flyToBounds([[b[0], b[1]], [b[2], b[3]]], { padding: [20, 20], duration: 0.6 });
      }
    }

    refreshNetworkAndLayers();
  }

  function updateVehicleSpecBar() {
    const spec = window.FirewayGraphEngine.getVehicleSpec(currentThreshold);
    const bar = document.getElementById('vehicle-spec-bar');
    if (bar && spec) {
      bar.textContent =
        `${spec.name} | 차폭 ${spec.widthM}m (기준 ${spec.threshold}m) · 전장 ${spec.lengthM}m · 축거 ${spec.wheelbaseM}m · 최소회전반경 ${spec.minTurnRadiusM}m · 90° 회전 가산 +${spec.extra90M}m`;
    }
  }

  function refreshNetworkAndLayers() {
    if (!currentIndex) return;
    updateVehicleSpecBar();

    currentNetEval = window.FirewayGraphEngine.evaluateNetwork(currentIndex, {
      threshold: currentThreshold,
      mode: 'vworld_api',
      villageId: currentVillageId || null
    });

    const sum = currentNetEval.summary;
    const elTotalLen = document.getElementById('stat-total-len');
    if (elTotalLen) elTotalLen.textContent = `${(sum.totalLengthM / 1000).toFixed(2)} km`;
    const elPassable = document.getElementById('stat-passable');
    if (elPassable) elPassable.textContent = `${sum.passableCount} 구간`;
    const elBlocked = document.getElementById('stat-blocked');
    if (elBlocked) elBlocked.textContent = `${sum.blockedCount} 구간`;
    const elTurnBlocked = document.getElementById('stat-turn-blocked');
    if (elTurnBlocked) elTurnBlocked.textContent = `${sum.turnBlockedCount} 개소`;

    renderMapLayers();
    updateStartPointUI();
    renderStartMarker();

    if (lastMission && lastMission.targetLat && lastMission.targetLng) {
      dispatchMissionTo(lastMission.targetLat, lastMission.targetLng, null, true);
    }
  }

  function formatDataSourceKo(src) {
    const s = String(src || '');
    if (s.includes('sat')) return '위성 Mask2Former 실측 + VWorld';
    if (s.includes('vworld')) return 'VWorld 국가공간정보 도로망';
    return s || '방식 B 하이브리드';
  }

  function buildNaverPopupHtml(opts) {
    const badgeClass = opts.badgeClass || 'info';
    const cellsHtml = (opts.cells || [])
      .map(
        (c) => `
        <div class="naver-popup-cell${c.full ? ' full' : ''}">
          <span class="naver-popup-label">${c.label}</span>
          <strong class="naver-popup-val">${c.value}</strong>
        </div>`
      )
      .join('');

    const actionsHtml =
      opts.customActionsHtml !== undefined
        ? opts.customActionsHtml
        : `
      <div class="naver-popup-actions">
        <button type="button" class="naver-popup-btn btn-target full" data-popup-action="set-target">
          🔴 여기로 경로 찾기
        </button>
      </div>`;

    return `
      <div class="naver-popup">
        <div class="naver-popup-header">
          <div class="naver-popup-top-row">
            <span class="naver-popup-cat">${opts.category || '도로 링크'}</span>
            <span class="naver-popup-badge ${badgeClass}">${opts.badgeText || '정보'}</span>
          </div>
          <div class="naver-popup-title">${opts.title || ''}</div>
          ${opts.subtitle ? `<div class="naver-popup-sub">${opts.subtitle}</div>` : ''}
        </div>
        ${cellsHtml ? `<div class="naver-popup-grid">${cellsHtml}</div>` : ''}
        ${actionsHtml}
      </div>`;
  }

  function openNaverInfoPopup(lat, lng, opts, bldgRing) {
    if (!map) return;
    const html = buildNaverPopupHtml(opts);
    const popup = L.popup({
      maxWidth: 320,
      minWidth: 290,
      autoPanPadding: [24, 24],
      closeButton: true
    })
      .setLatLng([lat, lng])
      .setContent(html);

    popup.on('add', () => {
      const el = popup.getElement();
      if (!el) return;
      const btnTarget = el.querySelector('[data-popup-action="set-target"]');
      if (btnTarget) {
        btnTarget.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          map.closePopup(popup);
          handleMapOrLayerClick(lat, lng, bldgRing || null);
        });
      }
      const btnCopy = el.querySelector('[data-popup-action="copy-deeplink"]');
      if (btnCopy) {
        btnCopy.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const url = btnCopy.getAttribute('data-copy-url') || '';
          try {
            await navigator.clipboard.writeText(url);
            btnCopy.textContent = '✓ 딥링크 복사 완료';
          } catch (_) {
            btnCopy.textContent = '✓ 스킴 준비됨';
          }
        });
      }
      const btnTmapApi = el.querySelector('[data-popup-action="run-tmap-api"]');
      if (btnTmapApi) {
        btnTmapApi.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          map.closePopup(popup);
          if (lastMission && lastMission.found) {
            requestAndRenderExternalRoute(lastMission, 'tmap');
          }
        });
      }
    });

    popup.openOn(map);
  }

  function renderMapLayers() {
    roadLayerGroup.clearLayers();
    buildingLayerGroup.clearLayers();
    hydrantLayerGroup.clearLayers();
    nodeLayerGroup.clearLayers();

    const showRoads = document.getElementById('chk-layer-roads').checked;
    const showBuildings = document.getElementById('chk-layer-buildings').checked;
    const showHydrants = document.getElementById('chk-layer-hydrants').checked;
    const showNodes = document.getElementById('chk-layer-nodes').checked;
    const passEl = document.getElementById('chk-layer-pass');
    const showPass = passEl ? passEl.checked : false;

    if (showBuildings && currentIndex.buildings) {
      currentIndex.buildings.forEach((ring, bIdx) => {
        const poly = L.polygon(ring, {
          color: '#64748b',
          weight: 1,
          fillColor: '#38bdf8',
          fillOpacity: 0.18
        });
        poly.bindTooltip(
          `<strong>🏢 건축물 #${bIdx + 1}</strong> · 클릭하여 건물 정보 및 출동 경로 탐색`,
          { sticky: true }
        );
        poly.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (routeSelectStep === 'pick_start') {
            handleMapOrLayerClick(e.latlng.lat, e.latlng.lng, null);
            return;
          }
          const center = poly.getBounds().getCenter();
          if (routeSelectStep === 'pick_target') {
            handleMapOrLayerClick(center.lat, center.lng, ring);
            return;
          }
          openNaverInfoPopup(
            center.lat,
            center.lng,
            {
              category: `건축물 #${bIdx + 1}`,
              badgeClass: 'info',
              badgeText: 'VWorld 건물 폴리곤',
              title: '선택 건축물 출동·진입 판정',
              subtitle: `중심좌표 ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`,
              cells: [
                { label: '출동 기준 차량폭', value: `${currentThreshold}m` },
                { label: '건축물대장 조회', value: '화점 탐색 시 자동 조회' }
              ]
            },
            ring
          );
        });
        poly.on('contextmenu', (e) => {
          L.DomEvent.stopPropagation(e);
          setExactStartPoint(e.latlng.lat, e.latlng.lng);
          setRouteSelectStep('pick_target');
        });
        buildingLayerGroup.addLayer(poly);
      });
    }

    if (showRoads && currentNetEval) {
      const drawnLinkSet = new Set();
      currentIndex.paths.forEach((edge, i) => {
        const stObj = currentNetEval.pathStatuses[i];
        const key = `${edge.linkId}_${stObj.status}`;
        if (drawnLinkSet.has(key)) return;
        drawnLinkSet.add(key);

        let color = '#eab308';
        let weight = 3.2;
        let dashArray = null;
        let statusKo = '폭 모름';
        let badgeClass = 'info';
        let badgeText = '● 폭 모름';

        if (stObj.status === 'passable' && !showPass) return;
        if (stObj.status === 'passable') {
          color = '#22c55e';
          weight = 3.8;
          statusKo = '차량 진입 가능';
          badgeClass = 'pass';
          badgeText = '● 차량 진입 가능';
        } else if (stObj.status === 'blocked_turn') {
          color = '#ef4444';
          weight = 4.2;
          statusKo = `회전반경 부족 차단 (${stObj.turnInfo ? stObj.turnInfo.turnAngleDeg + '° 코너 유효폭 ' + stObj.turnInfo.cornerWidthM + 'm < 요구 ' + stObj.turnInfo.requiredCornerWidthM + 'm' : ''})`;
          badgeClass = 'turn';
          badgeText = '▲ 회전반경 부족 차단';
        } else if (stObj.status === 'blocked_width') {
          color = '#ef4444';
          weight = 3.4;
          statusKo = `도로 폭 부족 (${stObj.widthM}m < ${currentThreshold}m)`;
          badgeClass = 'block';
          badgeText = '■ 도로 폭 부족';
        } else if (stObj.status === 'disconnected') {
          color = '#ef4444';
          weight = 3.0;
          dashArray = '5,5';
          statusKo = '선행 병목으로 인한 진입 단절';
          badgeClass = 'block';
          badgeText = '◆ 선행 병목 단절';
        }

        const line = L.polyline(edge.coords, {
          color: color,
          weight: weight,
          opacity: 0.88,
          dashArray: dashArray,
          fwBaseW: weight,
          fwWidthM: stObj.widthM != null ? Number(stObj.widthM) : null
        });
        line.setStyle({ weight: roadPxWeight(line.options) });

        const wLabel = stObj.widthM !== null ? `${stObj.widthM}m` : '미상';
        line.bindTooltip(
          `<strong>[${statusKo}]</strong> 도로 링크 #${edge.linkId}<br/>유효폭: <strong>${wLabel}</strong> (기준 ${currentThreshold}m) · 연장: <strong>${edge.lengthM}m</strong><br/><span style="color:#03c75a;font-weight:700">클릭하여 상세 제원 팝업 및 출발·화점 지정</span>`,
          { sticky: true }
        );
        line.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (routeSelectStep !== 'idle') {
            handleMapOrLayerClick(e.latlng.lat, e.latlng.lng, null);
            return;
          }
          const cells = [
            { label: '유효 도로폭 / 기준폭', value: `${wLabel} / ${currentThreshold}m` },
            { label: '구간 연장', value: `${edge.lengthM} m` },
            { label: '진입폭 / 진출폭', value: `${edge.ew ?? wLabel} / ${edge.xw ?? wLabel}` },
            { label: '연결 정점 (시점→종점)', value: `${edge.u || '-'} → ${edge.v || '-'}` }
          ];
          if (stObj.turnInfo) {
            cells.push({
              label: '아커만 회전반경 판정',
              value: `${stObj.turnInfo.turnAngleDeg}° 교차 코너 유효폭 ${stObj.turnInfo.cornerWidthM}m (요구 ${stObj.turnInfo.requiredCornerWidthM}m)`,
              full: true
            });
          }
          cells.push({
            label: '도로폭 산출 출처',
            value: formatDataSourceKo(edge.source),
            full: true
          });

          openNaverInfoPopup(e.latlng.lat, e.latlng.lng, {
            category: `도로 링크 #${edge.linkId}`,
            badgeClass: badgeClass,
            badgeText: badgeText,
            title: `유효폭 ${wLabel} · 연장 ${edge.lengthM}m`,
            subtitle: statusKo,
            cells: cells
          });
        });
        line.on('contextmenu', (e) => {
          L.DomEvent.stopPropagation(e);
          setExactStartPoint(e.latlng.lat, e.latlng.lng);
          setRouteSelectStep('pick_target');
        });
        roadLayerGroup.addLayer(line);
      });
    }

    // 실제 소화전(농골길 책자 좌표) — 소화전 아이콘
    if (showHydrants && REAL_HYDRANTS.length) {
      REAL_HYDRANTS.forEach((h) => {
        const mk = L.marker([h[0], h[1]], {
          icon: L.divIcon({ className: 'fw-hydrant-icon', html: HYDRANT_SVG, iconSize: [20, 20], iconAnchor: [10, 18] })
        });
        mk.bindTooltip(`<strong>소화전</strong> ${h[2] || ''}<br>${h[3] || ''}`, { direction: 'top', offset: [0, -14] });
        hydrantLayerGroup.addLayer(mk);
      });
    }

    // 중계급수 후보(실제 소화전 아님)는 지도 표시 생략 — 전술 계산에만 사용
    if (false && showHydrants && currentIndex.hydrants) {
      currentIndex.hydrants.forEach((h, hIdx) => {
        const rawLabel = String(h[2] || '소화전');
        const isSyntheticStaging = /^(거점소화전|중계급수거점)-/.test(rawLabel);
        const displayLabel = isSyntheticStaging
          ? rawLabel.replace(/^거점소화전-/, '중계급수거점-')
          : rawLabel;
        const marker = isSyntheticStaging
          ? L.circleMarker([h[0], h[1]], { radius: 5, color: '#fff', weight: 1.5, fillColor: '#3b82f6', fillOpacity: 0.95 })
          : L.marker([h[0], h[1]], {
              icon: L.divIcon({ className: 'fw-hydrant-icon', html: HYDRANT_SVG, iconSize: [20, 20], iconAnchor: [10, 18] })
            });
        marker.bindTooltip(
          isSyntheticStaging
            ? `<strong>🚛 물탱크차 중계급수 후보 거점 (실물 소화전 미확인):</strong> ${displayLabel}`
            : `<strong>🧯 소화용수:</strong> ${displayLabel} (클릭하여 상세 보기)`,
          { direction: 'top' }
        );
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (routeSelectStep !== 'idle') {
            handleMapOrLayerClick(h[0], h[1], null);
            return;
          }
          openNaverInfoPopup(h[0], h[1], {
            category: isSyntheticStaging ? `중계급수 후보 교차로 #${hIdx + 1}` : `소화용수 거점 #${hIdx + 1}`,
            badgeClass: isSyntheticStaging ? 'turn' : 'info',
            badgeText: isSyntheticStaging ? '🚛 중계급수 후보 거점 (실물 소화전 미확인)' : '🧯 소방용수시설',
            title: displayLabel,
            subtitle: `좌표 ${Number(h[0]).toFixed(5)}, ${Number(h[1]).toFixed(5)}`,
            cells: [
              {
                label: '시설 구분',
                value: isSyntheticStaging
                  ? '광폭(≥4.0m) 교차로 물탱크차 중계급수 후보 거점 (실물 소화전 미확인)'
                  : '지상식 소화전 / 급수탑'
              },
              {
                label: '전술 활용',
                value: isSyntheticStaging
                  ? '후착 물탱크차 정차 및 중계 급수 전개 거점'
                  : '하차 거점 인근 소화전 점령 방수'
              }
            ]
          });
        });
        hydrantLayerGroup.addLayer(marker);
      });
    }

    if (showNodes && currentIndex.nodes) {
      currentIndex.nodes.forEach((n) => {
        const c = n.type === 'intersection' ? '#38bdf8' : n.type === 'dead_end' ? '#f43f5e' : '#a855f7';
        const typeKo =
          n.type === 'intersection'
            ? '교차로 정점 (X)'
            : n.type === 'dead_end'
            ? '막다른길 끝점 (D)'
            : '폭원 전환 정점 (T)';
        const m = L.circleMarker([n.lat, n.lng], {
          radius: 3.5,
          color: c,
          weight: 1,
          fillColor: c,
          fillOpacity: 0.85
        });
        m.bindTooltip(`<strong>${typeKo}</strong> ${n.id} · 최소폭 ${n.minWidthM ?? '-'}m`);
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (routeSelectStep !== 'idle') {
            handleMapOrLayerClick(n.lat, n.lng, null);
            return;
          }
          openNaverInfoPopup(n.lat, n.lng, {
            category: `도로망 정점 ${n.id}`,
            badgeClass: n.type === 'dead_end' ? 'block' : 'info',
            badgeText: typeKo,
            title: `정점 ${n.id} (${typeKo})`,
            subtitle: `좌표 ${n.lat.toFixed(5)}, ${n.lng.toFixed(5)}`,
            cells: [
              { label: '접속 도로 최소폭', value: `${n.minWidthM ?? '-'} m` },
              { label: '정점 유형', value: n.type }
            ]
          });
        });
        m.on('contextmenu', (e) => {
          L.DomEvent.stopPropagation(e);
          setExactStartPoint(n.lat, n.lng);
          setRouteSelectStep('pick_target');
        });
        nodeLayerGroup.addLayer(m);
      });
      if (!map.hasLayer(nodeLayerGroup)) map.addLayer(nodeLayerGroup);
    } else if (map.hasLayer(nodeLayerGroup)) {
      map.removeLayer(nodeLayerGroup);
    }

    renderDocMapOverlay();
    renderDiagLayers();
  }

  function renderDocMapOverlay() {
    if (!docMapLayerGroup) return;
    docMapLayerGroup.clearLayers();
    if (!currentIndex) return;

    const chk = document.getElementById('chk-layer-doc-rect');
    if (chk && !chk.checked) return;

    const villages = currentIndex.villages || [];
    villages.forEach((v) => {
      if (!v.docMapBounds || v.docMapBounds.length !== 4) return;
      const isSelected = Boolean(currentVillageId && v.id === currentVillageId);

      const [south, west, north, east] = v.docMapBounds;
      const rectCoords =
        v.docMapCorners && v.docMapCorners.NW && v.docMapCorners.NE && v.docMapCorners.SE && v.docMapCorners.SW
          ? [v.docMapCorners.NW, v.docMapCorners.NE, v.docMapCorners.SE, v.docMapCorners.SW]
          : [
              [north, west],
              [north, east],
              [south, east],
              [south, west]
            ];

      const rectPoly = L.polygon(rectCoords, {
        color: isSelected ? '#f97316' : '#fb923c',
        weight: isSelected ? 3.0 : 2.0,
        opacity: isSelected ? 0.96 : 0.78,
        dashArray: isSelected ? '8, 5' : '5, 5',
        fillColor: '#f97316',
        fillOpacity: isSelected ? 0.08 : 0.03,
        interactive: true
      });

      rectPoly.bindTooltip(
        `<strong>📐 ${v.eupName} ${v.name}마을</strong> (${isSelected ? '현재 선택 마을 · ' : ''}클릭 시 화점 지정 및 경로탐색)`,
        { sticky: true }
      );
      rectPoly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        handleMapOrLayerClick(e.latlng.lat, e.latlng.lng, null);
      });
      rectPoly.on('contextmenu', (e) => {
        L.DomEvent.stopPropagation(e);
        handleMapOrLayerClick(e.latlng.lat, e.latlng.lng, null);
      });
      docMapLayerGroup.addLayer(rectPoly);

      // Render permanent entrance badge only for the selected village to prevent clutter
      if (isSelected && v.docEntrance && v.docEntrance.lat && v.docEntrance.lng) {
        const entList =
          Array.isArray(v.docEntrance.allEntrances) && v.docEntrance.allEntrances.length > 0
            ? v.docEntrance.allEntrances
            : [
                {
                  index: 1,
                  road_lat_lng: [v.docEntrance.lat, v.docEntrance.lng],
                  badge_lat_lng: [v.docEntrance.badgeLat || v.docEntrance.lat, v.docEntrance.badgeLng || v.docEntrance.lng],
                  ncc: v.docEntrance.nccScore || 0.78
                }
              ];

        entList.forEach((entItem, eIdx) => {
          const rLat = entItem.road_lat_lng ? entItem.road_lat_lng[0] : v.docEntrance.lat;
          const rLng = entItem.road_lat_lng ? entItem.road_lat_lng[1] : v.docEntrance.lng;
          const labelSuffix = entList.length > 1 ? ` #${eIdx + 1}` : '';

          const entMarker = L.marker([rLat, rLng], {
            icon: L.divIcon({
              className: 'doc-entrance-div-icon',
              html: `<div class="doc-entrance-badge">${v.name} 진입점${labelSuffix}</div>`,
              iconSize: [82, 26],
              iconAnchor: [41, 13]
            })
          });

          entMarker.bindTooltip(
            `<strong>🔶 ${v.eupName} ${v.name}마을 대표 진입점${labelSuffix}</strong> (클릭 시 상세 보기)`,
            { direction: 'top' }
          );

          entMarker.on('contextmenu', (e) => {
            L.DomEvent.stopPropagation(e);
            handleMapOrLayerClick(rLat, rLng, null);
          });

          entMarker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            if (routeSelectStep !== 'idle') {
              handleMapOrLayerClick(rLat, rLng, null);
              return;
            }
            openNaverInfoPopup(rLat, rLng, {
              category: `${v.eupName} ${v.name}마을 · 대표 진입점`,
              badgeClass: 'turn',
              badgeText: `🔶 마을 진입점${labelSuffix}`,
              title: `${v.eupName} ${v.name}마을 도로망 진입 지점`,
              subtitle: `도로 스냅 좌표 (${Number(rLat).toFixed(5)}, ${Number(rLng).toFixed(5)})`,
              cells: [
                { label: '대상 마을', value: `${v.eupName} ${v.name}마을` },
                { label: '경로 전환 방식', value: '소방서→마을 입구 T맵, 마을 안 골목 판정' }
              ]
            });
          });

          docMapLayerGroup.addLayer(entMarker);
        });
      }
    });
  }

  async function renderDiagLayers() {
    if (!diagLayerGroup) return;
    diagLayerGroup.clearLayers();
    const chkRaw = document.getElementById('chk-diag-raw');
    const chkSat = document.getElementById('chk-diag-sat');
    const chkSplits = document.getElementById('chk-diag-splits');
    const showRaw = Boolean(chkRaw && chkRaw.checked);
    const showSat = Boolean(chkSat && chkSat.checked);
    const showSplits = Boolean(chkSplits && chkSplits.checked);

    if (!showRaw && !showSat && !showSplits) return;
    if (!currentRegionCode) return;

    if (!diagCache.has(currentRegionCode)) {
      setLoading(true, '정밀 진단 레이어 온디맨드 로드 중...');
      try {
        const resp = await fetch(`./data/graphs/${currentRegionCode}_diag.json`);
        if (!resp.ok) throw new Error('Diag fetch status ' + resp.status);
        diagCache.set(currentRegionCode, await resp.json());
      } catch (_) {
        const rawFallback = (currentIndex.paths || []).map((p) => [
          p.linkId,
          '',
          p.mw,
          '',
          p.mw,
          p.source,
          p.coords
        ]);
        const satFallback = (currentIndex.paths || [])
          .filter((p) => p.source && p.source.includes('sat'))
          .map((p) => [p.linkId, p.mw, p.coords]);
        diagCache.set(currentRegionCode, {
          code: currentRegionCode,
          rawCenterlines: rawFallback,
          imageEstimates: satFallback,
          mergedSplits: []
        });
      }
      setLoading(false);
    }

    const diag = diagCache.get(currentRegionCode);
    if (showRaw && diag.rawCenterlines) {
      diag.rawCenterlines.forEach((row) => {
        const poly = L.polyline(row[6], {
          color: '#cbd5e1',
          weight: 2.2,
          dashArray: '3,4',
          opacity: 0.85
        });
        poly.bindTooltip(`원시링크 #${row[0]} · WFS폭 ${row[2] ?? '-'}m · 방식B폭 ${row[4] ?? '-'}m (${row[5]})`);
        poly.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (routeSelectStep !== 'idle') {
            handleMapOrLayerClick(e.latlng.lat, e.latlng.lng, null);
            return;
          }
          openNaverInfoPopup(e.latlng.lat, e.latlng.lng, {
            category: `원시 중심선 #${row[0]}`,
            badgeClass: 'info',
            badgeText: 'VWorld WFS 원시 링크',
            title: `방식 B 보정폭 ${row[4] ?? '-'}m (원시 ${row[2] ?? '-'}m)`,
            subtitle: `데이터 출처: ${formatDataSourceKo(row[5])}`,
            cells: [
              { label: 'VWorld WFS 도로폭', value: `${row[2] ?? '-'} m` },
              { label: '방식 B 최종 유효폭', value: `${row[4] ?? '-'} m` }
            ]
          });
        });
        diagLayerGroup.addLayer(poly);
      });
    }

    if (showSat && diag.imageEstimates) {
      diag.imageEstimates.forEach((row) => {
        const poly = L.polyline(row[2], {
          color: '#c084fc',
          weight: 5,
          opacity: 0.75
        });
        poly.bindTooltip(`Mask2Former 위성 실측폭: ${row[1]}m (링크 #${row[0]})`);
        poly.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (routeSelectStep !== 'idle') {
            handleMapOrLayerClick(e.latlng.lat, e.latlng.lng, null);
            return;
          }
          openNaverInfoPopup(e.latlng.lat, e.latlng.lng, {
            category: `위성 실측 링크 #${row[0]}`,
            badgeClass: 'info',
            badgeText: '🛰 Mask2Former 실측',
            title: `위성 AI 도로 분할 실측폭 ${row[1]}m`,
            subtitle: 'VWorld 1024×1024 위성영상 직교 프로파일 분석',
            cells: [
              { label: '위성 실측 도로폭', value: `${row[1]} m` },
              { label: '적용 모델', value: 'Mask2Former (ADE20K)' }
            ]
          });
        });
        diagLayerGroup.addLayer(poly);
      });
    }

    if (showSplits && diag.mergedSplits) {
      diag.mergedSplits.forEach((pt) => {
        const cm = L.circleMarker([pt[0], pt[1]], {
          radius: 4,
          color: '#38bdf8',
          fillColor: '#0284c7',
          fillOpacity: 0.9
        });
        cm.bindTooltip(`중심선 분절 병합점 (링크 ${pt[2]} ↔ ${pt[3]})`);
        cm.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          openNaverInfoPopup(pt[0], pt[1], {
            category: '위상 그래프 병합점',
            badgeClass: 'info',
            badgeText: 'degree=2 분절 통합',
            title: `링크 #${pt[2]} ↔ #${pt[3]} 병합 지점`,
            subtitle: '동일 도로 구간 내 불필요 분절점 자동 병합',
            cells: [
              { label: '병합 링크 A', value: `#${pt[2]}` },
              { label: '병합 링크 B', value: `#${pt[3]}` }
            ]
          });
        });
        diagLayerGroup.addLayer(cm);
      });
    }
  }

  function formatSecKo(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return `${s}초`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}분 ${rem}초` : `${m}분`;
  }

  function approxDistM(lat1, lng1, lat2, lng2) {
    const R = 6371000.0;
    const dLat = ((lat2 - lat1) * Math.PI) / 180.0;
    const dLng = ((lng2 - lng1) * Math.PI) / 180.0;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180.0) *
        Math.cos((lat2 * Math.PI) / 180.0) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function sampleEntryAnchorPoint(coords, goalLat, goalLng) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const segLens = [];
    let total = 0.0;
    for (let i = 0; i < coords.length - 1; i++) {
      const d = approxDistM(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
      segLens.push(d);
      total += d;
    }
    if (total < 95.0) return null;
    const target = 48.0;
    let acc = 0.0;
    for (let i = 0; i < segLens.length; i++) {
      const seg = segLens[i];
      if (acc + seg >= target || i === segLens.length - 1) {
        const t = seg > 1e-6 ? Math.max(0.0, Math.min(1.0, (target - acc) / seg)) : 0.0;
        const lat = Number((coords[i][0] + t * (coords[i + 1][0] - coords[i][0])).toFixed(6));
        const lng = Number((coords[i][1] + t * (coords[i + 1][1] - coords[i][1])).toFixed(6));
        const dStart = approxDistM(coords[0][0], coords[0][1], lat, lng);
        const dGoal = approxDistM(goalLat, goalLng, lat, lng);
        if (dStart >= 45.0 && dGoal >= 45.0) {
          return { nodeId: '출발진입점', lat: lat, lng: lng };
        }
        return null;
      }
      acc += seg;
    }
    return null;
  }

  /**
   * 내비게이션 앱(T맵·네이버·카카오)에서 "선택한 위치가 기존 지점과 중복됩니다" 오류가 발생하지 않도록
   * 출발지·경유지·도착지 간 최소 이격거리(minSepM) 및 소수점 좌표 중복을 엄격히 필터링
   */
  function filterDistinctWaypoints(candidates, originPt, goalPt, minSepM, maxCount = 5) {
    const accepted = [];
    const seenKeys = new Set();
    const minD = Number(minSepM) || 6.0;

    if (originPt && Number.isFinite(originPt.lat) && Number.isFinite(originPt.lng)) {
      seenKeys.add(`${Number(originPt.lat).toFixed(5)},${Number(originPt.lng).toFixed(5)}`);
    }

    for (let i = 0; i < (candidates || []).length; i++) {
      if (accepted.length >= maxCount) break;
      const c = candidates[i];
      if (!c || !Number.isFinite(Number(c.lat)) || !Number.isFinite(Number(c.lng))) continue;
      const cLat = Number(c.lat);
      const cLng = Number(c.lng);
      const isEntryTransition = Boolean(c.isBoundaryEntry || c.isMandatoryEntrance);
      const key5 = `${cLat.toFixed(5)},${cLng.toFixed(5)}`;
      if (!isEntryTransition && seenKeys.has(key5)) continue;

      if (!isEntryTransition && originPt && approxDistM(originPt.lat, originPt.lng, cLat, cLng) < minD) {
        continue;
      }
      if (!isEntryTransition && goalPt && approxDistM(goalPt.lat, goalPt.lng, cLat, cLng) < minD) {
        continue;
      }
      const tooCloseToAccepted = accepted.some(
        (prev) => approxDistM(prev.lat, prev.lng, cLat, cLng) < (isEntryTransition ? 2.0 : minD)
      );
      if (tooCloseToAccepted) continue;

      seenKeys.add(key5);
      accepted.push({
        nodeId: c.nodeId || `경유${accepted.length + 1}`,
        label: c.label || c.nodeId || `경유${accepted.length + 1}`,
        lat: Number(cLat.toFixed(6)),
        lng: Number(cLng.toFixed(6)),
        isBoundaryEntry: isEntryTransition
      });
    }

    return accepted;
  }

  function updateNavigationDeeplinks(route) {
    const tmapEl = document.getElementById('link-nav-tmap');
    const naverEl = document.getElementById('link-nav-naver');
    const kakaoEl = document.getElementById('link-nav-kakao');
    const viaSummaryEl = document.getElementById('nav-via-summary');
    if (!route || !route.found || !route.stagingPoint) return;

    const st = window.FirewayGraphEngine && window.FirewayGraphEngine.FIRE_STATION;
    const startLat = st ? Number(st.lat).toFixed(6) : Number(route.startPoint[0]).toFixed(6);
    const startLng = st ? Number(st.lng).toFixed(6) : Number(route.startPoint[1]).toFixed(6);
    const startName = st ? st.name : '의령소방서(의병로 108-17)';

    const goalLat = Number(route.stagingPoint[0]).toFixed(6);
    const goalLng = Number(route.stagingPoint[1]).toFixed(6);
    const goalName = route.directVehicleAccess
      ? `화점진입(${route.stagingNodeId})`
      : `소방차하차거점(${route.stagingNodeId})`;

    const vias = Array.isArray(route.navVia) ? route.navVia.slice(0, 5) : [];
    const originObj = { lat: Number(startLat), lng: Number(startLng) };
    const goalObj = { lat: Number(goalLat), lng: Number(goalLng) };

    const prioritizedDetours =
      vias.length > 2 ? [vias[0], vias[vias.length - 1], ...vias.slice(1, -1)] : vias.slice();
    const tmapVias = filterDistinctWaypoints(prioritizedDetours, originObj, goalObj, 6.0, 5);

    if (tmapEl) {
      const viaParams = tmapVias
        .map((v, idx) => {
          const label = v.isBoundaryEntry ? `마을범위진입(${v.nodeId})` : `안전경유${idx + 1}(${v.nodeId})`;
          const vName = encodeURIComponent(label);
          const vx = Number(v.lng).toFixed(6);
          const vy = Number(v.lat).toFixed(6);
          return `&rV${idx + 1}Name=${vName}&rV${idx + 1}X=${vx}&rV${idx + 1}Y=${vy}&via${idx + 1}name=${vName}&via${idx + 1}x=${vx}&via${idx + 1}y=${vy}`;
        })
        .join('');
      tmapEl.href =
        `tmap://route?rGoName=${encodeURIComponent(goalName)}&rGoX=${goalLng}&rGoY=${goalLat}` +
        `&goalname=${encodeURIComponent(goalName)}&goalx=${goalLng}&goaly=${goalLat}` +
        `${viaParams}&reqCoordType=WGS84&resCoordType=WGS84`;
    }

    const routeVias = filterDistinctWaypoints(vias, originObj, goalObj, 6.0, 5);

    if (viaSummaryEl) {
      const startSummary = `<strong>출발지(고정):</strong> 🚒 ${startName}`;
      const goalSummary = `<strong>도착지:</strong> ${goalName}`;
      if (tmapVias.length > 0) {
        const viaLabels = tmapVias
          .map((v, idx) =>
            v.isBoundaryEntry
              ? `<strong style="color:#f97316">🔶 마을 입구 (${Number(v.lat).toFixed(4)},${Number(v.lng).toFixed(4)})</strong>`
              : `경유${idx + 1}(${v.nodeId}: ${Number(v.lat).toFixed(4)},${Number(v.lng).toFixed(4)})`
          )
          .join(' → ');
        viaSummaryEl.innerHTML = `${startSummary} → ${viaLabels} → ${goalSummary}`;
      } else {
        viaSummaryEl.innerHTML = `${startSummary} → ${goalSummary}`;
      }
    }

    if (naverEl) {
      const vParams = routeVias
        .map(
          (v, idx) =>
            `&v${idx + 1}lat=${Number(v.lat).toFixed(6)}&v${idx + 1}lng=${Number(v.lng).toFixed(6)}&v${idx + 1}name=${encodeURIComponent(
              (v.isBoundaryEntry ? '마을범위진입' : '안전경유' + (idx + 1)) + '(' + v.nodeId + ')'
            )}`
        )
        .join('');
      naverEl.href =
        `nmap://route/car?slat=${startLat}&slng=${startLng}&sname=${encodeURIComponent(startName)}` +
        `${vParams}&dlat=${goalLat}&dlng=${goalLng}&dname=${encodeURIComponent(goalName)}&appname=fireway119.pages.dev`;
    }

    if (kakaoEl) {
      const kVias = routeVias
        .map((v, idx) => {
          const paramName = idx === 0 ? 'vp' : `vp${idx + 1}`;
          return `&${paramName}=${Number(v.lat).toFixed(6)},${Number(v.lng).toFixed(6)}`;
        })
        .join('');
      kakaoEl.href = `kakaomap://route?sp=${startLat},${startLng}&ep=${goalLat},${goalLng}${kVias}&by=car`;
    }
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs || 3500)
      : null;
    try {
      const opts = controller ? Object.assign({}, options, { signal: controller.signal }) : options;
      return await fetch(url, opts);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function isHttpOrigin() {
    return Boolean(
      typeof window !== 'undefined' &&
        window.location &&
        (window.location.protocol === 'http:' || window.location.protocol === 'https:')
    );
  }

  async function fetchExternalRoute(seq, preferRouter) {
    if (isHttpOrigin()) {
      try {
        const resp = await fetchWithTimeout(
          '/api/route',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seq: seq, router: preferRouter || 'tmap' })
          },
          3200
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && Array.isArray(data.line) && data.line.length >= 2) {
            return data;
          }
        }
      } catch (_) {
        // Fall through to direct browser OSRM call
      }
    }

    const coords = seq.map((p) => `${Number(p[1]).toFixed(6)},${Number(p[0]).toFixed(6)}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const r = await fetchWithTimeout(url, {}, 3500);
    if (!r.ok) throw new Error('OSRM status ' + r.status);
    const osrmData = await r.json();
    const rt = (osrmData.routes || [])[0];
    if (!rt) throw new Error('OSRM empty route');
    const line = rt.geometry.coordinates.map(([x, y]) => [
      Math.round(y * 1e6) / 1e6,
      Math.round(x * 1e6) / 1e6
    ]);
    return {
      line: line,
      dist: Math.round(rt.distance),
      time: Math.round(rt.duration),
      router: 'osrm',
      passCount: Math.max(0, seq.length - 2)
    };
  }

  async function requestAndRenderExternalRoute(route, preferRouter) {
    if (!route || !route.found) return;
    lastExternalTargetCache = null;
    await dispatchMissionTo(route.targetLat, route.targetLng, null, true, preferRouter || 'tmap');
  }

  async function dispatchMissionTo(lat, lng, bldgRing, skipApi, preferRouter) {
    if (!currentIndex) return;
    missionLayerGroup.clearLayers();
    if (trunkRouteLayerGroup) trunkRouteLayerGroup.clearLayers();
    lastRouteApiResult = null;

    let matchedV =
      window.FirewayGraphEngine && window.FirewayGraphEngine.findAnalyzedVillageForPoint
        ? window.FirewayGraphEngine.findAnalyzedVillageForPoint(currentIndex, lat, lng, currentVillageId)
        : getCurrentAnalyzedVillage();
    if (matchedV && matchedV.id) {
      syncActiveVillageUI(matchedV.id);
      renderDocMapOverlay();
    }
    const activeVid = matchedV ? matchedV.id : currentVillageId || null;

    const st =
      (window.FirewayGraphEngine && window.FirewayGraphEngine.FIRE_STATION) || {
        name: '의령소방서(의병로 108-17)',
        lat: 35.319599,
        lng: 128.248343
      };

    const routeBadgeEl = document.getElementById('route-engine-badge');
    if (routeBadgeEl) {
      routeBadgeEl.textContent = '경로 찾는 중...';
      routeBadgeEl.className = 'badge badge-neutral';
    }

    // Step 1: Default TMAP/OSRM External Road Search from Fire Station toward Fire Point (NO forced 마을 입구 waypoint)
    let ext = null;
    const cacheKey = `${Number(lat).toFixed(6)}_${Number(lng).toFixed(6)}`;
    if (skipApi && lastExternalTargetCache && lastExternalTargetCache.key === cacheKey) {
      ext = lastExternalTargetCache.ext;
    } else {
      try {
        ext = await fetchExternalRoute([[st.lat, st.lng], [lat, lng]], preferRouter || 'tmap');
        lastExternalTargetCache = { key: cacheKey, ext: ext };
      } catch (_) {
        ext = null;
      }
    }
    lastRouteApiResult = ext;

    const route = window.FirewayGraphEngine.findMissionRoute(currentIndex, lat, lng, {
      threshold: currentThreshold,
      mode: 'vworld_api',
      villageId: activeVid,
      strictVillageScope: true,
      externalRouteCoords: ext ? ext.line : null,
      externalRouteDistM: ext ? ext.dist : null,
      externalRouteTimeS: ext ? ext.time : null,
      externalRouter: ext ? ext.router : null
    });

    lastMission = route;
    setTimeout(updateMissionSummary, 0);
    try {
      drawVehicleStops(lat, lng, {
        mode: 'vworld_api',
        villageId: activeVid,
        strictVillageScope: true,
        externalRouteCoords: ext ? ext.line : null,
        externalRouteDistM: ext ? ext.dist : null,
        externalRouteTimeS: ext ? ext.time : null,
        externalRouter: ext ? ext.router : null
      }, route.found);
    } catch (_) {}
    updateStartPointUI();
    renderStartMarker();

    const statusBadge = document.getElementById('mission-status-badge');
    const alertBox = document.getElementById('bottleneck-alert');

    if (!route.found) {
      const emptyEl = document.getElementById('mission-empty');
      if (emptyEl) emptyEl.classList.add('hidden');
      const resultEl = document.getElementById('mission-result');
      if (resultEl) resultEl.classList.remove('hidden');
      if (statusBadge) {
        statusBadge.textContent = route.outOfVillageScope ? '분석 마을 범위 밖' : '경로 탐색 불가';
        statusBadge.className = 'badge badge-warn';
      }
      if (alertBox) {
        alertBox.classList.remove('hidden');
        alertBox.innerHTML = `<strong>[경로 탐색 제한]</strong> ${route.message || '분석된 239개 마을 범위 내에서만 경로를 탐색할 수 있습니다.'}`;
      }
      if (route.message) {
        showNudgeBanner(`⚠️ ${route.message}`, 4500);
      }
      return;
    }

    const emptyEl = document.getElementById('mission-empty');
    if (emptyEl) emptyEl.classList.add('hidden');
    const resultEl = document.getElementById('mission-result');
    if (resultEl) resultEl.classList.remove('hidden');

    // Sync search input & switch button to '검색 초기화'
    const searchInput = document.getElementById('village-search');
    if (searchInput) {
      if (lastSearchedAddress) {
        searchInput.value = lastSearchedAddress;
      } else {
        const eupPrefix = matchedV && matchedV.eupName ? `${matchedV.eupName} ` : '';
        searchInput.value = `의령군 ${eupPrefix}${route.villageName || ''}마을 (${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)})`;
      }
      lastSyncedSearchInputValue = searchInput.value.trim();
    }
    setSearchButtonMode('reset');

    const entryPtObj = getRouteEntryPoint(route);
    const entranceName = entryPtObj && entryPtObj.name
      ? entryPtObj.name
      : `${route.villageName || ''}마을 범위 진입점`;

    // 0. Step 1: Draw trunk dispatch route (🚒 의령소방서 -> 🔶 마을 범위 진입점) on trunkRouteLayerGroup
    if (Array.isArray(route.trunkRouteCoords) && route.trunkRouteCoords.length >= 2) {
      const isRoadFollowing = route.trunkRouteCoords.length > 2;
      const trunkPoly = L.polyline(route.trunkRouteCoords, {
        color: '#1a73e8',
        weight: 5,
        fwBaseW: 5,
        fwWidthM: 6,
        opacity: 0.92,
        dashArray: isRoadFollowing ? null : '7,6'
      })
        .bindTooltip(
          `🚒 소방서 → 🔶 ${entranceName} (T맵 · 약 ${(route.trunkDistanceM / 1000).toFixed(2)}km)`
        )
        .addTo(trunkRouteLayerGroup);
      trunkPoly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        openNaverInfoPopup(e.latlng.lat, e.latlng.lng, {
          category: '소방서 → 마을 입구 (T맵)',
          badgeClass: 'turn',
          badgeText: '🚒 의령소방서 → 마을범위 진입점',
          title: `의령소방서 → ${entranceName}`,
          subtitle: `간선 주행거리 ${(route.trunkDistanceM / 1000).toFixed(2)}km · 예상 ${formatSecKo(route.trunkDriveSec)}`,
          cells: [
            { label: '출발지 (고정)', value: '의령소방서 (의병로 108-17)' },
            { label: '마을 입구', value: `🔶 ${entranceName}` }
          ]
        });
      });
    }

    // 1. Step 2a: Draw 1st-stage vehicle route inside the analyzed village (🔶 마을 범위 진입점 -> 🛑 1차 하차거점)
    if (route.vehicleRouteCoords && route.vehicleRouteCoords.length >= 2) {
      const vehPoly = L.polyline(route.vehicleRouteCoords, {
        color: '#1a73e8',
        weight: 6,
        fwBaseW: 6,
        fwWidthM: 3.5,
        opacity: 0.94
      })
        .bindTooltip(
          `마을 안 소방차 진입 길 (🔶 ${entranceName} → 🛑 ${route.stagingNodeId}, ${route.villageVehicleDistanceM}m)`
        )
        .addTo(missionLayerGroup);
      vehPoly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        openNaverInfoPopup(e.latlng.lat, e.latlng.lng, {
          category: '마을 안 소방차 진입 길',
          badgeClass: 'pass',
          badgeText: '🚒 마을 안 진입',
          title: `🔶 ${entranceName} → 🛑 ${route.stagingNodeId}`,
          subtitle: `마을 내 주행 ${route.villageVehicleDistanceM}m (총 ${(route.vehicleDistanceM / 1000).toFixed(2)}km)`,
          cells: [
            { label: '마을 내 차량 진입', value: `${route.villageVehicleDistanceM} m` },
            { label: '소방서→하차거점 총거리', value: `${(route.vehicleDistanceM / 1000).toFixed(2)} km` }
          ]
        });
      });
    }

    // 2. Draw transition marker at route.boundaryEntryPoint (or route.villageEntrance) + internal safe detour waypoints
    if (entryPtObj && Number.isFinite(entryPtObj.lat) && Number.isFinite(entryPtObj.lng)) {
      const transIcon = L.divIcon({
        className: '',
        html: `<span class="via-marker-badge" style="background:#ea580c;border-color:#fff;font-weight:800;">🔶 마을 입구</span>`,
        iconSize: [168, 24],
        iconAnchor: [84, 12]
      });
      const transMarker = L.marker([entryPtObj.lat, entryPtObj.lng], { icon: transIcon })
        .bindTooltip(
          `🔶 ${entranceName}: T맵 길이 끝나고 마을 안 골목 판정이 시작되는 곳`,
          { direction: 'top' }
        )
        .addTo(missionLayerGroup);
      transMarker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        openNaverInfoPopup(entryPtObj.lat, entryPtObj.lng, {
          category: '마을 입구',
          badgeClass: 'turn',
          badgeText: '🔶 마을 입구',
          title: entranceName,
          subtitle: '마을 범위 진입 시점부터 자체 도로폭·회전반경 판정 경로 전환',
          cells: [
            { label: '전환 구분', value: '🔶 마을 입구' },
            { label: '진입점 좌표', value: `${entryPtObj.lat.toFixed(5)}, ${entryPtObj.lng.toFixed(5)}` }
          ]
        });
      });
    }

    if (Array.isArray(route.navVia) && route.navVia.length > 0) {
      route.navVia.forEach((via, idx) => {
        const isEntry = Boolean(via.isBoundaryEntry || via.isMandatoryEntrance);
        if (
          isEntry ||
          (entryPtObj && approxDistM(entryPtObj.lat, entryPtObj.lng, via.lat, via.lng) < 6.0)
        ) {
          return;
        }
        const badgeIcon = L.divIcon({
          className: '',
          html: `<span class="via-marker-badge">경유${idx + 1}</span>`,
          iconSize: [44, 20],
          iconAnchor: [22, 10]
        });
        const viaMarker = L.marker([via.lat, via.lng], { icon: badgeIcon })
          .bindTooltip(`안전 우회 경유지 #${idx + 1} (정점 ${via.nodeId} · 협소/회전불가 구간 우회)`)
          .addTo(missionLayerGroup);
        viaMarker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          openNaverInfoPopup(via.lat, via.lng, {
            category: `안전 우회 경유지 #${idx + 1}`,
            badgeClass: 'info',
            badgeText: `정점 ${via.nodeId}`,
            title: `T맵·네이버·카카오 제${idx + 1}경유지`,
            subtitle: '협소 도로 및 회전반경 미달 교차로 우회 지점',
            cells: [
              { label: '경유 구분', value: `안전 우회 경유지 (${via.nodeId})` },
              { label: '경유 좌표', value: `${via.lat.toFixed(5)}, ${via.lng.toFixed(5)}` }
            ]
          });
        });
      });
    }

    // 3. Step 2b: Draw 2nd-stage fire hose extension route (🛑 1차 하차거점 -> 🔴 화점)
    if (!route.directVehicleAccess && route.hoseRouteCoords && route.hoseRouteCoords.length >= 2) {
      const hosePoly = L.polyline(route.hoseRouteCoords, {
        color: '#ff3b30',
        weight: 5,
        dashArray: '8,6',
        opacity: 0.95
      })
        .bindTooltip(`2차 소방호스 도보 연장 경로 (🛑 ${route.stagingNodeId} → 🔴 화점, ${route.hoseDistanceM}m · 15m 호스 ${route.requiredHose15mCount}본)`)
        .addTo(missionLayerGroup);
      hosePoly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        openNaverInfoPopup(e.latlng.lat, e.latlng.lng, {
          category: '2차 소방호스 연장 경로',
          badgeClass: 'block',
          badgeText: '🧯 도보 호스 전개',
          title: `호스 연장 ${route.hoseDistanceM}m (${route.requiredHose15mCount}본)`,
          subtitle: route.bottleneck ? route.bottleneck.message : '차량 진입 한계 이후 도보 전개 구간',
          cells: [
            { label: '2차 호스 연장 거리', value: `${route.hoseDistanceM} m` },
            {
              label: '15m 소방호스 소요',
              value: `${route.requiredHose15mCount} 본 (예비포함 ${route.requiredHoseWithSpareCount || route.requiredHose15mCount}본)`
            }
          ]
        });
      });

      const stgMarker = L.circleMarker(route.stagingPoint, {
        radius: 7,
        color: '#fff',
        weight: 2,
        fillColor: '#f97316',
        fillOpacity: 1
      }).addTo(missionLayerGroup);
      stgMarker.bindTooltip('🚒 소방차 하차', { direction: 'left' });
      stgMarker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        openNaverInfoPopup(route.stagingPoint[0], route.stagingPoint[1], {
          category: '소방차 1차 하차·전개 거점',
          badgeClass: 'turn',
          badgeText: `🛑 거점 ${route.stagingNodeId}`,
          title: `1차 하차 거점 (${route.stagingNodeId})`,
          subtitle: '1차 차량 진입 종점 · 2차 소방호스 전개 시작점',
          cells: [
            { label: '마을 범위 진입점 → 거점', value: `${route.villageVehicleDistanceM} m` },
            { label: '거점 → 화점 호스', value: `${route.hoseDistanceM} m (${route.requiredHose15mCount}본)` }
          ]
        });
      });
    }

    // 4. Target fire marker
    const targetMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'fw-pin-icon', html: PIN_SVG, iconSize: [24, 32], iconAnchor: [12, 31] }),
      zIndexOffset: 1000
    })
      .bindTooltip('📍 신고 지점', { permanent: true, direction: 'right', offset: [12, -18] })
      .addTo(missionLayerGroup);
    targetMarker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      openNaverInfoPopup(lat, lng, {
        category: '화점 / 출동 목표지점',
        badgeClass: route.directVehicleAccess ? 'pass' : 'block',
        badgeText: route.directVehicleAccess ? '차량 직접 진입' : `호스 ${route.requiredHose15mCount}본 연장`,
        title:
          lastSearchedAddress ||
          (lastBuildingInfo && lastBuildingInfo.roadAddress) ||
          `화점 (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
        subtitle:
          lastBuildingInfo && lastBuildingInfo.mainUse
            ? `${lastBuildingInfo.mainUse} · ${lastBuildingInfo.structure || '구조 확인'}`
            : '좌측 [화점·AI] 탭에서 건축물대장 상세 확인',
        cells: [
          { label: '마을 범위 진입점 → 하차거점', value: `${route.villageVehicleDistanceM} m` },
          { label: '2차 호스 연장', value: `${route.hoseDistanceM} m (${route.requiredHose15mCount}본)` }
        ]
      });
    });

    if (route.nearestHydrant) {
      L.polyline([route.stagingPoint, [route.nearestHydrant.lat, route.nearestHydrant.lng]], {
        color: '#38bdf8',
        weight: 2.5,
        dashArray: '4,4'
      }).addTo(missionLayerGroup);
    }

    if (route.directVehicleAccess) {
      if (statusBadge) {
        statusBadge.textContent = '차량 직접 진입 가능';
        statusBadge.className = 'badge badge-pass';
      }
      if (alertBox) alertBox.classList.add('hidden');
    } else {
      if (statusBadge) {
        statusBadge.textContent = '차량 진입 불가 · 호스 연장';
        statusBadge.className = 'badge badge-warn';
      }
      if (alertBox) {
        alertBox.classList.remove('hidden');
        alertBox.innerHTML = `<strong>[진입 제한 사유]</strong> ${route.bottleneck ? route.bottleneck.message : '골목 협소'}<br/><strong>의령소방서</strong> → <strong>🔶 ${entranceName}(마을 입구)</strong> → 하차 거점(<strong>${route.stagingNodeId}</strong>) 차량 진입 후 소방호스 <strong>${route.hoseDistanceM}m (${route.requiredHose15mCount}본)</strong> 도보 연장이 필요합니다.`;
      }
    }

    const vehDistEl = document.getElementById('metric-veh-dist');
    if (vehDistEl) {
      vehDistEl.textContent = `마을내 ${route.villageVehicleDistanceM}m (총 ${(route.vehicleDistanceM / 1000).toFixed(2)}km)`;
    }
    const stagingNodeEl = document.getElementById('metric-staging-node');
    if (stagingNodeEl) {
      stagingNodeEl.textContent = `의령소방서 → 🔶 ${entranceName} (마을 입구) → ${route.stagingNodeId}`;
    }
    const hoseDistEl = document.getElementById('metric-hose-dist');
    if (hoseDistEl) {
      hoseDistEl.textContent = route.hoseDistanceM === 0 ? '0 m (차량 직접 진입)' : `${route.hoseDistanceM} m`;
    }
    const hoseCountEl = document.getElementById('metric-hose-count');
    if (hoseCountEl) {
      hoseCountEl.textContent = `${route.requiredHose15mCount}본 + 예비 ${(route.requiredHoseWithSpareCount || route.requiredHose15mCount + 1) - route.requiredHose15mCount}`;
    }
    const hydrantEl = document.getElementById('metric-hydrant');
    if (hydrantEl) {
      hydrantEl.textContent = route.nearestHydrant
        ? (/^(거점소화전|중계급수거점)-/.test(String(route.nearestHydrant.label || ''))
            ? `물탱크차 중계급수 후보 거점 · 실물 소화전 미확인 (${String(route.nearestHydrant.label).replace(/^거점소화전-/, '중계급수거점-')} · 이격 ${route.nearestHydrant.distanceM}m)`
            : `${route.nearestHydrant.label} (이격 ${route.nearestHydrant.distanceM}m)`)
        : '인근 소화전 없음';
    }

    const walkPlusHoseSec = (route.walkSec || 0) + (route.hoseDeploySec || 0);
    const timeEl = document.getElementById('metric-total-time');
    if (timeEl) {
      timeEl.textContent = `약 ${formatSecKo(route.totalMissionSec)}`;
      timeEl.title = `차량 ${formatSecKo(route.villageDriveSec)} · 호스전개 ${formatSecKo(walkPlusHoseSec)}`;
    }
    if (routeBadgeEl) {
      routeBadgeEl.textContent =
        ext && ext.router === 'tmap' ? 'T맵 + 마을 안 골목 판정' : '예비 경로 + 마을 안 골목 판정';
      routeBadgeEl.className = 'badge badge-pass';
    }

    updateNavigationDeeplinks(route);

    if (!skipApi) {
      await fetchBuildingInfo(lat, lng, bldgRing);
      const liveAddr =
        lastBuildingInfo && (lastBuildingInfo.roadAddress || lastBuildingInfo.parcelAddress)
          ? lastBuildingInfo.roadAddress || lastBuildingInfo.parcelAddress
          : '';
      if (liveAddr) {
        if (!lastSearchedAddress) {
          lastSearchedAddress = liveAddr;
        }
        const sIn = document.getElementById('village-search');
        if (sIn) {
          sIn.value = lastSearchedAddress || liveAddr;
          lastSyncedSearchInputValue = sIn.value.trim();
        }
      }
      updateStartPointUI();
      await generateAiBriefing(false);
    } else {
      await generateAiBriefing(false);
    }
  }

  function openNavAppInfoPopup(appType, deeplinkUrl) {
    if (!lastMission || !lastMission.found || !lastMission.stagingPoint) {
      showNudgeBanner('안내: 상단 주소 검색창에서 주소를 검색하거나 분석 마을 내 화점을 선택하면 내비게이션 길안내 팝업이 활성화됩니다.');
      return;
    }
    const route = lastMission;
    const st = window.FirewayGraphEngine && window.FirewayGraphEngine.FIRE_STATION;
    const startName = st ? st.name || '의령소방서' : '의령소방서';
    const goalLat = Number(route.stagingPoint[0]);
    const goalLng = Number(route.stagingPoint[1]);
    const goalName = route.directVehicleAccess
      ? `화점진입(${route.stagingNodeId})`
      : `하차거점(${route.stagingNodeId})`;
    const viaCount = Array.isArray(route.navVia) ? route.navVia.length : 0;

    let appTitle = '네이버 지도 길안내';
    let badgeText = 'NAVER 지도 연동';
    let badgeClass = 'pass';
    let webUrl = `https://map.naver.com/p/directions/-/${goalLng},${goalLat},${encodeURIComponent(goalName)}/-/car`;

    if (appType === 'tmap') {
      appTitle = 'T맵 길안내';
      badgeText = 'T맵 내비';
      badgeClass = 'info';
      webUrl = `https://map.naver.com/p/directions/-/${goalLng},${goalLat},${encodeURIComponent(goalName)}/-/car`;
    } else if (appType === 'kakao') {
      appTitle = '카카오맵 (KakaoMap) 길안내';
      badgeText = 'Kakao 내비 연동';
      badgeClass = 'turn';
      webUrl = `https://map.kakao.com/link/to/${encodeURIComponent(goalName)},${goalLat},${goalLng}`;
    }

    const tmapActionBtn =
      appType === 'tmap'
        ? `<button type="button" class="naver-popup-btn btn-target" data-popup-action="run-tmap-api">
             🗺 지도 위 T맵 경로 재탐색
           </button>`
        : `<a href="${webUrl}" target="_blank" rel="noopener" class="naver-popup-btn btn-target">
             🌐 PC 웹 지도 열기
           </a>`;

    const customActionsHtml = `
      <div class="naver-popup-actions">
        <a href="${deeplinkUrl}" class="naver-popup-btn btn-start">
          📱 모바일 앱 실행
        </a>
        ${tmapActionBtn}
        <button type="button" class="naver-popup-btn full" data-popup-action="copy-deeplink" data-copy-url="${deeplinkUrl.replace(/"/g, '&quot;')}">
          📋 길안내 딥링크 URL 복사
        </button>
      </div>`;

    openNaverInfoPopup(goalLat, goalLng, {
      category: '내비게이션 연결',
      badgeClass: badgeClass,
      badgeText: badgeText,
      title: appTitle,
      subtitle: `${startName} → 마을 범위 진입점 및 안전 경유 ${viaCount}개소 → ${goalName}`,
      cells: [
        { label: '출발지 (고정)', value: `🚒 ${startName}` },
        { label: '도착 거점 좌표', value: `${goalLat.toFixed(5)}, ${goalLng.toFixed(5)}` },
        {
          label: '전환·안전 경유지 목록',
          value: viaCount > 0 ? `${viaCount}개소 (${route.navVia.map((v) => v.nodeId).join(' → ')})` : '🔶 마을 입구',
          full: true
        }
      ],
      customActionsHtml: customActionsHtml
    });
  }

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

  function vworldJsonp(endpoint, params) {
    return new Promise((resolve, reject) => {
      const cb = '__vw_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const timer = setTimeout(() => {
        delete window[cb];
        script.remove();
        reject(new Error('VWorld JSONP timeout'));
      }, 8000);
      window[cb] = (res) => {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
        resolve(res);
      };
      script.onerror = () => {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
        reject(new Error('VWorld JSONP error'));
      };
      const qs = new URLSearchParams({ domain: VWORLD_DOMAIN, ...params, key: VWORLD_KEY, callback: cb });
      script.src = `${endpoint}?${qs.toString()}`;
      document.body.appendChild(script);
    });
  }

  function distToFeatureM(feat, lat, lng) {
    const g = feat && feat.geometry;
    if (!g || !g.coordinates || !g.coordinates.length) return 1e9;
    const ring = g.type === 'MultiPolygon' ? g.coordinates[0][0] : g.coordinates[0];
    if (!ring || ring.length < 3) return 1e9;
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
    if (inside) return 0;
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
    return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
  }

  function positiveNum(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  function buildTacticalNotes(mainUse, structure, roof, grndFlr, useAprDay) {
    const notes = [];
    const st = `${structure || ''} ${roof || ''}`;
    if (/목/.test(st)) notes.push('목구조 — 연소 확대가 빠름, 초기 대량 방수 및 인접 건물 방어 필요');
    if (/샌드위치|패널/.test(st)) notes.push('샌드위치패널 — 급격한 연소·붕괴 위험, 내부 진입 신중');
    if (/철골|강구조|파이프/.test(st)) notes.push('철골/강구조 — 장시간 가열 시 강도 저하·붕괴 위험');
    if (/슬레이트|기와/.test(st)) notes.push(`${/슬레이트/.test(st) ? '슬레이트' : '기와'} 지붕 — 낙하물 주의`);
    if (grndFlr && grndFlr >= 3) notes.push(`지상 ${grndFlr}층 건축물 — 상층부 연소 확대 대비 및 고소 방수 검토`);
    const yr = parseInt(String(useAprDay || '').slice(0, 4), 10);
    if (yr > 1900 && yr <= 1996) notes.push(`사용승인 ${yr}년 — 30년 이상 노후 건축물, 구조체 약화 주의`);
    if (/노유자/.test(mainUse || '')) notes.push('노유자시설 — 거동불편자 최우선 인명 검색 및 대피 유도');
    else if (/동물|식물|창고/.test(mainUse || '')) notes.push('축사·창고시설 — 내부 가연물 및 지붕 붕괴 주의');
    return notes;
  }

  async function fetchBuildingViaVWorldJsonp(lat, lng) {
    const d = 0.0007;
    const boxFilter = `BOX(${(lng - d).toFixed(6)},${(lat - d).toFixed(6)},${(lng + d).toFixed(6)},${(lat + d).toFixed(6)})`;

    let roadAddress = '';
    let parcelAddress = '';
    let buildingName = '';
    let dongName = '';
    let bdMgtSn = '';
    let pnu = '';
    let distM = null;
    let foundBuilding = false;
    let spbdProps = {};
    let bldginfoProps = {};

    const [addrRes, spbdRes, infoRes] = await Promise.allSettled([
      vworldJsonp('https://api.vworld.kr/req/address', {
        service: 'address',
        request: 'getAddress',
        version: '2.0',
        crs: 'epsg:4326',
        point: `${lng},${lat}`,
        format: 'json',
        type: 'both',
        zipcode: 'true',
        simple: 'false'
      }),
      vworldJsonp('https://api.vworld.kr/req/data', {
        service: 'data',
        request: 'GetFeature',
        data: 'LT_C_SPBD',
        domain: VWORLD_DOMAIN,
        geomFilter: boxFilter,
        size: '100',
        format: 'json',
        crs: 'EPSG:4326',
        geometry: 'true',
        attribute: 'true'
      }),
      vworldJsonp('https://api.vworld.kr/req/data', {
        service: 'data',
        request: 'GetFeature',
        data: 'LT_C_BLDGINFO',
        domain: VWORLD_DOMAIN,
        geomFilter: boxFilter,
        size: '100',
        format: 'json',
        crs: 'EPSG:4326',
        geometry: 'true',
        attribute: 'true'
      })
    ]);

    if (addrRes.status === 'fulfilled' && addrRes.value?.response?.result) {
      for (const item of addrRes.value.response.result) {
        if (item.type === 'road') {
          roadAddress = item.text || '';
          if (item.structure && item.structure.detail) buildingName = item.structure.detail;
        } else if (item.type === 'parcel') {
          parcelAddress = item.text || '';
        }
      }
    }

    if (spbdRes.status === 'fulfilled' && spbdRes.value?.response?.status === 'OK') {
      const feats = spbdRes.value.response.result?.featureCollection?.features || [];
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

    if (infoRes.status === 'fulfilled' && infoRes.value?.response?.status === 'OK') {
      const feats = infoRes.value.response.result?.featureCollection?.features || [];
      const near = feats
        .map((f) => ({ d: distToFeatureM(f, lat, lng), f }))
        .filter((x) => x.d <= 60)
        .sort((a, b) => a.d - b.d);
      if (near.length > 0) {
        foundBuilding = true;
        if (distM === null || near[0].d < distM) distM = Math.round(near[0].d * 10) / 10;
        const registered = near.filter((x) => {
          const p = x.f.properties || {};
          return x.d <= Math.min(3.0, near[0].d + 1.5) && (p.usability || p.strct_cd || parseFloat(p.totalarea || 0) > 0);
        });
        const chosen = registered.length > 0 ? registered[0].f : near[0].f;
        bldginfoProps = chosen.properties || {};
      }
    }

    const mainUse = decodePurposeCode(bldginfoProps.usability) || null;
    const structure = decodeStrctCode(bldginfoProps.strct_cd) || null;
    const rawGrnd = bldginfoProps.grnd_flr || spbdProps.gro_flo_co;
    const rawUgrnd = bldginfoProps.ugrnd_flr;
    const grndFlr = /^\d+$/.test(String(rawGrnd || '')) && parseInt(rawGrnd, 10) > 0 ? parseInt(rawGrnd, 10) : null;
    const ugrndFlr = /^\d+$/.test(String(rawUgrnd || '')) && parseInt(rawUgrnd, 10) > 0 ? parseInt(rawUgrnd, 10) : 0;
    const floorsStr = grndFlr !== null ? `지상 ${grndFlr}층` + (ugrndFlr > 0 ? ` / 지하 ${ugrndFlr}층` : '') : null;

    const totalAreaM2 = positiveNum(bldginfoProps.totalarea);
    const archAreaM2 = positiveNum(bldginfoProps.archarea);
    const platAreaM2 = positiveNum(bldginfoProps.platarea);
    const heightM = positiveNum(bldginfoProps.height);
    const bcRat = positiveNum(bldginfoProps.bc_rat);
    const vlRat = positiveNum(bldginfoProps.vl_rat);
    const useAprDay = formatUseAprDay(bldginfoProps.useapr_day) || null;

    if (!buildingName) buildingName = bldginfoProps.bld_nm || spbdProps.buld_nm || null;
    dongName = bldginfoProps.dong_nm || null;

    const hasLedgerRecord = Boolean(mainUse || structure || totalAreaM2 || archAreaM2 || useAprDay);
    let ledgerStatus = '';
    let sourceLabel = '';
    if (!foundBuilding) {
      ledgerStatus = '반경 60m 내 등록 건축물 없음';
      sourceLabel = 'VWorld 주소조회';
    } else if (hasLedgerRecord) {
      ledgerStatus = '건축물대장 확인됨';
      sourceLabel = '건축물대장 (VWorld)';
    } else {
      ledgerStatus = '건축물대장 없음 (미등기·가설건축물일 수 있음, 현장 확인)';
      sourceLabel = '도로명주소 건물';
    }

    return {
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
      etcUse: null,
      structure: structure,
      roof: null,
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
      tacticalNotes: buildTacticalNotes(mainUse, structure, null, grndFlr, useAprDay),
      source: sourceLabel
    };
  }

  // 브라우저가 찾은 건물관리번호로 서버(/api/ledger)에서 건축물대장 표제부 보강
  async function enrichWithLedger(data) {
    if (!data || !data.bdMgtSn || !isHttpOrigin()) return data;
    try {
      const r = await fetch('/api/ledger?sn=' + encodeURIComponent(data.bdMgtSn));
      if (!r.ok) return data;
      const rec = ((await r.json()).records || [])[0];
      if (!rec) return data;
      const t = (v) => (typeof v === 'string' ? v.trim() : v);
      const num = (v) => (Number(v) > 0 ? Number(v) : null);
      const d = { ...data };
      d.mainUse = t(rec.mainUse) || d.mainUse;
      d.etcUse = t(rec.etcUse) || d.etcUse;
      d.structure = t(rec.structure) || d.structure;
      d.roof = t(rec.roof) || d.roof;
      if (num(rec.groundFloors)) {
        d.groundFloors = Number(rec.groundFloors);
        d.undergroundFloors = Number(rec.undergroundFloors) || 0;
        d.floors = `지상 ${d.groundFloors}층` + (d.undergroundFloors ? ` / 지하 ${d.undergroundFloors}층` : '');
      }
      d.totalAreaM2 = num(rec.totalAreaM2) || d.totalAreaM2;
      d.archAreaM2 = num(rec.archAreaM2) || d.archAreaM2;
      const day = String(rec.useAprDay || '').trim();
      if (/^\d{8}$/.test(day)) d.useAprDay = `${day.slice(0, 4)}.${day.slice(4, 6)}.${day.slice(6, 8)}`;
      d.buildingName = d.buildingName || t(rec.buildingName) || null;
      d.hasLedgerRecord = true;
      d.ledgerStatus = '건축물대장 확인됨';
      d.source = '건축물대장';
      d.tacticalNotes = buildTacticalNotes(d.mainUse, d.structure, d.roof, d.groundFloors, d.useAprDay);
      return d;
    } catch (_) {
      return data;
    }
  }

  function renderBuildingInfoBox(data) {
    const box = document.getElementById('building-info-box');
    const badge = document.getElementById('bldg-api-badge');
    badge.textContent = data.source || '건축물대장';

    const distTag =
      data.distanceM !== null && data.distanceM !== undefined
        ? data.distanceM === 0
          ? ' (클릭 지점 건물)'
          : ` (최단 ${data.distanceM}m 이격 건물)`
        : '';
    const nameStr = [data.buildingName, data.dongName].filter(Boolean).join(' · ') || '명칭 미등재';
    const useStr = [data.mainUse, data.etcUse].filter(Boolean).join(' / ') || '정보 없음';
    const strctStr = [data.structure, data.roof].filter(Boolean).join(' · ') || '정보 없음';
    const floorStr =
      [data.floors, data.heightM ? `높이 ${data.heightM}m` : null].filter(Boolean).join(' · ') || '정보 없음';

    const areaParts = [];
    if (data.totalAreaM2) areaParts.push(`연면적 ${data.totalAreaM2} ㎡`);
    if (data.archAreaM2) areaParts.push(`건축 ${data.archAreaM2} ㎡`);
    if (data.platAreaM2) areaParts.push(`대지 ${data.platAreaM2} ㎡`);
    const areaStr = areaParts.length > 0 ? areaParts.join(' / ') : '정보 없음';

    const ratioParts = [];
    if (data.bcRat) ratioParts.push(`건폐율 ${data.bcRat}%`);
    if (data.vlRat) ratioParts.push(`용적률 ${data.vlRat}%`);
    const ratioRow =
      ratioParts.length > 0 ? `<tr><th>건폐율/용적률</th><td>${ratioParts.join(' · ')}</td></tr>` : '';

    const notesHtml =
      data.tacticalNotes && data.tacticalNotes.length > 0
        ? `<div class="alert-box" style="margin-top:8px;margin-bottom:0;"><strong>[건축물대장 기반 소방 주의사항]</strong><br/>${data.tacticalNotes
            .map((n) => '• ' + n)
            .join('<br/>')}</div>`
        : '';

    setTimeout(updateMissionSummary, 0);
    const addr = data.roadAddress || data.parcelAddress || '주소 없음';
    const area = data.totalAreaM2 ? `${data.totalAreaM2}㎡` : '-';
    const distNote =
      data.distanceM === 0 ? '신고 지점 건물' : data.distanceM ? `신고 지점에 건물이 없어 가장 가까운 건물(${Math.round(data.distanceM)}m)을 표시` : '';
    const notes = (data.tacticalNotes || []).map((n) => `<li>${n}</li>`).join('');
    box.innerHTML = `
      <div class="bi-card">
        <div class="bi-title">건축물 정보</div>
        <table class="bi-table">
          <tr><th>주소</th><td>${addr}</td></tr>
          ${data.buildingName ? `<tr><th>건물명</th><td>${data.buildingName}</td></tr>` : ''}
          <tr><th>주용도</th><td>${data.mainUse || '-'}</td></tr>
          <tr><th>구조</th><td>${data.structure || '-'}</td></tr>
          <tr><th>지붕</th><td>${data.roof || '-'}</td></tr>
          <tr><th>층수</th><td>${data.floors || '-'}</td></tr>
          <tr><th>연면적</th><td>${area}</td></tr>
          <tr><th>사용승인</th><td>${data.useAprDay || '-'}</td></tr>
        </table>
        <div class="bi-src">출처: ${data.hasLedgerRecord ? '건축물대장(국토부)' : '도로명주소 건물(VWorld)'}${distNote ? ' · ' + distNote : ''}</div>
      </div>
      ${notes ? `<div class="bi-warn"><div class="bi-warn-title">건물 특성 주의 <span>일반 소방 상식 — 현장 검토</span></div><ul>${notes}</ul></div>` : ''}
    `;
  }

  async function fetchBuildingInfo(lat, lng) {
    const box = document.getElementById('building-info-box');
    const badge = document.getElementById('bldg-api-badge');
    badge.textContent = '건물 정보 조회 중...';
    box.innerHTML = '<p class="muted-text">건물 정보를 불러오는 중...</p>';

    try {
      if (!isHttpOrigin()) throw new Error('Skip /api/building on file:// protocol');
      const resp = await fetch(`/api/building?lat=${lat}&lng=${lng}`);
      if (!resp.ok) throw new Error('API status ' + resp.status);
      const data = await resp.json();
      if (data && (data.roadAddress || data.parcelAddress || data.found)) {
        lastBuildingInfo = data;
        renderBuildingInfoBox(data);
        return;
      }
      throw new Error('Fallback to browser VWorld JSONP');
    } catch (_) {
      try {
        const data = await enrichWithLedger(await fetchBuildingViaVWorldJsonp(lat, lng));
        lastBuildingInfo = data;
        renderBuildingInfoBox(data);
      } catch (err) {
        lastBuildingInfo = {
          found: false,
          hasLedgerRecord: false,
          ledgerStatus: '실시간 조회 실패 (네트워크 확인 필요)',
          lat: lat,
          lng: lng,
          roadAddress: null,
          parcelAddress: null,
          buildingName: null,
          mainUse: null,
          structure: null,
          floors: null,
          totalAreaM2: null,
          source: '조회 오류'
        };
        renderBuildingInfoBox(lastBuildingInfo);
      }
    }
  }

  async function generateAiBriefing(forceRemote) {
    const box = document.getElementById('ai-brief-box');
    if (!lastMission || !lastMission.found) {
      if (box && forceRemote) {
        box.innerHTML = '<div style="padding:10px 12px;border-radius:8px;background:#fff7ed;border:1px solid #fdba74;color:#c2410c;font-weight:700;">먼저 위 검색창에 주소를 넣거나 지도에서 불난 곳을 눌러 경로를 찾으세요. 그다음 [AI 전술 생성]을 누르면 됩니다.</div>';
      }
      return;
    }

    const spec = lastMission.vehicleSpec;
    const ep = getRouteEntryPoint(lastMission);
    const entLabel = ep && ep.name ? ep.name : `${lastMission.villageName || ''}마을 범위 진입점`;
    const startDesc = `의령소방서 → 🔶 ${entLabel}(마을 입구)`;
    const viaLine =
      Array.isArray(lastMission.navVia) && lastMission.navVia.length > 0
        ? `[전환·안전경유] ${lastMission.navVia.map((v, i) => (v.isBoundaryEntry || v.isMandatoryEntrance ? '마을범위진입:' : '경유' + (i + 1) + ':') + v.nodeId).join(' → ')} T맵/내비 연동\n`
        : '';
    const hydLabelStr =
      lastMission.nearestHydrant && lastMission.nearestHydrant.label
        ? /^(거점소화전|중계급수거점)-/.test(String(lastMission.nearestHydrant.label))
          ? `마을 안 실물 소화전 미확인 — 후착 물탱크차 중계 급수 (하차 지점에서 약 ${lastMission.nearestHydrant.distanceM}m 넓은 교차로)`
          : `소화전 (하차 지점에서 약 ${lastMission.nearestHydrant.distanceM}m) 점령 급수`
        : '자체 물탱크 급수 및 인근 자연수리 확보';
    const ruleSummary = lastMission.directVehicleAccess
      ? `[출동차량] ${spec.name} (기준폭 ${spec.threshold}m)\n` +
        `[출동경로] ${startDesc}\n` +
        viaLine +
        `[진입판정] 마을 입구부터 신고 지점 근처까지 마을 내 ${lastMission.villageVehicleDistanceM}m (총 ${(lastMission.vehicleDistanceM / 1000).toFixed(2)}km) 차량 직접 진입 가능 (예상 총 ${formatSecKo(lastMission.totalMissionSec)})\n` +
        `[전술지시] 현장 도착 즉시 화점 전면 부서 후 ${lastMission.hoseDistanceM}m(15m 호스 ${lastMission.requiredHose15mCount}본, 예비포함 ${lastMission.requiredHoseWithSpareCount}본) 직접 방수 전개\n` +
        `[급수대책] ${hydLabelStr}`
      : `[출동차량] ${spec.name} (기준폭 ${spec.threshold}m · 최소회전반경 ${spec.minTurnRadiusM}m)\n` +
        `[출동경로] ${startDesc}\n` +
        viaLine +
        `[진입제한] ${lastMission.bottleneck ? lastMission.bottleneck.message : '골목 협착'}\n` +
        `[1차 차량접근] ${startDesc}에서 신고 지점 ${lastMission.hoseDistanceM}m 앞 하차 지점까지 마을 내 ${lastMission.villageVehicleDistanceM}m (총 ${(lastMission.vehicleDistanceM / 1000).toFixed(2)}km) 진입 후 안전 부서\n` +
        `[2차 호스연장] 하차 거점에서 화점까지 ${lastMission.hoseDistanceM}m 구간 15m 소방호스 최소 ${lastMission.requiredHose15mCount}본(예비포함 ${lastMission.requiredHoseWithSpareCount}본) 도보 연장 및 중계방수 실시 (예상 총 ${formatSecKo(lastMission.totalMissionSec)})\n` +
        `[급수대책] ${hydLabelStr}`;

    if (window.FirewayGeminiAI && typeof window.FirewayGeminiAI.generateTacticalBriefing === 'function') {
      await window.FirewayGeminiAI.generateTacticalBriefing({
        mission: lastMission,
        building: lastBuildingInfo,
        ruleSummary: ruleSummary,
        regionName: currentIndex ? currentIndex.name : '경상남도 의령군',
        forceRemote: Boolean(forceRemote),
        boxEl: box
      });
      return;
    }

    if (!forceRemote || !isHttpOrigin()) {
      return;
    }

    if (box) box.textContent = 'AI 현장 지휘 브리핑 생성 중...';
    try {
      const resp = await fetch('/api/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mission: lastMission,
          building: lastBuildingInfo,
          ruleSummary: ruleSummary,
          regionName: currentIndex ? currentIndex.name : ''
        })
      });
      if (!resp.ok) throw new Error('Brief API status ' + resp.status);
      const data = await resp.json();
      if (box) box.textContent = data.briefing || ruleSummary;
    } catch (_) {
      if (box) box.textContent = ruleSummary;
    }
  }

  const TUTORIAL_STEPS = [
    {
      targets: ['map-floating-search-bar', 'control-item-village-search'],
      title: '1. 위 검색창에 주소 넣기',
      desc:
        '지도 위 <strong>검색창</strong>에 도로명·지번 주소, 건물명, 마을명을 넣고 <strong>[주소로 경로탐색]</strong>을 누릅니다. 의령군 239개 마을 모두 됩니다.',
      panel: 'top'
    },
    {
      targets: ['mission-status-badge', 'right-panel'],
      title: '2. 소방서→마을 입구는 T맵, 마을 안은 골목 판정',
      desc:
        '출발은 <strong>🚒 의령소방서</strong>입니다. <strong>🔶 마을 입구</strong>까지는 T맵 길, 그 안은 도로 폭·회전반경을 따져 소방차가 갈 수 있는 곳까지 안내하고 나머지는 호스로 연장합니다.',
      panel: 'left'
    },
    {
      targets: ['map-container'],
      title: '3단계: 239개 분석 마을 사각형 범위 내 경로 산출',
      desc:
        '분석된 239개 마을의 주황색 사각형 범위 내 어느 곳이나 클릭하면 <strong>🚒 의령소방서 → 🔶 마을 범위 진입점(주황 실선) → 🛑 1차 소방차 하차거점(청록 실선) → 🔴 2차 소방호스 연장 화점(적색 점선)</strong> 경로가 산출됩니다.',
      panel: 'map',
      zoomInMap: true,
      bannerPreview:
        '의령소방서 → 🔶 마을 입구 → 불난 곳'
    }
  ];

  let tutorialActive = false;
  let tutorialStepIdx = 0;
  let tutorialBaseZoom = null;
  let tutorialZoomedIn = false;

  function clearTutorialHighlights() {
    document.querySelectorAll('.tutorial-target-active').forEach((el) => {
      el.classList.remove('tutorial-target-active');
    });
  }

  function startTutorial() {
    tutorialActive = true;
    tutorialStepIdx = 0;
    tutorialBaseZoom = map ? map.getZoom() : null;
    tutorialZoomedIn = false;
    switchDrawerTab('route', true);
    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.remove('hidden');
    renderTutorialStep();
  }

  function closeTutorial() {
    tutorialActive = false;
    tutorialZoomedIn = false;
    clearTutorialHighlights();
    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (routeSelectStep === 'idle') {
      const banner = document.getElementById('map-pick-banner');
      if (banner) banner.classList.add('hidden');
    }
  }

  let currentDrawerTab = 'route';
  const THEME_STORAGE_KEY = 'fireway_ui_theme_v2';

  const DRAWER_TAB_META = {
    route: {
      icon: '🚒',
      title: '출동 길찾기 · 전술 브리핑',
      desc: '차량 제원 선택 · 출발/화점 경로탐색 · 내비 연동'
    },
    brief: {
      icon: '🏢',
      title: '화점 건축물대장 · AI 브리핑',
      desc: '건물 정보 · AI 전술'
    },
    status: {
      icon: '📊',
      title: '지역 도로망 현황 · 마을 목록',
      desc: '진입 가능/차단 통계 및 현재 읍·면 마을 빠른 이동'
    },
    village: {
      icon: '🏘',
      title: '마을정보',
      desc: '책자 진입곤란·급수·작전'
    },
    layer: {
      icon: '🗂',
      title: '공간 진단 레이어 · 범례',
      desc: '방식 B 도로망 · 위성 실측 · 분절 병합점 · 범례'
    }
  };

  const MOBILE_MQ = window.matchMedia('(max-width: 840px)');
  function updateDrawerHandle() {
    const leftPanel = document.getElementById('left-panel');
    const btn = document.getElementById('btn-toggle-left-panel');
    if (!leftPanel || !btn) return;
    const collapsed = leftPanel.classList.contains('collapsed');
    if (MOBILE_MQ.matches) {
      btn.textContent = collapsed ? '▲ 패널 열기' : '▼ 지도 크게';
      btn.title = collapsed ? '패널 펼치기' : '패널 접고 지도 크게 보기';
    } else {
      btn.textContent = collapsed ? '◀' : '▶';
      btn.title = collapsed ? '패널 펼치기' : '패널 접고 지도 크게 보기';
    }
  }
  MOBILE_MQ.addEventListener && MOBILE_MQ.addEventListener('change', updateDrawerHandle);

  // 지도 위 범례: 켜기/끄기 (브라우저에 기억, 모바일은 처음에 접힘)
  function setLegendOpen(open) {
    const box = document.getElementById('map-legend-float');
    const btn = document.getElementById('btn-legend-toggle');
    if (!box || !btn) return;
    box.classList.toggle('closed', !open);
    btn.setAttribute('aria-expanded', String(open));
    const st = btn.querySelector('.legend-float-state');
    if (st) st.textContent = open ? '끄기' : '켜기';
    try { localStorage.setItem('fw_legend_open', open ? '1' : '0'); } catch (_) {}
  }
  function initLegendToggle() {
    const btn = document.getElementById('btn-legend-toggle');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    let saved = null;
    try { saved = localStorage.getItem('fw_legend_open'); } catch (_) {}
    setLegendOpen(saved === null ? !MOBILE_MQ.matches : saved === '1');
    btn.addEventListener('click', () => {
      const box = document.getElementById('map-legend-float');
      setLegendOpen(box && box.classList.contains('closed'));
    });
  }
  document.addEventListener('DOMContentLoaded', initLegendToggle);
  setTimeout(initLegendToggle, 0);
  document.addEventListener('DOMContentLoaded', updateDrawerHandle);
  setTimeout(updateDrawerHandle, 0);

  function setDrawerCollapsed(collapsed) {
    const leftPanel = document.getElementById('left-panel');
    const btnToggleLeft = document.getElementById('btn-toggle-left-panel');
    if (!leftPanel) return;
    leftPanel.classList.toggle('collapsed', Boolean(collapsed));
    updateDrawerHandle();
    refreshMapSizeAfterPanelChange();
  }

  function switchDrawerTab(tabName, expandIfCollapsed = true) {
    const nextTab = DRAWER_TAB_META[tabName] ? tabName : 'route';
    currentDrawerTab = nextTab;

    const leftPanel = document.getElementById('left-panel');
    if (expandIfCollapsed && leftPanel && leftPanel.classList.contains('collapsed')) {
      setDrawerCollapsed(false);
    }

    document.querySelectorAll('#naver-rail .rail-tab[data-drawer-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.drawerTab === nextTab);
    });

    const meta = DRAWER_TAB_META[nextTab] || DRAWER_TAB_META.route;
    const headerEl = document.getElementById('drawer-tab-header');
    const iconEl = document.getElementById('drawer-tab-icon');
    const titleEl = document.getElementById('drawer-tab-title');
    const descEl = document.getElementById('drawer-tab-desc');
    const showAllBtn = document.getElementById('btn-drawer-show-all');
    if (headerEl) headerEl.dataset.activeTab = nextTab;
    if (iconEl) iconEl.textContent = meta.icon;
    if (titleEl) titleEl.textContent = meta.title;
    if (descEl) descEl.textContent = meta.desc;
    if (showAllBtn) showAllBtn.classList.toggle('hidden', nextTab !== 'route');

    const rightPanel = document.getElementById('right-panel');
    if (rightPanel) {
      const hasRightSection = nextTab === 'route' || nextTab === 'brief';
      rightPanel.classList.toggle('tab-hidden', !hasRightSection);
      if (hasRightSection) {
        rightPanel.classList.remove('collapsed');
        const btnToggleRight = document.getElementById('btn-toggle-right-panel');
        if (btnToggleRight) btnToggleRight.textContent = '브리핑 접기';
      }
    }

    document.querySelectorAll('#left-panel [data-tab-section]').forEach((sec) => {
      const secType = sec.getAttribute('data-tab-section');
      const visible = secType === nextTab;
      sec.classList.toggle('tab-hidden', !visible);
      sec.style.display = visible ? '' : 'none';
    });

    if (leftPanel && expandIfCollapsed) {
      leftPanel.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function ensureRouteSectionVisible() {
    if (currentDrawerTab !== 'route') {
      switchDrawerTab('route', true);
    } else {
      const leftPanel = document.getElementById('left-panel');
      if (leftPanel && leftPanel.classList.contains('collapsed')) {
        setDrawerCollapsed(false);
      }
    }
  }

  function syncVehicleTabs(widthVal) {
    const numVal = Number(widthVal) || 2.5;
    document.querySelectorAll('.veh-tab[data-veh-width]').forEach((btn) => {
      const bVal = Number(btn.dataset.vehWidth);
      btn.classList.toggle('active', Math.abs(bVal - numVal) < 0.01);
    });
  }

  function applyTheme(mode) {
    const isNaver = mode !== 'dark';
    document.body.classList.toggle('theme-naver', isNaver);

    const btnHeaderTheme = document.getElementById('btn-toggle-theme');
    if (btnHeaderTheme) {
      btnHeaderTheme.classList.toggle('active', isNaver);
      btnHeaderTheme.textContent = isNaver ? '🌙 다크 테마' : '☀️ 네이버 테마';
    }

    const btnRailTheme = document.getElementById('btn-rail-theme');
    if (btnRailTheme) {
      btnRailTheme.classList.toggle('active', isNaver);
      const iconEl = btnRailTheme.querySelector('.rail-icon');
      const labelEl = btnRailTheme.querySelector('.rail-label');
      if (iconEl) iconEl.textContent = isNaver ? '🌙' : '☀️';
      if (labelEl) labelEl.textContent = isNaver ? '다크테마' : '네이버톤';
    }

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, isNaver ? 'naver' : 'dark');
    } catch (_) {}
  }

  function toggleTheme() {
    const isCurrentlyNaver = document.body.classList.contains('theme-naver');
    applyTheme(isCurrentlyNaver ? 'dark' : 'naver');
  }

  function initTheme() {
    let saved = 'naver';
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'naver' || stored === 'dark') {
        saved = stored;
      }
    } catch (_) {}
    applyTheme(saved);
  }

  function positionTutorialBoxes(step) {
    const spotlight = document.getElementById('tutorial-spotlight');
    const card = document.getElementById('tutorial-card');
    if (!spotlight || !card) return;

    const els = (step.targets || [])
      .map((id) => document.getElementById(id))
      .filter((el) => el && el.offsetParent !== null);

    if (els.length === 0) return;

    let top = Infinity;
    let left = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < top) top = r.top;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
    });

    if (step.panel === 'map') {
      const dockEl = document.getElementById('naver-dock');
      if (dockEl) {
        const dockRect = dockEl.getBoundingClientRect();
        if (dockRect.right > left && dockRect.right < right - 120) {
          left = dockRect.right;
        }
      }
    }

    const pad = step.panel === 'map' ? -10 : 6;
    const sTop = Math.max(4, top - pad);
    const sLeft = Math.max(4, left - pad);
    const sWidth = Math.min(window.innerWidth - sLeft - 4, right - left + pad * 2);
    const sHeight = Math.min(window.innerHeight - sTop - 4, bottom - top + pad * 2);

    spotlight.style.top = `${sTop}px`;
    spotlight.style.left = `${sLeft}px`;
    spotlight.style.width = `${Math.max(40, sWidth)}px`;
    spotlight.style.height = `${Math.max(28, sHeight)}px`;

    const cardRect = card.getBoundingClientRect();
    const cardW = cardRect.width || 390;
    const cardH = cardRect.height || 210;

    let cTop = sTop + sHeight + 16;
    let cLeft = sLeft;

    if (step.panel === 'map') {
      const routeBtn =
        document.getElementById('btn-route-search') ||
        document.getElementById('btn-pick-start') ||
        document.getElementById('btn-drawer-show-all');
      if (routeBtn && routeBtn.offsetParent !== null) {
        const rb = routeBtn.getBoundingClientRect();
        cTop = rb.bottom + 16;
        cLeft = Math.max(14, Math.min(window.innerWidth - cardW - 14, rb.left));
      } else {
        cTop = Math.max(78, sTop + 56);
        cLeft = sLeft + Math.max(12, (sWidth - cardW) / 2);
      }
    } else {
      if (cLeft + cardW > window.innerWidth - 14) {
        cLeft = Math.max(14, window.innerWidth - cardW - 14);
      }
      if (cTop + cardH > window.innerHeight - 14) {
        cTop = Math.max(14, sTop - cardH - 16);
      }
    }

    card.style.top = `${Math.round(cTop)}px`;
    card.style.left = `${Math.round(cLeft)}px`;
  }

  function renderTutorialStep() {
    if (!tutorialActive) return;
    clearTutorialHighlights();

    const step = TUTORIAL_STEPS[tutorialStepIdx];
    if (!step) return;

    if (step.panel === 'map') {
      centerMapInWorkspace();
    }

    // 3단계 진입 시 지도를 약간 확대하여 출발-화점 선택 지점을 보기 쉽게 표시
    if (step.zoomInMap && map) {
      const baseZ = tutorialBaseZoom !== null ? tutorialBaseZoom : map.getZoom();
      const targetZ = Math.min(18, Math.max(baseZ + 1, 16));
      if (!tutorialZoomedIn) {
        tutorialZoomedIn = true;
        map.flyTo(map.getCenter(), targetZ, { duration: 0.55 });
      }
    } else if (!step.zoomInMap && tutorialZoomedIn && map && tutorialBaseZoom !== null) {
      tutorialZoomedIn = false;
      map.flyTo(map.getCenter(), tutorialBaseZoom, { duration: 0.45 });
    }

    // 지도 단계일 때 상단 안내 배너 미리보기 표시
    const banner = document.getElementById('map-pick-banner');
    if (banner) {
      if (step.bannerPreview) {
        banner.textContent = step.bannerPreview;
        banner.classList.remove('hidden');
      } else if (routeSelectStep === 'idle') {
        banner.classList.add('hidden');
      }
    }

    // 대상 요소 밝게 하이라이트
    const targetEls = (step.targets || [])
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    targetEls.forEach((el) => el.classList.add('tutorial-target-active'));

    // 카드 텍스트 및 단계 표시 업데이트
    const isLastStep = tutorialStepIdx === TUTORIAL_STEPS.length - 1;
    document.getElementById('tutorial-step-badge').textContent = `STEP ${tutorialStepIdx + 1} / ${TUTORIAL_STEPS.length}`;
    document.getElementById('tutorial-step-title').textContent = step.title;
    document.getElementById('tutorial-step-desc').innerHTML = step.desc;

    const dotsWrap = document.getElementById('tutorial-step-dots');
    if (dotsWrap) {
      dotsWrap.innerHTML = '';
      TUTORIAL_STEPS.forEach((_, idx) => {
        const dot = document.createElement('span');
        dot.className = 'tutorial-dot' + (idx === tutorialStepIdx ? ' active' : '');
        dot.title = `${idx + 1}단계로 이동`;
        dot.addEventListener('click', () => {
          tutorialStepIdx = idx;
          renderTutorialStep();
        });
        dotsWrap.appendChild(dot);
      });
    }

    const prevBtn = document.getElementById('btn-tutorial-prev');
    const skipBtn = document.getElementById('btn-tutorial-skip');
    const nextBtn = document.getElementById('btn-tutorial-next');
    if (prevBtn) prevBtn.disabled = tutorialStepIdx === 0;
    if (skipBtn) skipBtn.classList.toggle('hidden', isLastStep);
    if (nextBtn) {
      nextBtn.textContent = isLastStep ? '안내화면 종료 ✕' : '다음 단계 ▶';
    }

    positionTutorialBoxes(step);
    setTimeout(() => {
      if (tutorialActive) positionTutorialBoxes(step);
    }, 280);
  }

  function bindEvents() {
    document.getElementById('region-select').addEventListener('change', (e) => {
      selectRegion(e.target.value, '');
    });

    document.getElementById('village-select').addEventListener('change', async (e) => {
      const val = e.target.value;
      if (!val) {
        selectVillage('', true);
        return;
      }
      const vObj =
        catalog && Array.isArray(catalog.villages)
          ? catalog.villages.find((v) => v.id === val)
          : null;
      if (vObj && vObj.regionId && vObj.regionId !== currentRegionCode) {
        document.getElementById('region-select').value = vObj.regionId;
        await selectRegion(vObj.regionId, vObj.id);
      } else {
        selectVillage(val, true);
      }
    });

    const vehSelectEl = document.getElementById('vehicle-select');
    if (vehSelectEl) {
      vehSelectEl.value = String(currentThreshold);
      vehSelectEl.addEventListener('change', (e) => {
        currentThreshold = Number(e.target.value) || 2.5;
        syncVehicleTabs(currentThreshold);
        refreshNetworkAndLayers();
      });
    }
    syncVehicleTabs(currentThreshold);

    document.querySelectorAll('.veh-tab[data-veh-width]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const w = Number(btn.dataset.vehWidth) || 2.5;
        currentThreshold = w;
        const sel = document.getElementById('vehicle-select');
        if (sel) sel.value = String(w);
        syncVehicleTabs(w);
        refreshNetworkAndLayers();
      });
    });

    document.querySelectorAll('#naver-rail .rail-tab[data-drawer-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-drawer-tab') || 'route';
        switchDrawerTab(targetTab, true);
      });
    });

    const btnShowAll = document.getElementById('btn-drawer-show-all');
    if (btnShowAll) {
      btnShowAll.addEventListener('click', () => {
        centerMapInWorkspace();
        startRouteSearchFlow();
      });
    }

    ['btn-toggle-theme', 'btn-rail-theme'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', () => {
          toggleTheme();
        });
      }
    });

    [
      { id: 'link-nav-tmap', app: 'tmap' },
      { id: 'link-nav-naver', app: 'naver' },
      { id: 'link-nav-kakao', app: 'kakao' }
    ].forEach(({ id, app }) => {
      const navEl = document.getElementById(id);
      if (navEl) {
        navEl.addEventListener('click', (e) => {
          const href = navEl.getAttribute('href') || '#';
          if (href === '#') {
            e.preventDefault();
          }
          openNavAppInfoPopup(app, href);
        });
      }
    });

    const btnRouteSearch = document.getElementById('btn-route-search');
    if (btnRouteSearch) {
      btnRouteSearch.addEventListener('click', () => {
        centerMapInWorkspace();
        startRouteSearchFlow();
      });
    }

    ['btn-how-to-use', 'btn-rail-how-to-use'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', () => {
          startTutorial();
        });
      }
    });

    const btnTutPrev = document.getElementById('btn-tutorial-prev');
    if (btnTutPrev) {
      btnTutPrev.addEventListener('click', () => {
        if (tutorialStepIdx > 0) {
          tutorialStepIdx--;
          renderTutorialStep();
        }
      });
    }

    const btnTutNext = document.getElementById('btn-tutorial-next');
    if (btnTutNext) {
      btnTutNext.addEventListener('click', () => {
        if (tutorialStepIdx < TUTORIAL_STEPS.length - 1) {
          tutorialStepIdx++;
          renderTutorialStep();
        } else {
          closeTutorial();
        }
      });
    }

    ['btn-tutorial-close', 'btn-tutorial-skip'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', () => {
          closeTutorial();
        });
      }
    });

    const btnPickStart = document.getElementById('btn-pick-start');
    if (btnPickStart) {
      btnPickStart.addEventListener('click', () => {
        centerMapInWorkspace();
        startRouteSearchFlow();
      });
    }

    const btnToggleLeft = document.getElementById('btn-toggle-left-panel');
    if (btnToggleLeft) {
      btnToggleLeft.addEventListener('click', () => {
        const leftPanel = document.getElementById('left-panel');
        if (!leftPanel) return;
        const willCollapse = !leftPanel.classList.contains('collapsed');
        setDrawerCollapsed(willCollapse);
      });
    }

    const btnToggleRight = document.getElementById('btn-toggle-right-panel');
    if (btnToggleRight) {
      btnToggleRight.addEventListener('click', () => {
        const rightPanel = document.getElementById('right-panel');
        if (!rightPanel) return;
        if (rightPanel.classList.contains('tab-hidden')) {
          switchDrawerTab('route', true);
          rightPanel.classList.remove('collapsed');
          btnToggleRight.textContent = '브리핑 접기';
          return;
        }
        const collapsed = rightPanel.classList.toggle('collapsed');
        btnToggleRight.textContent = collapsed ? '브리핑 펼치기' : '브리핑 접기';
        refreshMapSizeAfterPanelChange();
      });
    }

    const btnStation = document.getElementById('btn-station-start');
    if (btnStation) {
      btnStation.addEventListener('click', () => {
        toggleStationStart();
      });
    }

    const btnResetStart = document.getElementById('btn-reset-start');
    if (btnResetStart) {
      btnResetStart.addEventListener('click', () => {
        resetCustomStart();
      });
    }

    const btnTmapRecalc = document.getElementById('btn-tmap-recalc');
    if (btnTmapRecalc) {
      btnTmapRecalc.addEventListener('click', () => {
        if (lastMission && lastMission.found) {
          requestAndRenderExternalRoute(lastMission, 'tmap');
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (tutorialActive) {
        if (e.key === 'Escape') {
          closeTutorial();
        } else if (e.key === 'ArrowRight') {
          if (tutorialStepIdx < TUTORIAL_STEPS.length - 1) {
            tutorialStepIdx++;
            renderTutorialStep();
          }
        } else if (e.key === 'ArrowLeft') {
          if (tutorialStepIdx > 0) {
            tutorialStepIdx--;
            renderTutorialStep();
          }
        }
        return;
      }
      if (e.key === 'Escape' && routeSelectStep !== 'idle') {
        setRouteSelectStep('idle');
      }
    });

    const btnToggleHybrid = document.getElementById('btn-toggle-hybrid');
    if (btnToggleHybrid) {
      btnToggleHybrid.addEventListener('click', (e) => {
        hybridVisible = !hybridVisible;
        if (hybridVisible) {
          hybridLayer.addTo(map);
          e.target.classList.add('active');
          e.target.textContent = '지명라벨 ON';
        } else {
          map.removeLayer(hybridLayer);
          e.target.classList.remove('active');
          e.target.textContent = '지명라벨 OFF';
        }
      });
    }

    const btnPrint = document.getElementById('btn-print');
    if (btnPrint) {
      btnPrint.addEventListener('click', () => {
        window.print();
      });
    }

    const btnAiBrief = document.getElementById('btn-ai-brief');
    if (btnAiBrief) {
      btnAiBrief.addEventListener('click', () => {
        generateAiBriefing(true);
      });
    }

    if (window.FirewayGeminiAI && typeof window.FirewayGeminiAI.initUI === 'function') {
      window.FirewayGeminiAI.initUI();
    }

    ['chk-layer-doc-rect', 'chk-layer-roads', 'chk-layer-buildings', 'chk-layer-hydrants', 'chk-layer-nodes', 'chk-layer-pass'].forEach(
      (id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', renderMapLayers);
      }
    );
    const lgTruck = document.getElementById('lg-truck-ico');
    if (lgTruck) lgTruck.innerHTML = truckSvg('#dc2626', 16);
    const lgRows = document.getElementById('lg-truck-kinds');
    if (lgRows) lgRows.innerHTML = VEHICLE_STOPS.map((v) => `<span>${truckSvg(v.color, 14)}${v.key}</span>`).join('');
    const vsChk = document.getElementById('chk-layer-vstops');
    if (vsChk) vsChk.addEventListener('change', () => {
      if (!vehStopLayer || !map) return;
      if (vsChk.checked) vehStopLayer.addTo(map); else map.removeLayer(vehStopLayer);
    });

    ['chk-diag-raw', 'chk-diag-sat', 'chk-diag-splits'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', renderDiagLayers);
    });

    window.addEventListener('resize', () => {
      refreshMapSizeAfterPanelChange();
      if (tutorialActive && TUTORIAL_STEPS[tutorialStepIdx]) {
        positionTutorialBoxes(TUTORIAL_STEPS[tutorialStepIdx]);
      }
    });
  }

  function refreshMapSizeAfterPanelChange() {
    if (map) map.invalidateSize();
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 280);
  }

  function centerMapInWorkspace() {
    const workspace = document.querySelector('.workspace');
    const mapContainer = document.getElementById('map-container');
    if (!workspace || !mapContainer) return;
    if (workspace.scrollWidth > workspace.clientWidth + 8) {
      const targetLeft =
        mapContainer.offsetLeft - Math.max(0, (workspace.clientWidth - mapContainer.offsetWidth) / 2);
      workspace.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initMap();
    bindEvents();
    switchDrawerTab('route', false);
    loadCatalog();
    setTimeout(() => {
      centerMapInWorkspace();
    }, 120);
  });
})();
