/** Boss-owned UI evaluator: production sidepanel bundle + CSS, stub transport only. */
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createCdp} from './cdp.mjs';
const baseline=process.argv.includes('--baseline');
const out=await mkdtemp(join(tmpdir(),'ego-composer-fit-'));
const css=baseline?execFileSync('git',['show','40993d5:extension/src/sidepanel/styles.css'],{encoding:'utf8'}):await readFile('extension/src/sidepanel/styles.css','utf8');
const mock=`globalThis.uiMessages=[];globalThis.uiListeners=[];globalThis.uiDisconnects=[];globalThis.uiMicCalls=0;globalThis.uiEmit=e=>uiListeners.forEach(fn=>fn(e));
const storage={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL(p,location.href).href,connect:()=>({onMessage:{addListener:f=>uiListeners.push(f)},onDisconnect:{addListener:f=>uiDisconnects.push(f)},disconnect:()=>{},postMessage:m=>{uiMessages.push(m);if(m.kind==='client'&&m.msg.type==='voice'&&m.msg.command.kind==='start')setTimeout(()=>uiEmit({kind:'server',msg:{type:'voice',conversationId:'default',voiceId:m.msg.voiceId,event:{kind:'state',state:'ready'}}}),10);}})},storage:{local:storage,session:storage},tabs:{query:async()=>[{id:1,title:'正在查看的页面',url:'https://example.test/'}],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
navigator.permissions.query=async()=>({state:'granted'});navigator.mediaDevices.getUserMedia=async()=>{uiMicCalls++;const a=new AudioContext();globalThis.testCaptureContext=a;return a.createMediaStreamDestination().stream;};`;
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url!,'http://localhost').pathname;
 if(path==='/mock.js'){res.setHeader('Content-Type','text/javascript');res.end(mock);return;}
 if(path==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
 if(path==='/'||path==='/sidepanel.html'){res.setHeader('Content-Type','text/html');res.end((await readFile('extension/sidepanel.html','utf8')).replace('<script type="module"','<script src="mock.js"></script><script type="module"'));return;}
 const p=resolve('extension/dist','.'+path);if(!p.startsWith(resolve('extension/dist')+'/'))throw Error('path');
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2','.svg':'image/svg+xml'} as any)[extname(p)]??'application/octet-stream');res.end(await readFile(p));
 }catch{res.statusCode=404;res.end();}});
const report:any={ok:false,baseline,source:'production sidepanel.js and styles.css; background transport and microphone stream are test doubles',cases:[],clicks:[],errors:[]};
let child:ReturnType<typeof spawn>|undefined,cdp:ReturnType<typeof createCdp>|undefined;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>Promise<T|undefined>,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(100);}throw Error('UI evaluator timeout: '+report.stage);}
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/sidepanel.html`;
 const profile=join(out,'profile');child=spawn('/Users/mahaoxuan/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',['--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
 report.stage='startup';const port=await until(async()=>{try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return undefined;}});
 const info:any=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json());cdp=createCdp(info.webSocketDebuggerUrl);await cdp.ready();
 const target=await cdp.send('Target.createTarget',{url:'about:blank'});const sid=await cdp.attachSession(target.targetId);
 cdp.onEvent('Runtime.exceptionThrown',(event:any)=>report.errors.push(event.params.exceptionDetails.exception?.description??event.params.exceptionDetails.text));
 await cdp.send('Runtime.enable',{},sid);await cdp.send('Page.enable',{},sid);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sid);
 const evaluate=async(expression:string)=>{const r=await cdp!.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sid);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value;};
 const click=async(selector:string)=>{const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();if(!r||!r.width||!r.height)throw Error('not visible');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp!.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point},sid);await cdp!.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point},sid);await sleep(120);};
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:400,height:1000,deviceScaleFactor:1,mobile:false},sid);await cdp.send('Page.navigate',{url},sid);
 report.stage='production DOM';await until(async()=>await evaluate('!!document.querySelector("#composer-bar")&&uiListeners.length>0')||undefined);
 await evaluate(`uiEmit({kind:'conversations',selectedConversationId:'default',conversations:[{id:'default',title:'浏览当前页面',createdAt:1,updatedAt:1,state:'idle',mode:'act'}]});uiEmit({kind:'conn',state:'connected'});uiEmit({kind:'server',msg:{type:'hello_ok',version:1,model:'minimax-cn/MiniMax-M3',models:[{id:'minimax-cn/MiniMax-M3',provider:'minimax-cn',modelId:'MiniMax-M3',name:'MiniMax-M3（最新·多模态）'}]}});`);
 const geometry=()=>evaluate(`(()=>{const c=document.querySelector('#composer').getBoundingClientRect(),b=document.querySelector('#composer-bar').getBoundingClientRect();const buttons=[...document.querySelectorAll('#composer-bar button')].filter(e=>!e.hidden&&getComputedStyle(e).display!=='none').map(e=>{const r=e.getBoundingClientRect();return {id:e.id||e.className,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};});const inside=buttons.every(r=>r.width>=20&&r.height>=20&&r.x>=c.x-1&&r.right<=c.right+1&&r.right<=innerWidth+1);const overlap=buttons.some((a,i)=>buttons.slice(i+1).some(d=>Math.min(a.right,d.right)-Math.max(a.x,d.x)>1&&Math.min(a.bottom,d.bottom)-Math.max(a.y,d.y)>1));return {clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,composer:{x:c.x,right:c.right},bar:{x:b.x,right:b.right},buttons,ok:document.documentElement.scrollWidth<=document.documentElement.clientWidth+1&&inside&&!overlap};})()`);
 for(const width of [320,360,400,440,520])for(const state of ['idle','running','user'])for(const voice of [false,true]){
  report.stage=`${width}/${state}/voice=${voice}`;await cdp.send('Emulation.setDeviceMetricsOverride',{width:640,height:1000,deviceScaleFactor:1,mobile:false},sid);
  await evaluate(`(()=>{uiEmit({kind:'server',msg:{type:'status',conversationId:'default',state:${JSON.stringify(state)}}});document.querySelector('#model-name').textContent='MiniMax-M3（最新·多模态·长模型名称）';const tag=document.querySelector('#model-reasoning-tag');tag.hidden=false;tag.textContent='高强度思考';})()`);
  const isVoice=await evaluate(`document.querySelector('.voice-start').getAttribute('aria-expanded')==='true'`);if(isVoice!==voice)await click('.voice-start');
  await until(async()=>await evaluate(`document.querySelector('.voice-start').getAttribute('aria-expanded')===${JSON.stringify(String(voice))}&&document.querySelector('.voice-progress').hidden===${!voice}`)||undefined);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false},sid);
  await sleep(100);const result=await geometry();report.cases.push({width,state,voice,...result});
  if(width===400&&state==='running'&&voice||width===320&&state==='running'&&voice){const shot=await cdp.send('Page.captureScreenshot',{format:'png'},sid);await writeFile(join(out,`${baseline?'before':'after'}-${width}.png`),Buffer.from(shot.data,'base64'));}
 }
 if(!baseline){
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:360,height:1000,deviceScaleFactor:1,mobile:false},sid);
  const oldVoice=await evaluate(`uiMessages.filter(m=>m.kind==='client'&&m.msg.type==='voice'&&m.msg.command.kind==='start').at(-1).msg.voiceId`);
  const micBefore=await evaluate('uiMicCalls');
  await evaluate(`uiListeners=[];const handlers=uiDisconnects.splice(0);handlers.forEach(f=>f());`);
  report.clicks.push({name:'Port loss shows automatic recovery',ok:await evaluate(`document.querySelector('.voice-progress').dataset.state==='connecting'`)});
  await until(async()=>await evaluate(`uiListeners.length>0`)||undefined);
  await evaluate(`uiEmit({kind:'conn',state:'connected'});`);
  await until(async()=>await evaluate(`document.querySelector('.voice-progress').dataset.state==='listening'`)||undefined);
  report.clicks.push({name:'Port reconnect resumes voice with same microphone and fresh lease',ok:await evaluate(`uiMicCalls===${micBefore}&&uiMessages.filter(m=>m.kind==='client'&&m.msg.type==='voice'&&m.msg.command.kind==='start').at(-1).msg.voiceId!==${JSON.stringify(oldVoice)}`)});
  await click('.voice-start');await evaluate(`uiEmit({kind:'conn',state:'connected'});`);await sleep(1100);
  report.clicks.push({name:'explicit end stays ended after reconnect',ok:await evaluate(`document.querySelector('.voice-progress').hidden`)});
  await click('#attach-btn');report.clicks.push({name:'attachment menu opens',ok:await evaluate(`!document.querySelector('#attach-menu').hidden`)});await click('#attach-btn');
  await click('#model-btn');report.clicks.push({name:'model picker opens',ok:await evaluate(`document.querySelector('#model-btn').getAttribute('aria-expanded')==='true'`)});await click('#model-btn');
  await evaluate(`uiEmit({kind:'server',msg:{type:'status',conversationId:'default',state:'running'}});uiMessages.length=0;`);await click('#takeover-btn');report.clicks.push({name:'takeover dispatches',ok:await evaluate(`uiMessages.some(m=>m.kind==='control'&&m.action==='takeover')`)});
  await click('#send-btn');report.clicks.push({name:'stop dispatches',ok:await evaluate(`uiMessages.some(m=>m.kind==='client'&&m.msg.type==='abort')`)});
  await evaluate(`uiEmit({kind:'server',msg:{type:'status',conversationId:'default',state:'idle'}});const i=document.querySelector('#input');i.value='验证发送';i.dispatchEvent(new Event('input',{bubbles:true}));uiMessages.length=0;`);await click('#send-btn');report.clicks.push({name:'send dispatches',ok:await evaluate(`uiMessages.some(m=>m.kind==='client'&&m.msg.type==='task_action'&&m.msg.request.action==='start'&&m.msg.request.text==='验证发送')`)});
 }
 report.ok=report.cases.every((c:any)=>c.ok)&&report.clicks.every((c:any)=>c.ok)&&!report.errors.length;
 if(!report.ok)process.exitCode=1;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{
 if(cdp)await cdp.close();if(child){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await Promise.race([exited,sleep(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,failed:report.cases.filter((c:any)=>!c.ok).map((c:any)=>({width:c.width,state:c.state,voice:c.voice,scrollWidth:c.scrollWidth})),clicks:report.clicks,error:report.error,errors:report.errors}));
}
