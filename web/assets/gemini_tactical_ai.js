/**
 * 농골길 V2 — Gemini AI 실시간 현장 소화 전술 브리핑 모듈 (gemini_tactical_ai.js)
 * - 화점 건축물대장 표제부(주구조·지붕구조·지상/지하 층수·높이·주용도·연면적·사용승인일)와
 *   현행 출동·진입 판정 브리핑(차량 진입 가능 여부·하차 거점·15m 호스 본수·최단 소화전)을 통합하여
 *   Google Gemini REST API 또는 백엔드 프록시(/api/brief)를 통해 맞춤형 소화 전술을 생성합니다.
 */
(function () {
  'use strict';

  const STORAGE_KEY_API = 'fireway_gemini_api_key';
  const STORAGE_KEY_MODEL = 'fireway_gemini_model_v2';
  const STORAGE_KEY_PROMPT = 'fireway_gemini_prompt_template_v2';

  const DEFAULT_MODEL = 'gemini-flash-lite-latest';
  const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemma-4-26b-a4b-it'];

  const DEFAULT_PROMPT_TEMPLATE = [
    '당신은 소방 현장지휘관의 전술참모입니다. 아래 정보로 출동 대원이 무전·차 안에서 10초 안에 읽을 수 있는 현장 전술 요약을 쓰십시오.',
    '',
    '[건물 정보]',
    '{{BUILDING_INFO}}',
    '',
    '[출동·진입 판정]',
    '{{MISSION_BRIEF}}',
    '',
    '규칙:',
    '- 아래 5줄 형식만 출력. 인사말·서론·결론·구분선·굵게(**) 금지',
    '- 각 줄 40자 이내, 명사형으로 끝맺음, 숫자(거리·본수·층수)는 그대로',
    '- 주어진 정보에 없는 내용은 지어내지 말 것',
    '',
    '형식:',
    '위험: (구조·지붕·용도에 따른 핵심 위험 1가지)',
    '차량: (어디까지 진입·부서)',
    '호스: (거리·본수)',
    '급수: (소화전 또는 물탱크 중계)',
    '주의: (대원 안전 1가지)'
  ].join('\n');

  let uiOptions = {
    onGenerateRequested: null
  };
  let lastContext = null;
  let requestSeq = 0;

  function safeGetStorage(key, fallbackVal) {
    try {
      const val = window.localStorage.getItem(key);
      return val !== null && val !== undefined ? val : fallbackVal;
    } catch (_) {
      return fallbackVal;
    }
  }

  function safeSetStorage(key, val) {
    try {
      if (val === null || val === undefined || val === '') {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, String(val));
      }
    } catch (_) {}
  }

  function getPromptInputEl() {
    return (
      document.getElementById('gemini-prompt-textarea') ||
      document.getElementById('gemini-prompt-input')
    );
  }

  function getApiKey() {
    const inputEl = document.getElementById('gemini-api-key-input');
    const fromStorage = String(safeGetStorage(STORAGE_KEY_API, '') || '').trim();
    if (fromStorage) return fromStorage;
    if (inputEl && String(inputEl.value || '').trim()) {
      return String(inputEl.value || '').trim();
    }
    return '';
  }

  function setApiKey(key) {
    const clean = String(key || '').trim();
    safeSetStorage(STORAGE_KEY_API, clean);
    const inputEl = document.getElementById('gemini-api-key-input');
    if (inputEl && inputEl.value !== clean) {
      inputEl.value = clean;
    }
    updateKeyStatusBadge();
  }

  function hasApiKey() {
    return Boolean(getApiKey());
  }

  function getModel() {
    const selEl = document.getElementById('gemini-model-select');
    const saved = String(safeGetStorage(STORAGE_KEY_MODEL, '') || '').trim();
    if (saved) return saved;
    if (selEl && String(selEl.value || '').trim()) {
      return String(selEl.value || '').trim();
    }
    return DEFAULT_MODEL;
  }

  function setModel(model) {
    const clean = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    safeSetStorage(STORAGE_KEY_MODEL, clean);
    const selEl = document.getElementById('gemini-model-select');
    if (selEl && selEl.value !== clean) {
      selEl.value = clean;
    }
  }

  function getPromptTemplate() {
    const txtEl = getPromptInputEl();
    const saved = String(safeGetStorage(STORAGE_KEY_PROMPT, '') || '').trim();
    if (saved) return saved;
    if (txtEl && String(txtEl.value || '').trim()) {
      return String(txtEl.value || '').trim();
    }
    return DEFAULT_PROMPT_TEMPLATE;
  }

  function setPromptTemplate(prompt) {
    const clean = String(prompt || '').trim() || DEFAULT_PROMPT_TEMPLATE;
    safeSetStorage(STORAGE_KEY_PROMPT, clean);
    const txtEl = getPromptInputEl();
    if (txtEl && txtEl.value !== clean) {
      txtEl.value = clean;
    }
  }

  function resetPromptTemplate() {
    safeSetStorage(STORAGE_KEY_PROMPT, DEFAULT_PROMPT_TEMPLATE);
    const txtEl = getPromptInputEl();
    if (txtEl) {
      txtEl.value = DEFAULT_PROMPT_TEMPLATE;
    }
    return DEFAULT_PROMPT_TEMPLATE;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatSecKo(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}초`;
    return r > 0 ? `${m}분 ${r}초` : `${m}분`;
  }

  /**
   * 화점 건축물의 주구조·지붕·층수·용도를 분석하여 구조/층수 맞춤형 핵심 전술 진단 항목을 도출합니다.
   */
  function analyzeStructureAndFloors(building) {
    const b = building || {};
    const rawStructure = String(b.structure || '').trim();
    const rawRoof = String(b.roof || '').trim();
    const rawUse = String(b.mainUse || b.etcUse || '').trim();
    const grnd = Number.isFinite(Number(b.groundFloors)) && Number(b.groundFloors) > 0 ? Number(b.groundFloors) : null;
    const ugrnd =
      Number.isFinite(Number(b.undergroundFloors)) && Number(b.undergroundFloors) > 0
        ? Number(b.undergroundFloors)
        : 0;
    const heightM = Number.isFinite(Number(b.heightM)) && Number(b.heightM) > 0 ? Number(b.heightM) : null;

    const structureLabel =
      [rawStructure, rawRoof ? `지붕:${rawRoof}` : ''].filter(Boolean).join(' · ') ||
      '표제부 미등재 (농어촌 단층 노후 조적·목구조 주택 또는 경량철골 창고 추정)';

    let floorsLabel = b.floors ? String(b.floors).trim() : '';
    if (!floorsLabel) {
      if (grnd !== null) {
        floorsLabel = `지상 ${grnd}층` + (ugrnd > 0 ? ` / 지하 ${ugrnd}층` : '');
      } else {
        floorsLabel = '표제부 미등재 (농어촌 지상 1층 단층 건축물 추정)';
      }
    }
    if (heightM !== null && !floorsLabel.includes('높이')) {
      floorsLabel += ` (높이 ${heightM}m)`;
    }

    const stCombined = `${rawStructure} ${rawRoof}`;
    let structureTactic = '';
    if (/목구조|한옥|통나무/.test(stCombined)) {
      structureTactic =
        '목구조(한옥·일반목구조) 특성상 화염 전파가 매우 빠르고 지붕틀(서까래·반자) 일체형 붕괴 위험이 높으므로, 초기 대량 주수로 천장 속 은폐 화점을 제압하고 인접 건물 수막 방어를 최우선 실시합니다.';
    } else if (/샌드위치|패널|슬레이트/.test(stCombined)) {
      structureTactic =
        '패널·슬레이트 구조 특성상 심재 급격 연소로 인한 농연·유독가스 발생 및 열변형 조기 붕괴 위험이 극히 높으므로, 무리한 옥내 진입을 제한하고 개구부 파괴 및 외부 공세 주수를 우선합니다.';
    } else if (/철골|강구조|강관|트러스|파이프|컨테이너|스틸/.test(stCombined)) {
      structureTactic =
        '철골·강구조 특성상 화재 열기(500~600℃ 이상) 축적 시 강재 강도 급락으로 예고 없는 지붕·기둥 좌굴 붕괴 위험이 있으므로, 지붕 트러스 및 기둥 냉각 주수를 병행하고 옥내 진입 시간을 엄격히 통제합니다.';
    } else if (/벽돌|블록|석구조|조적|토담/.test(stCombined)) {
      structureTactic =
        '조적조(벽돌·블록·시멘트블록) 특성상 고열 및 급격한 직사 주수 시 벽체 균열·전도 붕괴 및 지붕 낙하 위험이 있으므로, 벽체 처짐·균열 징후를 상시 감시하고 분무·직사 병행 주수를 실시합니다.';
    } else if (/철근콘크리트|콘크리트/.test(stCombined)) {
      structureTactic =
        '철근콘크리트조 특성상 내화성은 확보되나 구획실 내부 고열·가연성 가스 축적으로 플래시오버·백드래프트 위험이 높으므로, 진입 전 출입문 냉각 및 펄스(안개) 주수·배연을 선행합니다.';
    } else {
      structureTactic =
        '표제부 구조 미등재 농어촌 건축물로서 노후 조적·목구조 또는 가설 파이프·패널 구조일 가능성이 높으므로, 지붕재(슬레이트·패널) 낙하 및 초기 붕괴 위험을 가정하여 외부 안전 확인 후 진입합니다.';
    }

    let floorTactic = '';
    if (ugrnd > 0) {
      floorTactic = `지하층(지하 ${ugrnd}층 / 지상 ${grnd || 1}층) 보유 건축물로서 지하 열기·농연 역류 및 고립 위험이 크므로, 양압 배연기 설치·라이프라인 결착 및 지상/지하 분리 수관 전개를 실시합니다.`;
    } else if ((grnd !== null && grnd >= 3) || (heightM !== null && heightM >= 10)) {
      floorTactic = `지상 ${grnd || 3}층${heightM ? `(높이 ${heightM}m)` : ''} 중·고층 건축물로서 계단실 연돌효과에 의한 상층부 연기 확산이 빠르므로, 상층부 인명검색조를 동시 투입하고 수관 연장 여유분(층당 1~2본 추가) 및 복식사다리·고소 방수를 전개합니다.`;
    } else if (grnd === 2) {
      floorTactic =
        '지상 2층 건축물로서 1층 화점 제압과 동시에 2층 계단 및 외부 창문(복식사다리)을 통한 상층부 인명 검색·연소 확대 차단 수관을 분리 전개합니다.';
    } else {
      floorTactic =
        '지상 1층(단층 추정) 건축물로서 출입구 주방수구 진입과 동시에 반대편 개구부 보조방수구를 배치하여 포위 주수 및 천장 속 잔불 정밀 검색을 실시합니다.';
    }

    let useTactic = '';
    if (/노유자|의료|숙박|다중/.test(rawUse)) {
      useTactic = `주용도(${rawUse}) 특성상 자력 대피가 곤란한 요구조자 다수 발생 우려가 높으므로 인명 구조·대피 유도를 최우선 전개합니다.`;
    } else if (/동물|식물|창고|공장|위험물/.test(rawUse)) {
      useTactic = `주용도(${rawUse}) 특성상 내부 다량 가연물·농기계·유류 등으로 인한 화세 급격 확대 위험이 높으므로 대량 방수 및 연소 저지선 구축에 집중합니다.`;
    } else if (rawUse) {
      useTactic = `주용도(${rawUse}) 내부 거주자 유무를 최우선 확인하고 가연물 밀집 구획 집중 방수를 실시합니다.`;
    } else {
      useTactic = '농어촌 주거·부속창고 혼재 가능성을 고려하여 거주자 인명 검색 및 LPG 용기·보일러실 위험요소 차단을 병행합니다.';
    }

    return {
      structureLabel,
      floorsLabel,
      useLabel: rawUse || '표제부 미등재 (농어촌 단독주택·창고 추정)',
      structureTactic,
      floorTactic,
      useTactic
    };
  }

  /**
   * 화점 건축물대장 정보를 한국어 텍스트 블록({{BUILDING_INFO}})으로 포맷팅합니다.
   */
  function formatBuildingContext(building, regionName) {
    const b = building || {};
    const diag = analyzeStructureAndFloors(b);
    const addrRoad = b.roadAddress || '도로명주소 미부여 지점';
    const addrParcel = b.parcelAddress || '-';
    const bldgName = [b.buildingName, b.dongName].filter(Boolean).join(' · ') || '명칭 미등재';
    const ledgerStatus =
      b.ledgerStatus ||
      (b.hasLedgerRecord
        ? '건축물대장 표제부 등재 확인'
        : '건축물대장 표제부 미등재 (농어촌 미등기·노후 단층 주택/창고 추정)');

    const areaParts = [];
    if (b.totalAreaM2) areaParts.push(`연면적 ${b.totalAreaM2}㎡`);
    if (b.archAreaM2) areaParts.push(`건축면적 ${b.archAreaM2}㎡`);
    if (b.platAreaM2) areaParts.push(`대지면적 ${b.platAreaM2}㎡`);
    const areaStr = areaParts.length > 0 ? areaParts.join(' / ') : '표제부 미등재';

    const ratioParts = [];
    if (b.bcRat) ratioParts.push(`건폐율 ${b.bcRat}%`);
    if (b.vlRat) ratioParts.push(`용적률 ${b.vlRat}%`);
    const ratioStr = ratioParts.length > 0 ? ` (${ratioParts.join(' · ')})` : '';

    const notes = Array.isArray(b.tacticalNotes) && b.tacticalNotes.length > 0
      ? b.tacticalNotes.join(' / ')
      : `${diag.structureTactic}`;

    return [
      `- 관할 지역: ${regionName || '경상남도 의령군'}`,
      `- 도로명주소: ${addrRoad}`,
      `- 지번주소: ${addrParcel}`,
      `- 건물명/동명: ${bldgName}`,
      `- 표제부 등재상태: ${ledgerStatus}${b.source ? ` (${b.source})` : ''}`,
      `- 주구조 / 지붕구조: ${diag.structureLabel}`,
      `- 층수 / 높이: ${diag.floorsLabel}`,
      `- 주용도: ${diag.useLabel}`,
      `- 면적 정보: ${areaStr}${ratioStr}`,
      `- 사용승인일: ${b.useAprDay || '미등재'}`,
      `- 건축물대장 기반 소방 주의사항: ${notes}`
    ].join('\n');
  }

  /**
   * 출동·진입 판정 정보 및 현행 브리핑 원문을 한국어 텍스트 블록({{MISSION_BRIEF}})으로 포맷팅합니다.
   */
  function formatMissionContext(mission, ruleSummary, regionName) {
    const m = mission || {};
    const spec = m.vehicleSpec || { name: '중형펌프차', threshold: 2.5, minTurnRadiusM: 8.2 };
    const accessStr = m.directVehicleAccess
      ? '1차 소방차량 화점 인접 직접 진입 가능'
      : '1차 소방차량 화점 직접 진입 불가 (골목 폭원·회전반경 제한으로 하차 거점 부서 후 도보 호스 연장)';
    const bneckMsg =
      m.bottleneck && m.bottleneck.message
        ? m.bottleneck.message
        : m.directVehicleAccess
          ? '진입로 폭원 및 교차로 회전반경 확보'
          : '마을 내부 협소 골목 폭원 또는 교차로 회전반경 미달';
    const vehDistTotalKm = Number.isFinite(Number(m.vehicleDistanceM))
      ? `${(Number(m.vehicleDistanceM) / 1000).toFixed(2)}km (${Math.round(Number(m.vehicleDistanceM))}m)`
      : '-';
    const vilVehDistM = Number.isFinite(Number(m.villageVehicleDistanceM))
      ? `${Math.round(Number(m.villageVehicleDistanceM))}m`
      : '-';
    const hoseDistM = Number.isFinite(Number(m.hoseDistanceM)) ? Math.round(Number(m.hoseDistanceM)) : 0;
    const hoseCount = Number.isFinite(Number(m.requiredHose15mCount)) ? Number(m.requiredHose15mCount) : 1;
    const hoseSpareCount = Number.isFinite(Number(m.requiredHoseWithSpareCount))
      ? Number(m.requiredHoseWithSpareCount)
      : hoseCount + 1;
    const totalSec = Number.isFinite(Number(m.totalMissionSec)) ? Number(m.totalMissionSec) : 0;
    const hydStr = m.nearestHydrant
      ? /^(거점소화전|중계급수거점)-/.test(String(m.nearestHydrant.label || ''))
        ? `실물 소화전 미확인 · 물탱크차 중계급수 후보 거점(${String(m.nearestHydrant.label).replace(/^거점소화전-/, '중계급수거점-')}, 하차 거점 이격 ${m.nearestHydrant.distanceM}m — 후착 물탱크차 중계 급수 필수)`
        : `${m.nearestHydrant.label} (하차 거점으로부터 이격 ${m.nearestHydrant.distanceM}m)`
      : '인근 소화전 미확보 (자체 물탱크 방수 및 후착 물탱크차 중계 급수 필수)';

    const lines = [
      `- 출동 관할/마을: ${regionName || '경상남도 의령군'} ${m.villageName ? m.villageName + '마을' : ''}`.trim(),
      `- 출동 차량 제원: ${spec.name} (요구 도로폭 ${spec.threshold}m · 최소회전반경 ${spec.minTurnRadiusM || 8.2}m)`,
      `- 1차 차량 진입 판정: ${accessStr}`,
      `- 1차 차량 하차·전개 거점: 정점 ${m.stagingNodeId || '-'} (마을 범위 진입 후 ${vilVehDistM} / 소방서 출발 총 ${vehDistTotalKm})`,
      `- 진입 제한 병목 사유: ${bneckMsg}`,
      `- 2차 소방호스 연장 거리 및 소요량: ${hoseDistM}m (15m 소방호스 최소 ${hoseCount}본, 예비 포함 ${hoseSpareCount}본)`,
      `- 예상 총 소요시간: ${totalSec}초 (${formatSecKo(totalSec)})`,
      `- 최단 소화용수(소화전): ${hydStr}`
    ];

    if (ruleSummary) {
      lines.push('', '[현행 규칙 기반 브리핑 원문]', String(ruleSummary).trim());
    }

    return lines.join('\n');
  }

  /**
   * 프롬프트 템플릿의 {{BUILDING_INFO}}, {{MISSION_BRIEF}} 치환자를 실제 데이터로 치환합니다.
   * 사용자가 프롬프트를 수정하여 치환자를 지운 경우에도 하단에 컨텍스트를 자동 추가하여 누락을 방지합니다.
   */
  function buildStructuredPrompt(promptTemplate, mission, building, ruleSummary, regionName) {
    const tpl = String(promptTemplate || DEFAULT_PROMPT_TEMPLATE).trim() || DEFAULT_PROMPT_TEMPLATE;
    const buildingInfoText = formatBuildingContext(building, regionName);
    const missionBriefText = formatMissionContext(mission, ruleSummary, regionName);

    let out = tpl;
    const hasBldgPlaceholder = out.includes('{{BUILDING_INFO}}');
    const hasMissionPlaceholder = out.includes('{{MISSION_BRIEF}}');

    if (hasBldgPlaceholder) {
      out = out.split('{{BUILDING_INFO}}').join(buildingInfoText);
    }
    if (hasMissionPlaceholder) {
      out = out.split('{{MISSION_BRIEF}}').join(missionBriefText);
    }

    if (!hasBldgPlaceholder) {
      out += `\n\n[화점 건축물대장 정보]\n${buildingInfoText}`;
    }
    if (!hasMissionPlaceholder) {
      out += `\n\n[현행 브리핑 정보]\n${missionBriefText}`;
    }

    return out;
  }

  /**
   * API 키 미설정 시에도 건물의 주구조·층수 및 현행 브리핑을 결합한 현장 전술 요약을 생성합니다.
   */
  function buildStructureTacticalSummary(building, mission, ruleSummary, regionName) {
    const diag = analyzeStructureAndFloors(building);
    const m = mission || {};
    const hoseDistM = Number.isFinite(Number(m.hoseDistanceM)) ? Math.round(Number(m.hoseDistanceM)) : 0;
    const hoseCount = Number.isFinite(Number(m.requiredHose15mCount)) ? Number(m.requiredHose15mCount) : 1;
    const hoseSpareCount = Number.isFinite(Number(m.requiredHoseWithSpareCount))
      ? Number(m.requiredHoseWithSpareCount)
      : hoseCount + 1;

    const hoseGuideline = m.directVehicleAccess
      ? `화점 전면(${m.stagingNodeId || '-'}) 안전 부서 후 ${hoseDistM}m 구간 15m 호스 ${hoseCount}본(예비 포함 ${hoseSpareCount}본) 즉시 전개`
      : `하차 거점(${m.stagingNodeId || '-'}) 부서 후 협소 골목 ${hoseDistM}m 구간 15m 호스 최소 ${hoseCount}본(예비 포함 ${hoseSpareCount}본) 도보 연장 및 중계·이동식 동력펌프 방수`;

    return [
      ruleSummary ? String(ruleSummary).trim() : formatMissionContext(mission, '', regionName),
      '',
      `[건축물 주구조·층수 연동 기본 소화 전술]`,
      `• 대상 구조·층수: ${diag.structureLabel} / ${diag.floorsLabel} / ${diag.useLabel}`,
      `• 구조별 주수·붕괴 대응: ${diag.structureTactic}`,
      `• 층수별 진입·검색 전술: ${diag.floorTactic}`,
      `• 용도·호스 전개 지침: ${diag.useTactic} (${hoseGuideline})`
    ].join('\n');
  }

  /**
   * 마크다운 스타일의 AI 응답 텍스트를 읽기 쉬운 안전한 HTML로 변환합니다.
   */
  function formatAiTextToHtml(rawText) {
    const lines = String(rawText || '')
      .replace(/\r\n/g, '\n')
      .split('\n');
    const htmlLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return '<div class="ai-brief-spacer" style="height:6px;"></div>';
      }
      let safe = escapeHtml(trimmed);
      safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      if (/^#{1,4}\s+/.test(safe)) {
        const headingText = safe.replace(/^#{1,4}\s+/, '');
        return `<div class="ai-brief-section-title" style="font-weight:700;color:#2563eb;margin-top:6px;">${headingText}</div>`;
      }
      if (/^\d+\.\s*\[[^\]]+\]/.test(safe) || /^\[[^\]]+\]/.test(safe)) {
        return `<div class="ai-brief-section-title" style="font-weight:700;color:#1d4ed8;margin-top:6px;">${safe}</div>`;
      }
      return `<div class="ai-brief-line">${safe}</div>`;
    });
    return htmlLines.join('');
  }

  function renderAiBriefBox(boxEl, options) {
    if (!boxEl) return;
    const {
      isAiGenerated,
      modelName,
      mainText,
      errorMsg
    } = options;

    if (!isAiGenerated) {
      boxEl.style.whiteSpace = 'normal';
      if (errorMsg) {
        boxEl.innerHTML = `<div class="ai-brief-error-notice" style="padding:8px 10px;border-radius:6px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);font-size:12px;color:#dc2626;">⚠️ ${escapeHtml(errorMsg)}</div>`;
      } else {
        boxEl.textContent =
          '경로를 찾은 뒤 [AI 전술 생성]을 누르면 건물 정보와 진입·호스 판정을 바탕으로 전술을 만들어 줍니다.';
      }
      return;
    }

    boxEl.style.whiteSpace = 'normal';
    const KEYS = { 위험: '⚠️', 차량: '🚒', 호스: '🧯', 급수: '💧', 주의: '🦺' };
    const rows = [];
    String(mainText || '')
      .replace(/\*\*/g, '')
      .split(/\n+/)
      .forEach((line) => {
        const m = line.replace(/^[\s\-*•\d.]+/, '').match(/^(위험|차량|호스|급수|주의)\s*[:：]\s*(.+)$/);
        if (m) rows.push(m);
      });
    const body = rows.length
      ? `<table class="ai-tac">${rows
          .map((m) => `<tr><th>${KEYS[m[1]]} ${m[1]}</th><td>${escapeHtml(m[2].trim())}</td></tr>`)
          .join('')}</table>`
      : `<div class="ai-brief-content" style="line-height:1.6;white-space:normal;">${formatAiTextToHtml(mainText)}</div>`;
    boxEl.innerHTML = `${body}<div class="ai-tac-src">AI 생성 (${escapeHtml(modelName || DEFAULT_MODEL)}) · 현장 판단 우선</div>`;
  }

  function extractGeminiText(data) {
    const candidates = data && Array.isArray(data.candidates) ? data.candidates : [];
    if (candidates.length === 0) return '';
    const parts =
      candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts)
        ? candidates[0].content.parts
        : [];
    const nonThought = parts
      .filter((p) => !p.thought && typeof p.text === 'string' && p.text.trim())
      .map((p) => p.text.trim());
    if (nonThought.length > 0) return nonThought.join('\n');
    const anyText = parts
      .filter((p) => typeof p.text === 'string' && p.text.trim())
      .map((p) => p.text.trim());
    return anyText.join('\n');
  }

  /**
   * 브라우저에서 직접 Google Gemini REST API를 호출하며, 모델 404/미지원 오류 시 폴백 모델을 순차 시도합니다.
   */
  async function callGeminiDirect(finalPrompt, apiKey, preferredModel) {
    const cleanKey = String(apiKey || '').trim();
    if (!cleanKey) {
      throw new Error('Gemini API 키가 설정되지 않았습니다.');
    }

    const startModel = String(preferredModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const modelQueue = [startModel];
    FALLBACK_MODELS.forEach((m) => {
      if (!modelQueue.includes(m)) modelQueue.push(m);
    });

    let lastError = null;
    for (let i = 0; i < modelQueue.length; i++) {
      const m = modelQueue[i];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        m
      )}:generateContent?key=${encodeURIComponent(cleanKey)}`;

      try {
        const genConfig = {
          temperature: 0.35,
          maxOutputTokens: 800
        };


        let resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
            generationConfig: genConfig
          })
        });

        if (!resp.ok && resp.status === 400 && genConfig.thinkingConfig) {
          resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
            })
          });
        }

        if (!resp.ok) {
          let errDetail = `HTTP ${resp.status}`;
          try {
            const errJson = await resp.json();
            if (errJson && errJson.error && errJson.error.message) {
              errDetail = errJson.error.message;
            }
          } catch (_) {}

          // 404 또는 모델 미지원 오류인 경우 다음 폴백 모델 시도
          if (resp.status === 404 || (resp.status === 400 && /model|not found|supported/i.test(errDetail))) {
            lastError = new Error(`${m}: ${errDetail}`);
            continue;
          }
          throw new Error(errDetail);
        }

        const data = await resp.json();
        const text = extractGeminiText(data);
        if (!text) {
          lastError = new Error(`${m}: 빈 응답이 반환되었습니다.`);
          continue;
        }
        return { text, model: m };
      } catch (err) {
        lastError = err;
        if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(String(err && err.message))) {
          break;
        }
      }
    }

    throw lastError || new Error('Gemini API 호출 실패');
  }

  function updateKeyStatusBadge() {
    const statusEl = document.getElementById('gemini-key-status');
    const serverKey = Boolean(window.FW_CONFIG && window.FW_CONFIG.aiServer);
    const configured = hasApiKey() || serverKey;
    if (statusEl) {
      statusEl.textContent = hasApiKey() ? '(설정됨 ✓)' : serverKey ? '(기본 키 사용 중 ✓ · 개인 키 입력은 선택)' : '(미설정 — 클릭하여 입력)';
      statusEl.classList.toggle('configured', configured);
      statusEl.classList.toggle('is-set', configured);
      statusEl.classList.toggle('is-unset', !configured);
    }
  }

  function syncSettingsInputsFromStorage() {
    const keyInput = document.getElementById('gemini-api-key-input');
    const modelSelect = document.getElementById('gemini-model-select');
    const promptInput = getPromptInputEl();

    const storedKey = String(safeGetStorage(STORAGE_KEY_API, '') || '');
    const storedModel = String(safeGetStorage(STORAGE_KEY_MODEL, DEFAULT_MODEL) || DEFAULT_MODEL);
    const storedPrompt = String(
      safeGetStorage(STORAGE_KEY_PROMPT, DEFAULT_PROMPT_TEMPLATE) || DEFAULT_PROMPT_TEMPLATE
    );

    if (keyInput) keyInput.value = storedKey;
    if (modelSelect) modelSelect.value = storedModel;
    if (promptInput) promptInput.value = storedPrompt;
    updateKeyStatusBadge();
  }

  function openSettingsPanel(focusKeyInput) {
    const panel = document.getElementById('ai-settings-panel');
    const btnSettings = document.getElementById('btn-ai-settings');
    syncSettingsInputsFromStorage();
    if (panel) {
      panel.classList.remove('hidden');
    }
    if (btnSettings) {
      btnSettings.classList.add('active');
    }
    if (focusKeyInput) {
      const keyInput = document.getElementById('gemini-api-key-input');
      if (keyInput) {
        setTimeout(() => keyInput.focus(), 40);
      }
    }
  }

  function closeSettingsPanel() {
    const panel = document.getElementById('ai-settings-panel');
    const btnSettings = document.getElementById('btn-ai-settings');
    if (panel) {
      panel.classList.add('hidden');
    }
    if (btnSettings) {
      btnSettings.classList.remove('active');
    }
  }

  function toggleSettingsPanel() {
    const panel = document.getElementById('ai-settings-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
      openSettingsPanel(!hasApiKey());
    } else {
      closeSettingsPanel();
    }
  }

  /**
   * UI 컨트롤러 초기화 (#btn-ai-settings, #ai-settings-panel 등 바인딩)
   */
  function initUI(options) {
    if (options && typeof options === 'object') {
      if (typeof options.onGenerateRequested === 'function') {
        uiOptions.onGenerateRequested = options.onGenerateRequested;
      } else if (typeof options.onSettingsSaved === 'function') {
        uiOptions.onGenerateRequested = options.onSettingsSaved;
      }
    }

    syncSettingsInputsFromStorage();
    closeSettingsPanel();

    const btnSettings = document.getElementById('btn-ai-settings');
    if (btnSettings && !btnSettings.dataset.geminiBound) {
      btnSettings.dataset.geminiBound = '1';
      btnSettings.addEventListener('click', () => {
        toggleSettingsPanel();
      });
    }

    const btnKeyToggle = document.getElementById('btn-gemini-key-toggle');
    if (btnKeyToggle && !btnKeyToggle.dataset.geminiBound) {
      btnKeyToggle.dataset.geminiBound = '1';
      btnKeyToggle.addEventListener('click', () => {
        const keyInput = document.getElementById('gemini-api-key-input');
        if (!keyInput) return;
        const isPassword = keyInput.type === 'password';
        keyInput.type = isPassword ? 'text' : 'password';
        btnKeyToggle.textContent = isPassword ? '숨김' : '표시';
      });
    }

    const btnPromptReset = document.getElementById('btn-gemini-prompt-reset');
    if (btnPromptReset && !btnPromptReset.dataset.geminiBound) {
      btnPromptReset.dataset.geminiBound = '1';
      btnPromptReset.addEventListener('click', () => {
        resetPromptTemplate();
      });
    }

    const btnSave = document.getElementById('btn-gemini-settings-save');
    if (btnSave && !btnSave.dataset.geminiBound) {
      btnSave.dataset.geminiBound = '1';
      btnSave.addEventListener('click', () => {
        const keyInput = document.getElementById('gemini-api-key-input');
        const modelSelect = document.getElementById('gemini-model-select');
        const promptInput = getPromptInputEl();

        if (keyInput) setApiKey(keyInput.value);
        if (modelSelect) setModel(modelSelect.value);
        if (promptInput) setPromptTemplate(promptInput.value);

        updateKeyStatusBadge();
        closeSettingsPanel();
      });
    }

    const btnClose = document.getElementById('btn-gemini-settings-close');
    if (btnClose && !btnClose.dataset.geminiBound) {
      btnClose.dataset.geminiBound = '1';
      btnClose.addEventListener('click', () => {
        closeSettingsPanel();
      });
    }
  }

  /**
   * Gemini AI 실시간 현장 지휘 브리핑을 생성하고 #ai-brief-box에 렌더링합니다.
   */
  async function generateTacticalBriefing(params) {
    const opts = params || {};
    const mission = opts.mission;
    const building = opts.building;
    const ruleSummary = opts.ruleSummary || '';
    const regionName = opts.regionName || '경상남도 의령군';
    const forceRemote = Boolean(opts.forceRemote);
    const boxEl = opts.boxEl || document.getElementById('ai-brief-box');

    if (!boxEl || !mission || !mission.found) return;

    lastContext = { mission, building, ruleSummary, regionName, boxEl };
    const mySeq = ++requestSeq;

    const apiKey = getApiKey();
    const model = getModel();
    const promptTemplate = getPromptTemplate();
    const finalPrompt = buildStructuredPrompt(promptTemplate, mission, building, ruleSummary, regionName);
    const isHttpOrigin = Boolean(
      typeof window !== 'undefined' &&
        window.location &&
        (window.location.protocol === 'http:' || window.location.protocol === 'https:')
    );

    // 1. 브라우저에 Gemini API 키가 설정된 경우: 직접 Gemini REST API 호출 (실패 시 http/https 환경에서만 /api/brief 폴백)
    if (apiKey) {
      boxEl.innerHTML = `
        <div class="ai-brief-loading" style="padding:10px;border-radius:6px;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.25);font-size:12.5px;color:#1d4ed8;font-weight:600;">
          ⏳ Gemini AI (${escapeHtml(model)})가 화점 건축물대장(주구조·층수) 및 호스·진입 판정을 종합 분석 중입니다...
        </div>
      `;

      let directError = null;
      try {
        const res = await callGeminiDirect(finalPrompt, apiKey, model);
        if (mySeq !== requestSeq) return;
        renderAiBriefBox(boxEl, {
          isAiGenerated: true,
          modelName: res.model,
          mainText: res.text,
          errorMsg: null
        });
        return;
      } catch (err) {
        directError = err;
      }

      // 브라우저 직접 호출 실패 시 서버 프록시(/api/brief) 시도 (file:// 프로토콜에서는 호출하지 않음)
      if (isHttpOrigin) {
        try {
          const resp = await fetch('/api/brief', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mission,
              building,
              ruleSummary,
              regionName,
              apiKey,
              model,
              prompt: finalPrompt
            })
          });
          if (resp.ok) {
            const data = await resp.json();
            if (mySeq !== requestSeq) return;
            if (data && data.aiGenerated && data.briefing) {
              renderAiBriefBox(boxEl, {
                isAiGenerated: true,
                modelName: data.model || model,
                mainText: data.briefing,
                errorMsg: null
              });
              return;
            }
          }
        } catch (_) {}
      }

      if (mySeq !== requestSeq) return;
      renderAiBriefBox(boxEl, {
        isAiGenerated: false,
        modelName: model,
        mainText: '',
        errorMsg: directError ? directError.message : 'Gemini API 응답을 가져오지 못했습니다.'
      });
      return;
    }

    // 2. 브라우저에 API 키가 없는 경우: http/https 서버 환경에서만 서버 환경변수(GEMINI_API_KEY) 확인을 위해 /api/brief 호출 시도
    if (isHttpOrigin) {
      if (forceRemote) {
        boxEl.innerHTML = `
          <div class="ai-brief-loading" style="padding:10px;border-radius:6px;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.25);font-size:12.5px;color:#1d4ed8;font-weight:600;">
            ⏳ AI 현장 지휘 브리핑 생성 중...
          </div>
        `;
      }

      try {
        const resp = await fetch('/api/brief', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mission,
            building,
            ruleSummary,
            regionName,
            apiKey: '',
            model,
            prompt: finalPrompt
          })
        });
        if (resp.ok) {
          const data = await resp.json();
          if (mySeq !== requestSeq) return;
          if (data && data.aiGenerated && data.briefing) {
            renderAiBriefBox(boxEl, {
              isAiGenerated: true,
              modelName: data.model || model,
              mainText: data.briefing,
              errorMsg: null
            });
            return;
          }
        }
      } catch (_) {}
    }

    if (mySeq !== requestSeq) return;

    // 3. 브라우저와 서버 모두 API 키가 없는 경우: 사진의 기본 전술/안내 블록 없이 간결한 안내만 유지 (설정창 자동 열기 안 함)
    renderAiBriefBox(boxEl, {
      isAiGenerated: false,
      modelName: model,
      mainText: '',
      errorMsg: forceRemote
        ? 'Gemini API 키가 설정되지 않았습니다. 상단 [⚙️ 프롬프트·API키 설정]에서 API 키를 입력 후 저장해 주세요.'
        : null
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initUI();
    });
  } else {
    initUI();
  }

  window.FirewayGeminiAI = {
    STORAGE_KEY_API,
    STORAGE_KEY_MODEL,
    STORAGE_KEY_PROMPT,
    DEFAULT_MODEL,
    FALLBACK_MODELS,
    DEFAULT_PROMPT_TEMPLATE,
    getApiKey,
    setApiKey,
    hasApiKey,
    getModel,
    setModel,
    getPromptTemplate,
    setPromptTemplate,
    resetPromptTemplate,
    analyzeStructureAndFloors,
    formatBuildingContext,
    formatMissionContext,
    buildStructuredPrompt,
    buildStructureTacticalSummary,
    callGeminiDirect,
    initUI,
    init: initUI,
    openSettingsPanel,
    closeSettingsPanel,
    toggleSettingsPanel,
    updateKeyStatusBadge,
    generateTacticalBriefing,
    generateBriefing: generateTacticalBriefing
  };
})();
