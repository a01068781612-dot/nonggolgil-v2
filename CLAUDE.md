# 농골길 V2 작업 규칙 (26.11.07. 사용자 지시)

## 브랜치·배포 (가장 중요)
- 저장소: `a01068781612-dot/nonggolgil-v2` (GitHub) → GitLab `nonggolgil-v2`로 가져감. 작업 브랜치 main
- 배포: Cloudflare Pages **`fireway119`** 프로젝트만 → https://fireway119.pages.dev
  - 저장소 루트에서 `npx wrangler pages deploy web --project-name fireway119 --branch v2` (v2 = Cloudflare 운영 브랜치 이름)
  - `nonggolgil` 프로젝트 이름으로 배포 금지 (제출 사이트 덮어씀)
- 로컬 실행: 저장소 루트에서 `npx wrangler pages dev web` (functions/ 자동 인식)

## 답변
- **짧게, 개조식·표로.** 되면 "된다", 안 되면 "이렇게 해라"
- 순서: **결론 → 사용자 결정 사항 → 비교 근거(표)**. 개략적으로, 군더더기 없이 (사용자 수학 전공: 간단·명료·논리)
- 사용자가 할 일은 바로 들어갈 수 있는 링크 붙이기
- 큰 작업은 구조를 텍스트로 먼저 보여 주고 승인 → 실행, 수정은 **하나씩**
- 채팅방 번호는 v2 기준 1번부터 (예: `1 (26.11.06) 농골길 v2 — …`)

## 새 채팅 시작할 때
- 이 파일 + `docs/STATUS.md`만 읽고 이어서 작업. 더 필요할 때만 `docs/HISTORY.md`

@docs/STATUS.md

## 기록 (매 작업마다)
- 변경마다 `docs/HISTORY.md`에 한 줄 + 작업 끝에 `docs/STATUS.md` 덮어쓰기(15줄 이내)
- 화면 수정은 PC 1440px·모바일 390px 스크린샷으로 확인
- 끝나면 커밋 + main 푸시 + fireway119 재배포 (GitLab 제출 마감 11.11 이후에는 GitLab 변경 금지)

## 키 (Cloudflare fireway119 비밀값 — 코드·저장소에 값 쓰지 않음)
- TMAP_APP_KEY · BLD_API_KEY · GEMINI_API_KEY · VWORLD_KEY(=VWORLD_API_KEY) · VWORLD_DOMAIN(nonggolgil.pages.dev)
- 브라우저용 VWorld 키는 `/api/config`가 내려줌. AI는 `/api/brief`가 서버 키로 생성(gemini-flash-lite-latest → flash → gemma-4 자동 전환, 5줄 요약)
- VWorld는 해외 서버(클라우드·Cloudflare) 접속 차단 → 지도·주소·건물 조회는 브라우저에서

## 구조
- `web/` 화면(index.html, assets/app.js·graph_engine.js·gemini_tactical_ai.js·style.css, data/graphs 13개 읍면 239개 마을)
- `functions/api/` route(T맵, 없으면 OSRM) · brief(AI) · building(건축물대장) · config
- `docs/submit_v2/` 제출 HWPX(원본·결과·편집 스크립트)
