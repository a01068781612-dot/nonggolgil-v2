/**
 * Cloudflare Pages Functions: POST /api/brief
 * 출동 차량 제원·회전반경·호스 연장 본수·소화전 거리 기반 AI 현장 지휘 브리핑 생성
 */
export async function onRequestPost(context) {
  let body = {};
  try {
    body = await context.request.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  // Gemini: 화면 입력 키 → 없으면 서버 키(GEMINI_API_KEY)
  // 화면에 넣은 개인 키를 먼저, 안 되면 서버 키로
  const keys = [String(body.apiKey || '').trim(), String((context.env && context.env.GEMINI_API_KEY) || '').trim()]
    .filter((k, i, a) => k && a.indexOf(k) === i);
  if (keys.length && body.prompt) {
    const models = [body.model, 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemma-4-26b-a4b-it'].filter((m, i, a) => m && a.indexOf(m) === i);
    let lastErr = '';
    for (const gKey of keys) for (const m of models) {
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), m.startsWith('gemma') ? 40000 : 30000);
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
          signal: ctl.signal,
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gKey },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: String(body.prompt).slice(0, 20000) }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: m.startsWith('gemma') ? 4000 : 2000,
            } }) });
        const j = await r.json();
        clearTimeout(tm);
        const text = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
        if (r.ok && text) {
          return new Response(JSON.stringify({ aiGenerated: true, briefing: text, model: m, skipped: lastErr || null }), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        }
        lastErr += m + ': ' + (j.error?.message || ('HTTP ' + r.status)) + ' | ';
      } catch (e) { lastErr += m + ': ' + String(e.message || e) + ' | '; }
    }
    body.aiError = lastErr;
  }

  const mission = body.mission || {};
  const building = body.building || {};
  const regionName = body.regionName || '경상남도 의령군';
  const spec = mission.vehicleSpec || { name: '소형펌프차', threshold: 2.2, minTurnRadiusM: 6.8 };
  const addr = building.roadAddress || building.parcelAddress || regionName;
  const hyd = mission.nearestHydrant
    ? `${mission.nearestHydrant.label} (이격 ${mission.nearestHydrant.distanceM}m)`
    : '인근 소화전 미확보 (물탱크차 중계 급수 필요)';

  const briefing = mission.directVehicleAccess
    ? `[현장위치] ${addr}\n` +
      `[출동제원] ${spec.name} (요구폭 ${spec.threshold}m · 최소회전반경 ${spec.minTurnRadiusM}m)\n` +
      `[진입판정] 외곽 진입로에서 화점 인접 정점(${mission.stagingNodeId})까지 ${mission.vehicleDistanceM}m 구간 폭원 및 회전반경 확보 — 차량 직접 진입 가능\n` +
      `[전술지시] 화점 전면 안전 부서 후 ${mission.hoseDistanceM}m(15m 소방호스 ${mission.requiredHose15mCount}본) 직접 전개 방수\n` +
      `[수원확보] ${hyd}`
    : `[현장위치] ${addr}\n` +
      `[출동제원] ${spec.name} (요구폭 ${spec.threshold}m · 최소회전반경 ${spec.minTurnRadiusM}m)\n` +
      `[진입제한] ${mission.bottleneck ? mission.bottleneck.message : '골목 폭원/회전반경 미달'}\n` +
      `[1차 차량부서] 마을 진입로에서 하차·전개 거점(${mission.stagingNodeId})까지 ${mission.vehicleDistanceM}m 진입 후 차량 부서\n` +
      `[2차 호스전개] 거점(${mission.stagingNodeId})에서 화점까지 ${mission.hoseDistanceM}m 구간 15m 소방호스 최소 ${mission.requiredHose15mCount}본 도보 연장 및 동력펌프/중계방수 실시\n` +
      `[수원확보] ${hyd}`;

  return new Response(JSON.stringify({ briefing: briefing, source: 'Nonggolgil V2 Tactical Engine', aiError: body.aiError || null }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
