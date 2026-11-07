const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1300,height:700},deviceScaleFactor:2});
await p.goto('file://'+process.argv[2]+'/f7c.html');await p.waitForTimeout(1500);
await p.locator('#f').screenshot({path:process.argv[2]+'/fig7_3칸.png'});await b.close();})();
