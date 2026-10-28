/** Real extension and trusted keyboard events; controlled start rejection must stay failed after key release.
 * npx tsx scripts/acceptance/real-path/ptt-start-rejection.mts --headless
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {launchRealPath,until,requireHeadless,REPO} from './harness.mts';
requireHeadless();
const out=resolve(REPO,'out/acceptance/real-path',`${Date.now()}-ptt-start-rejection`);
await mkdir(out,{recursive:true});
const server=createServer((q,r)=>r.end('<html><body><h1>Voice failure probe</h1></body></html>'));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const rp=await launchRealPath();
const contexts:any[]=[];
rp.cdp.onEvent('Runtime.executionContextCreated',(e:any)=>contexts.push(e.params.context));
try{
 const target=await rp.cdp.send('Target.createTarget',{url:`http://127.0.0.1:${(server.address() as any).port}`});const page=await rp.attach(target.targetId);await rp.cdp.send('Runtime.enable',{},page);
 const ctx=await until(async()=>contexts.find(c=>c.name===rp.extensionId||c.origin===`chrome-extension://${rp.extensionId}`),10000,'扩展脚本上下文');
 await rp.cdp.send('Runtime.evaluate',{contextId:ctx.id,expression:`(()=>{const original=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(m,...args)=>m?.type==='ptt' ? Promise.resolve(m.phase==='start'?{ok:false,reason:'failed',message:'controlled start failure'}:{ok:true}) : original(m,...args);})()`},page);
 await rp.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Alt',code:'AltRight',windowsVirtualKeyCode:18,location:2,modifiers:1},page);
 await new Promise(r=>setTimeout(r,400));
 await rp.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Alt',code:'AltRight',windowsVirtualKeyCode:18,location:2,modifiers:0},page);
 await new Promise(r=>setTimeout(r,500));
 const phases=await rp.evaluate(page,`Array.from(document.querySelectorAll('[data-phase]')).map(e=>e.getAttribute('data-phase'))`);console.log(phases);
 await rp.screenshot(page,resolve(out,'result.png'));
 assert.ok((phases as string[]).includes('failed'));assert.ok(!(phases as string[]).includes('transcribing'));
}finally{await rp.close();server.close();}
