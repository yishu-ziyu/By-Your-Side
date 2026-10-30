/** 按住说话的键不只认 Mac 的右 ⌥：Windows/Linux 默认右 Ctrl；设置里改成别的键后，打开着的网页马上换成新键。
 * 只判网页报给后台的开始/松开（话不真送去听写），和设置页上用户看到的键名。
 * npx tsx scripts/acceptance/real-path/ptt-key-choice.mts --headless
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {launchRealPath,until,requireHeadless,REPO} from './harness.mts';
requireHeadless();
const out=resolve(REPO,'out/acceptance/real-path',`${Date.now()}-ptt-key-choice`);
await mkdir(out,{recursive:true});
const server=createServer((q,r)=>r.end('<html><body><h1>Key choice probe</h1></body></html>'));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(server.address() as any).port}`;
const rp=await launchRealPath();
const KEYS:Record<string,{key:string,vk:number,location:number}>={AltRight:{key:'Alt',vk:18,location:2},ControlRight:{key:'Control',vk:17,location:2},F8:{key:'F8',vk:119,location:0}};
const hold=async(page:string,code:string)=>{const k=KEYS[code];
 await rp.cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:k.key,code,windowsVirtualKeyCode:k.vk,location:k.location},page);
 await new Promise(r=>setTimeout(r,400));
 await rp.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:k.key,code,windowsVirtualKeyCode:k.vk,location:k.location},page);
 await new Promise(r=>setTimeout(r,300));};
// 打开一页，把网页脚本报给后台的按住说话消息记下来并回“好”，不碰麦克风。
const openPage=async(userAgent?:string)=>{
 const contexts:any[]=[];
 const {targetId}=await rp.cdp.send('Target.createTarget',{url:'about:blank'});const page=await rp.attach(targetId);
 rp.cdp.onEvent('Runtime.executionContextCreated',(e:any)=>{if(e.sessionId===page||!e.sessionId)contexts.push(e.params.context);});
 await rp.cdp.send('Runtime.enable',{},page);
 if(userAgent)await rp.cdp.send('Emulation.setUserAgentOverride',{userAgent},page);
 await rp.cdp.send('Page.enable',{},page);await rp.cdp.send('Page.navigate',{url},page);
 const ctx=await until(async()=>contexts.find(c=>c.origin===`chrome-extension://${rp.extensionId}`||c.name===rp.extensionId),10000,'扩展网页脚本');
 await new Promise(r=>setTimeout(r,500));
 await rp.cdp.send('Runtime.evaluate',{contextId:ctx.id,expression:`globalThis.__ptt=[];(()=>{const original=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(m,...a)=>m?.type==='ptt'?(globalThis.__ptt.push(m.phase),Promise.resolve({ok:true})):original(m,...a);})()`},page);
 const phases=async()=>{const r=await rp.cdp.send('Runtime.evaluate',{contextId:ctx.id,expression:'globalThis.__ptt.splice(0)',returnByValue:true},page);return r.result.value as string[];};
 return {page,targetId,phases};
};
let failed=0;
const check=(name:string,ok:boolean,detail:unknown)=>{console.log(`${ok?'✓':'✗'} ${name}`,JSON.stringify(detail));if(!ok)failed++;};
try{
 const win=await openPage('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
 await hold(win.page,'AltRight');const alt=await win.phases();
 await hold(win.page,'ControlRight');const ctrl=await win.phases();
 check('Windows 默认：右 Ctrl 能按住说话，右 Alt 不开麦',ctrl.join()==='start,stop'&&alt.length===0,{alt,ctrl});

 const {targetId}=await rp.cdp.send('Target.createTarget',{url:`chrome-extension://${rp.extensionId}/settings.html#voice`});const settings=await rp.attach(targetId);
 await until(async()=>(await rp.evaluate(settings,`document.querySelector('#ptt-key-change')?.textContent.includes('改')`))||undefined,10000,'设置页按键行');
 const before=await rp.evaluate(settings,`document.querySelector('#ptt-key-change').textContent`);
 await rp.evaluate(settings,`(()=>{const b=document.querySelector('#ptt-key-change');b.scrollIntoView({block:'center'});b.focus();b.click();})()`);
 await hold(settings,'F8');
 const after=await rp.evaluate(settings,`({button:document.querySelector('#ptt-key-change').textContent,note:document.querySelector('#ptt-key-desc').textContent})`) as {button:string,note:string};
 await rp.screenshot(settings,resolve(out,'settings-key.png'));
 check('设置页：显示当前键，改成 F8 后写明已改',/右 ⌥/.test(String(before))&&/F8/.test(after.button)&&/已改成/.test(after.note),{before,after});

 await rp.cdp.send('Target.activateTarget',{targetId:win.targetId});await new Promise(r=>setTimeout(r,300));
 await hold(win.page,'ControlRight');const oldKey=await win.phases();
 await hold(win.page,'F8');const newKey=await win.phases();
 check('改键后打开着的网页马上换键：F8 能说，右 Ctrl 不再开麦',newKey.join()==='start,stop'&&oldKey.length===0,{oldKey,newKey});
}finally{await rp.close();server.close();}
assert.equal(failed,0,`${failed} 项没过`);
