# 전체 HWPX에서 '개발 경위 요약'만 뽑은 HWPX 만들기 (양식·서식 그대로)
import re,sys,shutil,os,zipfile
src,dst=sys.argv[1],sys.argv[2]
W=dst+'.d'; shutil.rmtree(W,ignore_errors=True); zipfile.ZipFile(src).extractall(W)
p=os.path.join(W,'Contents','section0.xml'); s=open(p,encoding='utf-8').read()
h=s.find('>',s.find('<hs:sec'))+1; e=s.rfind('</hs:sec>'); body=s[h:e]
d=0;starts=[]
for m in re.finditer(r'<hp:p |</hp:p>',body):
    if m.group(0)=='<hp:p ':
        if d==0: starts.append(m.start())
        d+=1
    else: d-=1
starts.append(len(body))
P=[body[starts[k]:starts[k+1]] for k in range(len(starts)-1)]
p0=P[0].replace('[양식 1] 참가신청서','[양식 2] 구동 안내서 — 개발 경위 요약',1)
p0=re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>','',p0,flags=re.S)
p3=P[3]; t0=p3.find('<hp:tbl ')
d=0;trs=[]
for m in re.compile(r'<hp:tbl |</hp:tbl>|<hp:tr>|</hp:tr>').finditer(p3,t0):
    g=m.group(0)
    if g=='<hp:tbl ': d+=1
    elif g=='</hp:tbl>':
        d-=1
        if d==0: tend=m.end(); break
    elif g=='<hp:tr>' and d==1: trs.append([m.start(),None])
    elif g=='</hp:tr>' and d==1: trs[-1][1]=m.end()
keep=[p3[a:b] for a,b in trs[7:9]]
assert '개발 경위 요약' in keep[0]
def fixrow(r,i):
    k=r.rfind('<hp:cellAddr ')
    return r[:k]+re.sub(r'rowAddr="\d+"','rowAddr="%d"'%i,r[k:],count=1)
keep=[fixrow(r,i) for i,r in enumerate(keep)]
hts=[int(re.findall(r'<hp:cellSz width="\d+" height="(\d+)"',r)[-1]) for r in keep]
head=p3[t0:trs[0][0]]
head=head.replace('rowCnt="9"','rowCnt="2"',1)
head=re.sub(r'(<hp:sz width="\d+" widthRelTo="\w+" height=")\d+','\\g<1>%d'%sum(hts),head,count=1)
p3n=p3[:t0]+head+''.join(keep)+'</hp:tbl>'+p3[tend:]
k=p3n.rfind('</hp:tbl>'); p3n=p3n[:k]+re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>','',p3n[k:],flags=re.S)
s=s[:h]+p0+p3n+s[e:]
open(p,'w',encoding='utf-8').write(s)
# 안 쓰는 그림 제거(1~6), 목록 정리
hpf=os.path.join(W,'Contents','content.hpf'); hh=open(hpf,encoding='utf-8').read()
for k in range(1,7):
    if 'binaryItemIDRef="image%d"'%k not in s:
        hh=re.sub(r'<opf:item id="image%d"[^>]*/>'%k,'',hh)
        for f in os.listdir(os.path.join(W,'BinData')):
            if f.startswith('image%d.'%k): os.remove(os.path.join(W,'BinData',f))
open(hpf,'w',encoding='utf-8').write(hh)
for f in ['Preview/PrvImage.png','Preview/PrvText.txt']:
    pass
if os.path.exists(dst): os.remove(dst)
z=zipfile.ZipFile(dst,'w'); z.write(os.path.join(W,'mimetype'),'mimetype',compress_type=zipfile.ZIP_STORED)
for r,_,fs in os.walk(W):
    for f in fs:
        full=os.path.join(r,f); arc=os.path.relpath(full,W)
        if arc!='mimetype': z.write(full,arc,compress_type=zipfile.ZIP_DEFLATED)
z.close(); shutil.rmtree(W); print('part ok', hts)
