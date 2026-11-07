// GET /api/ledger?sn=건물관리번호(앞 19자리=PNU) → 건축물대장 표제부(공공데이터포털). VWorld 건물 찾기는 브라우저가 함
export async function onRequestGet({ request, env }) {
  const sn = String(new URL(request.url).searchParams.get('sn') || '');
  const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  if (!/^\d{19}/.test(sn)) return out({ error: 'sn 19자리 필요' }, 400);
  if (!env.BLD_API_KEY) return out({ error: 'BLD_API_KEY 없음' }, 500);
  const pnu = sn.slice(0, 19);
  const q = new URLSearchParams({ serviceKey: env.BLD_API_KEY, sigunguCd: pnu.slice(0, 5), bjdongCd: pnu.slice(5, 10),
    platGbCd: pnu[10] === '2' ? '1' : '0', bun: pnu.slice(11, 15), ji: pnu.slice(15, 19), numOfRows: '10', pageNo: '1', _type: 'json' });
  try {
    const r = await fetch('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?' + q);
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { return out({ error: '건축물대장 응답 오류 ' + r.status, detail: txt.slice(0, 200) }, 502); }
    const items = j.response?.body?.items;
    let it = items && typeof items === 'object' ? items.item : [];
    it = Array.isArray(it) ? it : it ? [it] : [];
    return out({ resultCode: j.response?.header?.resultCode, records: it.map((x) => ({
      mainUse: x.mainPurpsCdNm || '', etcUse: x.etcPurps || '', structure: x.strctCdNm || '', roof: x.roofCdNm || x.etcRoof || '',
      groundFloors: x.grndFlrCnt, undergroundFloors: x.ugrndFlrCnt, totalAreaM2: x.totArea, archAreaM2: x.archArea,
      useAprDay: x.useAprDay || '', buildingName: x.bldNm || '', dongName: x.dongNm || '' })) });
  } catch (e) { return out({ error: String(e.message || e) }, 502); }
}
