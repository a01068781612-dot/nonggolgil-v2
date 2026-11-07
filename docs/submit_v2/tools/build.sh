S=/tmp/claude-0/-home-user-nonggolgil-ai-challenge/7d1f4e9d-a8f3-586a-ae5b-1c27005e04cb/scratchpad
F="/home/user/nonggolgil-ai-challenge/docs/submit_v2/out/2026년 공공 AI 대전환 챌린지_경남소방본부 119종합상황실_김경훈_v.2.0_26.11.07.hwpx"
rm -rf $S/work && cp -r $S/hx $S/work
for e in edit1 edit2 edit3 edit4 edit5 edit7; do python3 -I $S/tools/$e.py $S/work/Contents/section0.xml || exit 1; done
cp $S/fig/fig2B.png $S/work/BinData/image2.png
cp $S/fig/fig3B.png $S/work/BinData/image3.png
for k in 4 5 6; do cp $S/fig/blank$k.png $S/work/BinData/image$k.png; done
python3 -I $S/tools/edit6.py $S/work/Contents/section0.xml "$S/fig/fig7_user.png" || exit 1
rm -f "$F"; (cd $S/work && zip -q -X -0 "$F" mimetype && zip -q -X -r "$F" . -x mimetype)
cd $S && npx -y kordoc validate "$F" 2>&1 | tail -1 && rm -rf rn && npx -y kordoc render "$F" --format png -d $S/rn --silent && ls rn | wc -l
