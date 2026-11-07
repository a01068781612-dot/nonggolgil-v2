// GET /api/config → window.FW_CONFIG (브라우저용 VWorld 키·도메인). VWorld 키는 도메인 등록제라 브라우저 공개용.
export async function onRequestGet({ env }) {
  const cfg = { vworldKey: env.VWORLD_API_KEY || env.VWORLD_KEY || '', vworldDomain: env.VWORLD_DOMAIN || '', aiServer: Boolean(env.GEMINI_API_KEY) };
  return new Response('window.FW_CONFIG = ' + JSON.stringify(cfg) + ';', {
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
}
