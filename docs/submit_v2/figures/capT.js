const { chromium } = require('playwright');
const D=process.argv[2];
(async()=>{const b=await chromium.launch();
 for (const [w,h,n] of [[1280,800,'tL'],[800,1280,'tP'],[1024,768,'tS']]) {
  const m=await b.newPage({viewport:{width:w,height:h},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  await m.goto('https://fireway119.pages.dev/',{waitUntil:'networkidle'}).catch(()=>{});
  await m.fill('input[placeholder^="예: 의령군"]','가미마을'); await m.keyboard.press('Enter');
  await m.waitForTimeout(12000); await m.screenshot({path:`${D}/${n}_1.png`});
  await m.evaluate(()=>{const e=document.getElementById('link-nav-tmap'); if(e) e.scrollIntoView({block:'center'});});
  await m.waitForTimeout(1200); await m.screenshot({path:`${D}/${n}_2.png`});
  await m.close(); }
 await b.close();})();
