/**
 * Cloudflare Pages Function — /api/route
 *
 * GET  /api/route  → { tmap_ok, tmap_max, station }
 * POST /api/route  → { seq: [[lat,lng],...], router: 'tmap'|'osrm' }
 *                  → { line: [[lat,lng],...], dist, time, router, passCount }
 *
 * 자체 그래프 알고리즘이 산출한 안전 경유점(navVia)이 포함된 시퀀스(seq)를 받아
 * 1) TMAP_APP_KEY 설정 시: SK TMAP 자동차 경로안내 API (passList 경유지 최대 5개 반영) 호출
 * 2) 키 미설정 / 쿼터 초과 / 오류 시: OSRM 공개 라우팅 서버로 자동 폴백
 */
const TMAP_DAILY_MAX = 100;
const FIRE_STATION = { name: '의령소방서(의병로 108-17)', lat: 35.319599, lng: 128.248343 };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

function flattenLineCoords(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') {
    return geometry.coordinates.map(([x, y]) => [y, x]);
  }
  if (geometry.type === 'MultiLineString') {
    const out = [];
    for (const seg of geometry.coordinates) {
      for (const [x, y] of seg) out.push([y, x]);
    }
    return out;
  }
  return [];
}

async function callTmap(seq, appKey) {
  const s = seq[0];
  const e = seq[seq.length - 1];
  const vias = seq.slice(1, -1);
  const body = {
    startX: String(s[1]),
    startY: String(s[0]),
    endX: String(e[1]),
    endY: String(e[0]),
    reqCoordType: 'WGS84GEO',
    resCoordType: 'WGS84GEO',
    searchOption: '0'
  };
  if (vias.length) {
    body.passList = vias.map((p) => `${p[1]},${p[0]}`).join('_');
  }
  const r = await fetch('https://apis.openapi.sk.com/tmap/routes?version=1&format=json', {
    method: 'POST',
    headers: { appKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 429 || r.status === 403) {
    const err = new Error(`TMAP quota/auth (${r.status})`);
    err.quota = true;
    throw err;
  }
  if (!r.ok) throw new Error(`TMAP HTTP ${r.status}`);
  const data = await r.json();
  const feats = data.features || [];
  let dist = 0;
  let time = 0;
  const line = [];
  for (const f of feats) {
    const p = f.properties || {};
    if (p.totalDistance != null) dist = Number(p.totalDistance);
    if (p.totalTime != null) time = Number(p.totalTime);
    for (const pt of flattenLineCoords(f.geometry)) {
      if (!line.length || line[line.length - 1][0] !== pt[0] || line[line.length - 1][1] !== pt[1]) {
        line.push([Math.round(pt[0] * 1e6) / 1e6, Math.round(pt[1] * 1e6) / 1e6]);
      }
    }
  }
  if (line.length < 2) throw new Error('TMAP empty geometry');
  return { line, dist, time, router: 'tmap', passCount: vias.length };
}

async function callOsrm(seq) {
  const coords = seq.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const r = await fetch(url, { headers: { 'User-Agent': 'fireway119-router/1.0' } });
  if (!r.ok) throw new Error(`OSRM HTTP ${r.status}`);
  const data = await r.json();
  const rt = (data.routes || [])[0];
  if (!rt) throw new Error('OSRM no route');
  const line = rt.geometry.coordinates.map(([x, y]) => [
    Math.round(y * 1e6) / 1e6,
    Math.round(x * 1e6) / 1e6
  ]);
  return {
    line,
    dist: Math.round(rt.distance),
    time: Math.round(rt.duration),
    router: 'osrm',
    passCount: Math.max(0, seq.length - 2)
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ env }) {
  return json({
    tmap_ok: Boolean(env && env.TMAP_APP_KEY),
    tmap_max: TMAP_DAILY_MAX,
    station: FIRE_STATION
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const seq = body.seq || [];
  const prefer = body.router || 'tmap';
  if (!Array.isArray(seq) || seq.length < 2 || seq.length > 7) {
    return json({ error: 'seq must have 2..7 [lat,lng] points' }, 400);
  }
  const norm = seq.map((p) => [Number(p[0]), Number(p[1])]);
  const keyStr = `${prefer}|` + norm.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';');
  const cacheReq = new Request(
    `https://fireway119.local/route-cache/${encodeURIComponent(keyStr)}`,
    { method: 'GET' }
  );
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;

  if (cache) {
    const hit = await cache.match(cacheReq);
    if (hit) return hit;
  }

  const appKey = env && env.TMAP_APP_KEY;
  let result;
  let fallbackReason = null;
  if (prefer === 'tmap' && appKey) {
    try {
      result = await callTmap(norm, appKey);
    } catch (e) {
      fallbackReason = String(e.message || e);
    }
  }
  if (!result) {
    try {
      result = await callOsrm(norm);
      if (fallbackReason) result.fallback = fallbackReason;
    } catch (e) {
      return json({ error: String(e.message || e), fallback: fallbackReason }, 502);
    }
  }

  const resp = json(result, 200);
  if (cache) {
    const toCache = new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=604800',
        ...CORS
      }
    });
    await cache.put(cacheReq, toCache);
  }
  return resp;
}
