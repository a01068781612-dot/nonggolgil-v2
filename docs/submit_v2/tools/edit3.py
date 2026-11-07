import re,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
esc=lambda x:x.replace('&','&amp;').replace('<','&lt;')
def setp(pid,text):
    global s
    m=re.search(r'<hp:p id="%s".*?</hp:p>'%pid,s,re.S); assert m,pid
    q=re.sub(r'<hp:t>[^<]*</hp:t>','<hp:t>%s</hp:t>'%esc(text),m.group(0),count=1)
    s=s[:m.start()]+q+s[m.end():]   # 한 줄 문단: 조판 캐시 유지
def delp(pid):
    global s
    m=re.search(r'<hp:p id="%s".*?</hp:p>'%pid,s,re.S); s=s[:m.start()]+s[m.end():]
# 3단계 블록 5줄 → 2줄, 확산 2줄 → 1줄 = 4줄 절약 ≥ 비교표 3행 추가 (그림 7 원래 크기)
setp('2148383823','○ 3·4단계 - AI 농골길 코치(책자 웹앱) → 농골길 V2(2026, 본 출품작, 도로망 자동 판정)')
setp('2148383824','- (보완) 책자 없이 239개 마을 판정(책자 대비 일치 80.6%), 화재 유형·AI 5줄 요약 추가')
for pid in ('2148383825','2148383826','2148383827'): delp(pid)
setp('2148383854','○ 확산 - 공공 지도만으로 생성 → 도내 확대 시 연 119억 원 절감(18개 서 환산, 추정)')
m=re.search(r'(<hp:p id="2148383854".*?)<hp:linesegarray>.*?</hp:linesegarray>(</hp:p>)',s,re.S)
seg='<hp:linesegarray><hp:lineseg textpos="0" vertpos="65153" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="46916" flags="393216"/></hp:linesegarray>'
s=s[:m.start()]+m.group(1)+seg+m.group(2)+s[m.end():]
open(p,'w',encoding='utf-8').write(s); print('ok')
