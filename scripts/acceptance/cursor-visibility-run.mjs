/** ChromeMain 已加载扩展的输入链 + 同一内容脚本的可视状态检查。仅操作本轮本地页。 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { discoverChromeMain } from './discover.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { installExecuteToolCallHook, normalizeServiceWorkerInspector } from './sw-hook.mjs';

const out = process.env.CURSOR_EVIDENCE_DIR || '/tmp/ego-cursor-visibility-20260910';
await mkdir(out, {recursive:true});
const html = await readFile(new URL('../../extension/test/fixtures/acceptance/cursor-visibility.html',import.meta.url));
const server = createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const records=[];let cdp,session,tabId,previousTabId,windowId;let seq=0;
const runId='cursor-'+Date.now();
const frontmostBundle=()=>execFileSync('osascript',['-e','tell application "System Events" to get bundle identifier of first application process whose frontmost is true'],{encoding:'utf8',timeout:4000}).trim();
let previousApp;
const sid='acpt';
const sw=expression=>evaluateInWorker(cdp,session,expression,45000);
const call=async(name,params)=>{
  const start=Date.now();
  const r=await sw(`globalThis.__saCall(${JSON.stringify(runId+'-'+ ++seq)},${JSON.stringify(name)},${JSON.stringify(params)},${JSON.stringify(sid)})`);
  records.push({type:'tool',name,ok:r.ok,elapsedMs:Date.now()-start,error:r.error});
  assert.equal(r.ok,true,r.error);return r.data;
};
const page=async(fn,args=[],world='ISOLATED')=>sw(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:${JSON.stringify(world)},func:${fn.toString()},args:${JSON.stringify(args)}}).then(r=>r[0]?.result)`);
const state=()=>page(id=>window.__sideagent?.cursorState?.(id),[sid]);
const check=(name,condition,data)=>{records.push({type:'check',name,passed:Boolean(condition),data});assert(condition,name);console.log('PASS '+name);};
const shot=async(name)=>{
  const r=await sw(`chrome.debugger.sendCommand({tabId:${tabId}},'Page.captureScreenshot',{format:'png'})`);
  await writeFile(`${out}/${name}.png`,Buffer.from(r.data,'base64'));
};
const wait=async(test,ms=4000)=>{const end=Date.now()+ms;let value;do{value=await test();if(value)return value;await new Promise(r=>setTimeout(r,40));}while(Date.now()<end);throw Error('可视状态等待超时');};
async function runAndCapture(name,params,file){
  const pending=call(name,params);let error;pending.catch(e=>{error=e;});
  const seen=await wait(async()=>{if(error)throw error;const s=await state();return s?.phase==='active'?s:null;});
  check(name+' shows actual action label',seen.label.includes(name==='fill'?'正在填写':'正在点击'),seen);
  await shot(file);await pending;
  const after=await state();check(name+' ends from execution receipt',after?.phase==='done',after);
  return after;
}
async function visualBegin(target,id='visual',kind='fill'){
  return page((sid,target,id,kind)=>{
    const el=document.querySelector(target),r=el.getBoundingClientRect(),c=window.__sideagent.cursor.for(sid);
    c.beginAction(id,kind,{x:r.x,y:r.y,width:r.width,height:r.height},el);
    return c.move(r.x+r.width/2,r.y+r.height/2);
  },[sid,target,id,kind]);
}
async function startRecording(){
  await sw(`(() => {
    const frames=[];
    const listener=(source,method,p)=>{
      if(source.tabId!==${tabId}||method!=='Page.screencastFrame')return;
      if(frames.length<120)frames.push({data:p.data,t:p.metadata.timestamp});
      void chrome.debugger.sendCommand({tabId:${tabId}},'Page.screencastFrameAck',{sessionId:p.sessionId}).catch(()=>{});
    };
    globalThis.__cursorRecording={frames,listener};chrome.debugger.onEvent.addListener(listener);
    return chrome.debugger.sendCommand({tabId:${tabId}},'Page.startScreencast',{format:'jpeg',quality:65,maxWidth:1440,maxHeight:960,everyNthFrame:2});
  })()`);
}
async function stopRecording(){
  const frames=await sw(`(async()=>{
    const r=globalThis.__cursorRecording;if(!r)return [];
    await chrome.debugger.sendCommand({tabId:${tabId}},'Page.stopScreencast').catch(()=>{});
    chrome.debugger.onEvent.removeListener(r.listener);delete globalThis.__cursorRecording;return r.frames;
  })()`);
  if(frames.length<2)return;
  await mkdir(`${out}/frames`,{recursive:true});const lines=['ffconcat version 1.0'];
  for(let i=0;i<frames.length;i++){
    const name=`frame-${String(i).padStart(3,'0')}.jpg`;
    await writeFile(`${out}/frames/${name}`,Buffer.from(frames[i].data,'base64'));
    lines.push(`file '${name}'`,`duration ${Math.min(2,Math.max(.016,(frames[i+1]?.t??frames[i].t+.8)-frames[i].t))}`);
  }
  await writeFile(`${out}/frames/list.txt`,lines.join('\n')+'\n');
  execFileSync('ffmpeg',['-y','-loglevel','error','-f','concat','-safe','0','-i',`${out}/frames/list.txt`,'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-pix_fmt','yuv420p','-movflags','+faststart',`${out}/action.mp4`]);
  records.push({type:'recording',frames:frames.length,path:'action.mp4'});
}
try{
  ({cdp}=await connectBrowser(discoverChromeMain().port));
  const ext=sideagentExtensionId(),worker=findServiceWorker((await cdp.send('Target.getTargets')).targetInfos,ext);
  assert(worker,'正式扩展 service worker 必须在线');session=await cdp.attachSession(worker.targetId);
  await normalizeServiceWorkerInspector(cdp,session);
  await installExecuteToolCallHook(cdp,session,ext,url);
  const disk=await readFile(new URL('../../extension/dist/content-cursor.js',import.meta.url));
  const loaded=await sw(`fetch(chrome.runtime.getURL('content-cursor.js')).then(r=>r.text())`);
  check('loaded cursor matches build',createHash('sha256').update(disk).digest('hex')===createHash('sha256').update(loaded).digest('hex'));
  const opened=await call('open_tab',{url});tabId=opened.tabId;
  const tab=await sw(`chrome.tabs.get(${tabId})`);windowId=tab.windowId;
  previousTabId=await sw(`chrome.tabs.query({active:true,windowId:${windowId}}).then(t=>t[0]?.id)`);
  previousApp=frontmostBundle();
  await sw(`chrome.tabs.update(${tabId},{active:true})`);
  await sw(`chrome.windows.update(${windowId},{focused:true})`);
  await wait(()=>page(()=>document.visibilityState==='visible'));
  await call('snapshot',{});
  await call('hover',{target:'#busy-next'});
  check('hover identifies actual target',(await state())?.label.includes('查看详情'));
  await startRecording();
  const filled=await runAndCapture('fill',{target:'#email',value:'cursor-test@example.com'},'01-filling');
  check('field name present and value absent',filled.label.includes('联系邮箱')&&!filled.label.includes('cursor-test@'),filled);
  await runAndCapture('click',{target:'#next'},'02-clicking');
  const outcome=await page(()=>({count:window.clickCount,text:document.querySelector('#result').textContent} ),[],'MAIN');
  check('actual fill and exactly one click',outcome.count===1&&outcome.text.includes('cursor-test@example.com'),outcome);
  await shot('03-result');
  await stopRecording();
  // AX 路径：从本次正式 snapshot 获取 ref，不以 CSS 成功代替。
  const snap=await call('snapshot',{});await writeFile(`${out}/snapshot.txt`,snap.text);
  const line=snap.text.split('\n').find(l=>l.includes('联系人姓名')&&l.includes('textbox'));
  const number=line?.match(/\[ref=(\d+)\]/)?.[1];const ref=number?'@'+number:null;
  check('snapshot exposes field AX ref',Boolean(ref),line);
  await call('fill',{target:ref,value:'测试联系人'});
  const ax=await state();check('AX action labels and anchors same node',ax?.label.includes('联系人姓名')&&ax.targetRect?.width>0,ax);
  // 以下为同一正式内容脚本的合成状态检查，不宣称为模型自主操作。
  for(const [target,file] of [['#email','04-light'],['#name','05-dark'],['#topic','06-busy']]){
    await visualBegin(target);
    await wait(async()=>{const s=await state();return s?.targetRect&&Math.abs(s.x-(s.targetRect.x+s.targetRect.width/2))<2?s:null;});
    const s=await state(),l=s.labelRect,t=s.targetRect;
    const viewport=await page(()=>({width:innerWidth,height:innerHeight}));
    check(file+' label avoids target and edges',l.x>=8&&l.y>=8&&l.x+l.width<=viewport.width-7&&l.y+l.height<=viewport.height-7&&(l.x>=t.x+t.width||l.y>=t.y+t.height||l.x+l.width<=t.x||l.y+l.height<=t.y),s);
    check(file+' cursor size',s.size===44);await shot(file);
  }
  await new Promise(r=>setTimeout(r,1600));check('active action survives old park/highlight deadlines',(await state())?.phase==='active');
  await page(id=>window.__sideagent.cursor.for(id).endAction('visual','done'),[sid]);
  await visualBegin('#email','new-action');
  await page(id=>window.__sideagent.cursor.for(id).endAction('visual','unknown'),[sid]);
  check('late receipt cannot replace new action',(await state())?.action==='new-action'&&(await state())?.phase==='active');
  await page(id=>window.__sideagent.cursor.for(id).hide(),[sid]);
  await page(id=>window.__sideagent.cursor.for(id).endAction('new-action','done'),[sid]);
  check('hide prevents late feedback resurrection',(await state())?.hidden===true&&(await state())?.action===null);
  await page(id=>window.__sideagent.cursor.for(id).replay([{x:120,y:180,click:false},{x:260,y:180,click:true}]),[sid]);
  await visualBegin('#name','interrupt-replay');
  await new Promise(r=>setTimeout(r,1300));
  const interrupted=await state();
  check('new action interrupts old replay',interrupted?.action==='interrupt-replay'&&interrupted.phase==='active'&&Math.abs(interrupted.x-interrupted.targetRect.x-interrupted.targetRect.width/2)<2,interrupted);
  await visualBegin('#nested','scroll');
  await wait(async()=>{const s=await state();return s?.targetRect&&Math.abs(s.y-(s.targetRect.y+s.targetRect.height/2))<2;});
  const before=await state();await page(()=>{document.querySelector('#scroll').scrollTop=35;});
  await wait(async()=>Math.abs((await state()).targetRect.y-before.targetRect.y+35)<2);
  check('nested scrolling tracks same target',true);await shot('07-scroll');
  await page(()=>{const old=document.querySelector('#nested');const clone=old.cloneNode(true);old.replaceWith(clone);});
  await wait(async()=>(await state())?.action===null);check('replacement never inherits old target indicator',true);
  await sw(`chrome.debugger.sendCommand({tabId:${tabId}},'Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})`);
  const duration=await visualBegin('#email','reduce');check('reduced motion preserves label without travel',duration===0&&(await state()).label.includes('正在填写'));
  await shot('08-reduced-motion');
  await page(id=>window.__sideagent.cursor.for(id).endAction('reduce','unknown'),[sid]);
  const unknown=await state();check('uncertain result never says clicked or success',unknown.phase==='unknown'&&unknown.label.includes('结果待确认')&&!unknown.label.includes('已点击'),unknown);
  await page(id=>window.__sideagent.cursor.for(id).endAction('reduce','done'),[sid]);
  check('duplicate terminal receipt cannot overwrite unknown',(await state()).phase==='unknown');
  await wait(async()=>(await state())?.resting===true,5000);check('completed action clears and parks',true);
}catch(error){
  const diagnostic=tabId?await page(id=>({state:window.__sideagent?.cursorState?.(id),visibility:document.visibilityState}),[sid]).catch(()=>null):null;
  records.push({type:'failure',error:error.stack,diagnostic});console.error(error,diagnostic);process.exitCode=1;
}
finally{
  if(tabId&&cdp){
    await stopRecording().catch(()=>{});
    if(previousTabId&&previousTabId!==tabId)await sw(`chrome.tabs.query({active:true,windowId:${windowId}}).then(t=>t[0]?.id===${tabId}?chrome.tabs.update(${previousTabId},{active:true}):null)`).catch(()=>{});
    await sw(`chrome.tabs.remove(${tabId})`).catch(()=>{});
  }
  await cdp?.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  if(previousApp&&/^[a-zA-Z0-9.-]+$/.test(previousApp)&&previousApp!=='com.google.Chrome'&&frontmostBundle()==='com.google.Chrome'){
    execFileSync('osascript',['-e',`tell application id "${previousApp}" to activate`],{timeout:4000});
  }
  await writeFile(`${out}/result.json`,JSON.stringify({ok:!process.exitCode,records},null,2)+'\n');console.log('evidence '+out);
}
