# 구동안내서 3~4쪽: 모순 부분만 문단 단위 찾아 바꾸기 (원본 문단·서식 유지)
import re,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
esc=lambda x:x.replace('&','&amp;').replace('<','&lt;')
A=s.find('[양식 2]'); B=s.find('개발 경위 요약')
PAT=re.compile(r'<hp:p id="\d+"[^>]*>((?:(?!<hp:p ).)*?)</hp:p>',re.S)
def ptext(body): return ''.join(re.findall(r'<hp:t>([^<]*)</hp:t>',body))
def rep(old,new,whole=False):
    """old: 문단 안 부분 문자열(whole=True면 문단 전체), new=None이면 문단 삭제"""
    global s,B
    for m in PAT.finditer(s,A,B):
        t=ptext(m.group(1))
        if (t.strip()==old.strip()) if whole else (old in t):
            if new is None:
                s=s[:m.start()]+s[m.end():]
            else:
                nt=t.replace(old,new) if not whole else new
                q=m.group(0); first=[True]
                def f(mm):
                    if first[0]: first[0]=False; return '<hp:t>%s</hp:t>'%esc(nt)
                    return '<hp:t></hp:t>'
                q=re.sub(r'<hp:t>[^<]*</hp:t>',f,q)
                q=re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>','',q,flags=re.S)
                s=s[:m.start()]+q+s[m.end():]
            B=s.find('개발 경위 요약'); return
    raise SystemExit('NOT FOUND: '+old)
R=[
('https://nonggolgil.pages.dev - 설치 없음, 비밀번호 잠금','https://fireway119.pages.dev - 설치 없음, 바로 접속'),
('크롬 · 엣지 최신판(음성 입력은 크롬)','크롬 · 엣지 최신판'),
('Python 3.11 이상 + networkx(로컬 서버)','Node.js 18 이상 + Wrangler(로컬 서버)'),
('주소 접속 → 비밀번호 입력(심사용 별도 안내) → 검색창에 마을 이름 또는 주소 입력','주소 접속 → 검색창에 마을 이름 또는 주소 입력'),
('접속 화면과 첫 화면 — 비밀번호 입력 후 바로 검색','첫 화면 — 접속 후 바로 검색'),
('pip install networkx','Node.js 설치'),
('보행 경로 계산 패키지','로컬 서버 실행 도구(npx)'),
('.env.example → .env 복사','.dev.vars 파일 만들기'),
('python data/build_data.py --mock','(생략) 마을 자료 저장소에 포함'),
('모의데이터 적용','web/data 239개 마을'),
('python server.py 8770','npx wrangler pages dev web'),
('로컬 서버 실행(윈도우: 실행.bat)','로컬 서버 실행'),
('http://localhost:8770','http://localhost:8788'),
('Gemma 4(gemma-4-26b-a4b-it)','Gemini Flash(gemini-flash-latest)'),
('OpenAI 호환 모델','Gemma 4(gemma-4-26b-a4b-it)'),
('LLM_BASE_URL·LLM_MODEL·LLM_API_KEY','같은 키'),
('functions/_lib.js·server.py 의 MODELS 모델명만 변경','functions/api/brief.js 의 모델 목록에서 모델명만 변경'),
('화면 [AI 모델]에서 선택','화면 [설정]에서 선택'),
('규칙 브리핑·낭독은 AI 없이 동작','규칙 브리핑은 AI 없이 동작'),
('파일(mock/)','파일(web/data/)'),
('villages_mock.json','graphs/eup_*.json'),
('실제 마을 3개(대천·백곡·심지)','13개 읍면 239개 마을 도로망(폭·꺾임각)'),
('조회·판단·브리핑','진입 판정·경로·호스'),
('geo/pNNN.json','villages_book.json'),
('진입곤란·대체구간 선, 불가 지점, 보행망','책자 222개 마을 진입곤란 표·불가 지점'),
('정차 위치·경로·호스','마을정보 탭·불가 지점 표시'),
('dispatch_mock.json','hydrants.json'),
('건물 유형별 출동 편성(임의 설정)','소화전 171개 위치'),
('출동 차량 구성','소화전 표시·급수'),
('화재피해약자는 인원수만, 책자 지도 그림 제외,','화재피해약자·연락처 미포함, 책자 지도 그림 제외'),
('python data/build_data.py —mock','저장소에 포함, 별도 투입 없음'),
('처리 흐름 — 사실은 책자 데이터, 문장만 AI','처리 흐름 — 판정은 도로망 계산, 문장만 AI'),
('[출동] 탭에 차량별 판정·정차 위치·이동 거리·호스 매수','[길찾기] 탭에 화재 유형·차량별 도착 지점·이동 거리·호스 매수'),
('호스 전개선(노란 점선)','호스 전개선(빨간 점선)'),
('출동 화면 — 펌프 7매·물탱크 11매·구급 4매, 차량마다 정차 위치 다름','길찾기 화면 — 차량마다 도착 지점·호스 매수 다름'),
('[경로 보기]로 한 차량 경로만 표시, [T맵 길안내]로 정차 위치까지 내비 연결','차량 버튼(경형·중형·대형)으로 차량별 경로 표시, [T맵 길안내]로 도착 지점까지 내비 연결'),
('펌프 경로만 보기와 스마트폰 화면','차량별 경로와 스마트폰 화면'),
('흐름 ③ 무전 브리핑·전술','흐름 ③ AI 전술 요약·마을정보'),
('[AI 브리핑] → 무전용 문장 생성(사실은 계산 결과 그대로) → [낭독]으로 음성 전파','[건물·AI] 탭 [AI 전술 생성] → 5줄 요약(사실은 계산 결과 그대로)'),
('[전술] 탭: 책자 근거 차량별 전술(쪽 번호 표기)','[건물·AI] 탭: 건축물대장 용도·구조·층수'),
('무전 브리핑과 차량별 전술 — 근거 쪽수 자동 표기','AI 전술 요약과 마을정보 — 책자 쪽수 표기'),
]
def setruns(old,texts):
    """여러 run 문단: run별 글자 모양 유지하고 run마다 글만 교체"""
    global s,B
    for m in PAT.finditer(s,A,B):
        if ptext(m.group(1))==old:
            it=iter(texts)
            q=re.sub(r'<hp:t>[^<]*</hp:t>',lambda mm:'<hp:t>%s</hp:t>'%esc(next(it)),m.group(0))
            q=re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>','',q,flags=re.S)
            s=s[:m.start()]+q+s[m.end():]; B=s.find('개발 경위 요약'); return
    raise SystemExit('NOT FOUND: '+old)
# 기본 모델 칸: 'Gemini Flash' + '(gemini-flash-latest)' 두 run 구조 유지
setruns('Gemini Flash(gemini-flash-latest)',['Gemini Flash-Lite','(gemini-flash-lite-latest)'])
# 모의데이터 1행 둘째 줄 삭제
rep('진입 판정표·소화전·진압작전',None,whole=True)
# 대체 행 2번째 줄(행안부…) 삭제 → 추가 행 '(AI 공통기반 등)'을 그 문구로
rep('행안부 AI 공통기반 지원 계열',None,whole=True)
rep('(AI 공통기반 등)','행안부 AI 공통기반 지원 계열')
for o,n in R: rep(o,n)
rep('생성 시 전화번호 등 자동 검사',None,whole=True)
open(p,'w',encoding='utf-8').write(s); print('edit4 ok',len(R)+3)
