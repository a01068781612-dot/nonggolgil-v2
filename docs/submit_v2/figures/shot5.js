const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2});
await p.goto('file://'+process.argv[2]+'/f5.html');await p.waitForTimeout(1500);
await p.locator('#f').screenshot({path:process.argv[2]+'/fig5_mobile.png'});await b.close();})();
