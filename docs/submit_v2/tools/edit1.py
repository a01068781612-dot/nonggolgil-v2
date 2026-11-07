import re,sys
p=sys.argv[1]
s=open(p,encoding='utf-8').read()
def para(pid):
    m=re.search(r'<hp:p id="%s".*?</hp:p>'%pid,s,re.S); assert m,pid; return m
def newp(tmpl,text,nid=None):
    q=re.sub(r'<hp:t>[^<]*</hp:t>','<hp:t>%s</hp:t>'%text.replace('&','&amp;').replace('<','&lt;'),tmpl,count=1)
    q=re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>','',q,flags=re.S)
    if nid: q=re.sub(r'id="\d+"','id="%s"'%nid,q,count=1)
    return q
def setp(pid,text):
    global s
    m=para(pid); s=s[:m.start()]+newp(m.group(0),text)+s[m.end():]
def setmany(pid,texts,base):
    """replace paragraph pid with len(texts) paragraphs cloned from it"""
    global s
    m=para(pid); t=m.group(0)
    out=newp(t,texts[0])+''.join(newp(t,x,base+i) for i,x in enumerate(texts[1:]))
    s=s[:m.start()]+out+s[m.end():]
setp('900020','농골길 V2 – 농촌마을 소방차 진입로 자동 판정')
setp('900022','Gemini Flash-Lite · Gemini Flash · Gemma 4(행안부 AI 공통기반 지원 계열)')
setp('900023','- 교체 가능: 장애·한도 시 3종 자동 전환, 화면에서 모델 선택')
setp('900024','https://gitlab.aigov.go.kr/ssca1612/nonggolgil-v2')
setp('900025','○ 개요 - 신고 주소 하나로 골목 폭·꺾임까지 계산한 차량별 도착 지점')
setp('900026','- 국가 도로망(VWorld) 자료로 골목 폭·꺾임각 계산 → 차량별 진입 가능 구간·도착 지점·경로·호스 매수를 지도에 표시')
setp('900027','- 대상: 의령군 13개 읍면 239개 행정마을 전체(책자 미수록 마을 포함)')
setp('900029','- (진입 판정) 도로 폭·회전반경 기준 진입 가능·불가·확인 필요 색 표시')
setp('900030','- (도착·경로) 소방서→마을 입구 T맵, 마을 안 골목 경로, 차량별 도착 지점·호스 매수 산출')
setp('900031','- (화재 유형) 건축물대장 주용도로 주택·공장·축사·창고 등 자동 분류')
setmany('900032',['- (AI 요약) 위험·차량·호스·급수·주의 5줄 현장 전술 요약',
 '- (마을정보) 『2026 길라잡이』 222개 마을 진입곤란 표·소화전 171개'],990001)
setp('900033','○ 차별점(AI 신뢰성)')
setp('900034','- 판정·거리·호스는 계산값 그대로, AI는 요약 문장만 작성 → AI 오정보 차단')
setmany('900035',['- 책자(현장 조사) 대비 검증: 마을별 진입곤란 여부 일치 80.6%(191/237개 마을)',
 '- AI 장애 시에도 판정·경로·호스 정상 동작'],990011)
open(p,'w',encoding='utf-8').write(s)
print('ok')
