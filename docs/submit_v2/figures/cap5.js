const { chromium } = require('playwright');
const D=process.argv[2];
(async()=>{const b=await chromium.launch();
 const m=await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
 await m.goto('https://fireway119.pages.dev/',{waitUntil:'networkidle'}).catch(()=>{});
 await m.fill('input[placeholder^="예: 의령군"]','가미마을'); await m.keyboard.press('Enter');
 await m.waitForTimeout(12000);
 await m.screenshot({path:D+'/g_m1.png'});
 // 시트 안 T맵 버튼까지 스크롤
 await m.evaluate(()=>{const e=document.getElementById('link-nav-tmap'); if(e) e.scrollIntoView({block:'center'});});
 await m.waitForTimeout(1500); await m.screenshot({path:D+'/g_m2.png'});
 // 지도 크게
 await m.getByText('지도 크게').first().click().catch(e=>console.log('big',e.message)); await m.waitForTimeout(2500);
 await m.screenshot({path:D+'/g_m3.png'});
 const html=await m.evaluate(()=>{const e=document.getElementById('link-nav-tmap');return e?e.getAttribute('href'):null}); console.log('tmap',html&&html.slice(0,120));
 await b.close();})();
