# 기능 사용 순서: 태블릿 기준, 핵심 흐름 3개 = 탭 3개(길찾기·건물·AI·마을정보)
import re,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
esc=lambda x:x.replace('&','&amp;').replace('<','&lt;')
def para(pid):
    m=re.search(r'<hp:p id="%s"[^>]*>.*?</hp:p>'%pid,s,re.S); assert m,pid; return m
def mk(tmpl,text,nid=None):
    q=re.sub(r'<hp:t>[^<]*</hp:t>','<hp:t>%s</hp:t>'%esc(text),tmpl,count=1)
    q=re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>','',q,flags=re.S)
    if nid: q=re.sub(r'id="\d+"','id="%d"'%nid,q,count=1)
    return q
def setp(pid,text,after=None,nid=None):
    global s
    m=para(pid); new=mk(m.group(0),text)
    if after: new+=mk(m.group(0),after,nid)
    s=s[:m.start()]+new+s[m.end():]
setp('900127','○ 흐름 ① [길찾기] 탭 — 차량별 진입 판정·호스')
setp('900128','- “가미마을” 입력 → 요약 4칸(화재 유형·출동·호스·소화전)')
setp('900129','- 차량 버튼(경형·중형·대형)별 도착 지점·호스, [T맵 길안내]')
setp('900133','[그림 4] 길찾기 화면 — 중형 진입 불가 지점에서 호스 연장(가미마을)')
setp('900134','○ 흐름 ② [건물·AI] 탭 — 건물 정보·AI 전술')
setp('900135','- 건축물대장 용도·구조·층수·사용승인, 건물 특성 주의',
     after='- [AI 전술 생성] → 위험·차량·호스·급수·주의 5줄',nid=996001)
setp('900139','[그림 5] 건물·AI 화면 — 건축물대장과 AI 전술 5줄')
setp('900140','○ 흐름 ③ [마을정보] 탭 — 책자 현장 정보')
setp('900141','- 진입곤란 표(펌프·물탱크·구급·굴절)·소화전·진압작전')
setp('900142','- 책자 쪽수 표기, 지도에 ‘불가’ 지점 표시')
# 900142 다음 줄(id=0, '[마을정보] 탭: …') 삭제
i=para('900142').end(); m=re.compile(r'<hp:p id="0"[^>]*>.*?</hp:p>',re.S).match(s,i)
assert m and '[마을정보] 탭' in m.group(0); s=s[:m.start()]+s[m.end():]
setp('900146','[그림 6] 마을정보 화면 — 진입곤란 표·소화전, 책자 쪽수 표기')
open(p,'w',encoding='utf-8').write(s); print('edit5 ok')
