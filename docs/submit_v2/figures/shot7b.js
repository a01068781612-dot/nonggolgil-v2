const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1300,height:1800},deviceScaleFactor:2});
await p.goto('file://'+process.argv[2]+'/f7b.html');await p.waitForTimeout(1500);
for (const k of ['a','b','c']) await p.locator('#'+k).screenshot({path:process.argv[2]+'/fig7n'+k.toUpperCase()+'.png'});await b.close();})();
