const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:400},deviceScaleFactor:2});
await p.goto('file://'+process.argv[2]+'/diag2b.html');await p.waitForTimeout(1500);
const ov=await p.evaluate(()=>[...document.querySelectorAll('.c')].map(e=>[e.scrollHeight-e.clientHeight,e.scrollWidth-e.clientWidth]));console.log('overflow',JSON.stringify(ov));
await p.locator('#b').screenshot({path:process.argv[2]+'/fig2B.png'});await b.close();})();
