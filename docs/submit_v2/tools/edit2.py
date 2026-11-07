import re,sys
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
i=s.rfind('<hp:tbl '); j=s.find('</hp:tbl>',i)+len('</hp:tbl>'); T=s[i:j]
assert 'rowCnt="6"' in T[:400]
esc=lambda x:x.replace('&','&amp;').replace('<','&lt;')
def settext(cell,text):
    cell=re.sub(r'<hp:t>[^<]*</hp:t>','<hp:t>%s</hp:t>'%esc(text),cell,count=1)
    return re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>','',cell,flags=re.S)
rows=re.findall(r'<hp:tr>.*?</hp:tr>',T,re.S); assert len(rows)==6
data=[
 ['구분','책자(1단계)','GPTs(2단계)','농골길 V2(본 출품작)'],
 ['마을 찾기','목차 검색','마을명 입력','주소·지도 클릭 자동 특정'],
 ['판정 근거','책자 원문','AI 답변(오류 가능)','도로망 계산(일치 80.6%)'],
 ['도착 지점','그림 판독','글 설명','지도에 차량별 도착 지점·경로'],
 ['호스 매수','책자 값','책자 값','신고 지점 기준 자동 산출'],
 ['AI 장애 시','-','사용 불가','판정·경로·호스 계속 동작'],
 ['단축 효과','현장 3분 단축','판단 65초 단축','목표 판단 10초 이내'],
 ['자료 구축','140명·1년','책자 재사용','5주(239개 마을 자동 생성)'],
 ['연간 비용(추정)','6억 6,515만 원','-','366만 원(약 6.6억 절감)'],
]
nid=[995000]
def mkrow(tmpl,r,vals):
    cells=re.findall(r'<hp:tc .*?</hp:tc>',tmpl,re.S); out=tmpl
    for c,v in zip(cells,vals):
        c2=settext(c,v)
        c2=re.sub(r'rowAddr="\d+"','rowAddr="%d"'%r,c2)
        if r>=6:
            def ren(m):
                nid[0]+=1; return 'id="%d"'%nid[0]
            c2=re.sub(r'(?<=<hp:p )id="\d+"',ren,c2)
        out=out.replace(c,c2,1)
    return out
new=[mkrow(rows[k] if k<6 else rows[5],k,data[k]) for k in range(9)]
T2=T
for k in range(6): T2=T2.replace(rows[k],new[k],1)
T2=T2.replace(new[5],new[5]+''.join(new[6:]),1)
T2=T2.replace('rowCnt="6"','rowCnt="9"',1)
m=re.search(r'<hp:sz width="(\d+)" widthRelTo="(\w+)" height="(\d+)"',T2)
T2=T2.replace(m.group(0),m.group(0).replace('height="%s"'%m.group(3),'height="%d"'%(int(m.group(3))+3*1800)),1)
s=s[:i]+T2+s[j:]
open(p,'w',encoding='utf-8').write(s); print('ok',m.group(0))
# 비교표 문단(2148383828) 조판 캐시: 위 3줄 줄어듦(-4800), 표 3행 늘어남(+5400)
s=open(p,encoding='utf-8').read()
old='<hp:lineseg textpos="0" vertpos="52545" vertsize="10800" textheight="10800" baseline="9180" spacing="508"'
new='<hp:lineseg textpos="0" vertpos="47745" vertsize="16200" textheight="16200" baseline="14580" spacing="508"'
assert old in s; s=s.replace(old,new,1); open(p,'w',encoding='utf-8').write(s); print('anchor ok')
