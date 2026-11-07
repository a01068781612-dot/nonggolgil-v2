# 농골길 V2 · 농촌마을 소방차 진입로 판정

경상남도 의령군 239개 마을에서 신고 지점까지 **소방차가 어디까지 들어갈 수 있는지**, 그 뒤 **호스를 몇 본 연장해야 하는지**를 지도 위에 바로 보여 주는 웹 서비스입니다.

- 사이트: https://fireway119.pages.dev
- 소방서 → 마을 입구: T맵 경로
- 마을 안: 골목 폭·회전반경으로 차량별(구급 2.0m · 펌프 2.5m · 물탱크 2.8m 가정) 도착 지점 판정
- 건축물대장(주용도·구조·층수)으로 화재 유형 분류, 책자(2026 농촌마을 골든타임 길라잡이) 마을정보·불가 지점·소화전 표시
- AI 현장 전술 5줄 요약(위험·차량·호스·급수·주의)

## 실행

```bash
npx wrangler pages dev web      # 저장소 루트에서. functions/ 자동 인식
```

필요한 비밀값(Cloudflare Pages 환경 변수, 저장소에는 넣지 않음)

| 이름 | 용도 |
|---|---|
| `TMAP_APP_KEY` | T맵 경로 (없으면 공개 OSRM으로 대체) |
| `VWORLD_KEY`, `VWORLD_DOMAIN` | VWorld 지도·주소·건물 (브라우저용, `/api/config`가 내려줌) |
| `BLD_API_KEY` | 공공데이터포털 건축물대장 표제부 |
| `GEMINI_API_KEY` | AI 현장 전술 (화면에서 개인 키 입력도 가능) |

## 구조

| 경로 | 내용 |
|---|---|
| `web/` | 화면(index.html, assets/), 데이터(data/graphs 13개 읍면 도로망, hydrants.json, villages_book.json) |
| `functions/api/` | route(T맵) · brief(AI) · building · ledger(건축물대장) · config |
| `docs/` | 작업 기록(HISTORY.md, STATUS.md), 제출 문서(submit_v2/) |
