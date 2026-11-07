# 그림 7 캡션 + 그림 7 파일(bmp→png) 교체
import sys,os,shutil
p=sys.argv[1]; s=open(p,encoding='utf-8').read()
old='[그림 7] 농골길 단계별 발전 (책자 → AI 훈련 → 웹앱)'
new='[그림 7] 농골길 단계별 발전 (책자 → AI 훈련 → 농골길 V2)'
assert old in s; s=s.replace(old,new); open(p,'w',encoding='utf-8').write(s)
W=os.path.dirname(os.path.dirname(p))
hpf=os.path.join(W,'Contents','content.hpf'); h=open(hpf,encoding='utf-8').read()
h=h.replace('href="BinData/image7.bmp" media-type="image/bmp"','href="BinData/image7.png" media-type="image/png"')
assert 'BinData/image7.png' in h; open(hpf,'w',encoding='utf-8').write(h)
os.remove(os.path.join(W,'BinData','image7.bmp'))
shutil.copy(sys.argv[2], os.path.join(W,'BinData','image7.png'))
print('edit6 ok')
