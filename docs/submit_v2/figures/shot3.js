const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:700},deviceScaleFactor:2});
await p.goto('file://'+process.argv[2]+'/diag3.html');await p.waitForTimeout(1500);
console.log(JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('.s,.bar')].filter(e=>e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1).map(e=>e.innerText.slice(0,10)))));
for (const k of ['a','b','c']) await p.locator('#'+k).screenshot({path:process.argv[2]+'/fig3'+k.toUpperCase()+'.png'});await b.close();})();
