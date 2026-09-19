/** Boss-owned UI evaluator: production sidepanel bundle + CSS, stub transport only. */
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {existsSync,readdirSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
import {spawn} from 'node:child_process';
import {createCdp} from './cdp.mjs';
const cache=join(homedir(),'Library/Caches/ms-playwright');
const chromePath=readdirSync(cache).filter(n=>/^chromium-\d+$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])).map(n=>join(cache,n,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(p=>existsSync(p));
if(!chromePath)throw Error('Chrome for Testing is unavailable');
if(!process.argv.includes('--headless'))throw Error('Required --headless');
// 默认仍写历史证据目录；要跑回归又不想覆盖旧截图时用 --out= 指定。
const outArg=process.argv.find(a=>a.startsWith('--out='));
const out=resolve(outArg?outArg.slice(6):'docs/evals/20260916-sidebar-header');await mkdir(out,{recursive:true});
const css=await readFile('extension/src/sidepanel/styles.css','utf8');
const mock=`globalThis.uiMessages=[];globalThis.uiListeners=[];globalThis.uiDisconnects=[];globalThis.uiEmit=e=>uiListeners.forEach(fn=>fn(e));
const storage={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL(p,location.href).href,connect:()=>({onMessage:{addListener:f=>uiListeners.push(f)},onDisconnect:{addListener:f=>uiDisconnects.push(f)},disconnect:()=>{},postMessage:m=>{uiMessages.push(m);}})},storage:{local:storage,session:storage},tabs:{query:async()=>[{id:1,title:'正在查看的页面',url:'https://example.test/'}],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
`;
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url!,'http://localhost').pathname;
 if(path==='/mock.js'){res.setHeader('Content-Type','text/javascript');res.end(mock);return;}
 if(path==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
 if(path==='/'||path==='/sidepanel.html'){res.setHeader('Content-Type','text/html');res.end((await readFile('extension/sidepanel.html','utf8')).replace('<script type="module"','<script src="mock.js"></script><script type="module"'));return;}
 const p=resolve('extension/dist','.'+path);if(!p.startsWith(resolve('extension/dist')+'/'))throw Error('path');
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2','.svg':'image/svg+xml'} as any)[extname(p)]??'application/octet-stream');res.end(await readFile(p));
 }catch{res.statusCode=404;res.end();}});
const report:any={ok:false,source:'production sidepanel.js and styles.css; background transport and storage are test doubles; no live Agent actions',cases:[],clicks:[],errors:[]};
let child:ReturnType<typeof spawn>|undefined,cdp:ReturnType<typeof createCdp>|undefined;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>Promise<T|undefined>,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(100);}throw Error('UI evaluator timeout: '+report.stage);}
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/sidepanel.html`;
 const profile=await mkdtemp(join(tmpdir(),'sidebar-header-'));child=spawn(chromePath,['--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
 report.stage='startup';const port=await until(async()=>{try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return undefined;}});
 const info:any=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json());cdp=createCdp(info.webSocketDebuggerUrl);await cdp.ready();
 const target=await cdp.send('Target.createTarget',{url:'about:blank'});const sid=await cdp.attachSession(target.targetId);
 cdp.onEvent('Runtime.exceptionThrown',(event:any)=>report.errors.push(event.params.exceptionDetails.exception?.description??event.params.exceptionDetails.text));
 await cdp.send('Runtime.enable',{},sid);await cdp.send('Page.enable',{},sid);await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},sid);
 const evaluate=async(expression:string)=>{const r=await cdp!.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sid);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value;};
 const click=async(selector:string)=>{const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();if(!r||!r.width||!r.height)throw Error('not visible');return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp!.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point},sid);await cdp!.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point},sid);await sleep(120);};
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:400,height:1000,deviceScaleFactor:1,mobile:false},sid);await cdp.send('Page.navigate',{url},sid);
 report.stage='production DOM';await until(async()=>await evaluate('!!document.querySelector("#composer-bar")&&uiListeners.length>0')||undefined);
 await evaluate(`uiEmit({kind:'conversations',selectedConversationId:'default',conversations:[{id:'default',title:'打开知乎，找一篇有评论的文章',createdAt:1,updatedAt:1,state:'idle',mode:'act'}]});uiEmit({kind:'conn',state:'connected'});uiEmit({kind:'server',msg:{type:'hello_ok',version:1,model:'minimax-cn/MiniMax-M3',models:[{id:'minimax-cn/MiniMax-M3',provider:'minimax-cn',modelId:'MiniMax-M3',name:'MiniMax-M3（最新·多模态）'}]}});`);

 const check=async(name:string,expression:string)=>{const ok=!!await evaluate(expression);report.clicks.push({name,ok});if(!ok)throw Error(name);};
 const shot=async(name:string)=>{const image=await cdp!.send('Page.captureScreenshot',{format:'png'},sid);await writeFile(join(out,name+'.png'),Buffer.from(image.data,'base64'));};
 const key=async(key:string,code:string)=>{await cdp!.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,text:key==='Enter'?'\r':undefined,windowsVirtualKeyCode:key==='Escape'?27:13},sid);await cdp!.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:key==='Escape'?27:13},sid);};
 await evaluate(`(()=>{const request=uiMessages.find(m=>m.kind==='client'&&m.msg.type==='conversation_create');if(request)uiEmit({kind:'server',msg:{type:'conversation_created',requestId:request.msg.requestId,conversation:{id:'default',title:'打开知乎，找一篇有评论的文章',createdAt:1,updatedAt:1,state:'idle',mode:'act'}}});uiEmit({kind:'server',msg:{type:'status',conversationId:'default',state:'idle'}})})()`);
 await check('idle strip hidden; healthy connection quiet',`document.querySelector('#task-strip').hidden && getComputedStyle(document.querySelector('#status-text')).display==='none'`);
 await shot('01-idle');
 await click('#header-more');await check('more opens',`document.querySelector('#header-menu').matches(':popover-open')`);
 await check('menu animates on pointer entry',`document.querySelector('#header-menu').getAnimations().length>0`);await check('menu uses opacity and transform transition',`getComputedStyle(document.querySelector('#header-menu')).transitionProperty.includes('transform')`);
 await sleep(260);await shot('02-more');
 await key('Escape','Escape');await check('Escape restores focus',`!document.querySelector('#header-menu').matches(':popover-open')&&document.activeElement.id==='header-more'`);
 await key('Enter','Enter');await sleep(100);await check('keyboard opens without motion',`document.querySelector('#header-menu').matches(':popover-open')&&getComputedStyle(document.querySelector('#header-menu')).transitionDuration==='0s'`);
 await key('Escape','Escape');
 await click('#header-more');await click('#header-more');await click('#header-more');
 await check('rapid open-close-open remains open',`document.querySelector('#header-menu').matches(':popover-open')`);
 await click('#brand');await check('outside click dismisses',`!document.querySelector('#header-menu').matches(':popover-open')`);
 await click('#header-more');await click('#reading-settings-btn');await check('reading opens and menu closes',`!document.querySelector('#reading-settings-panel').hidden&&!document.querySelector('#header-menu').matches(':popover-open')&&document.activeElement.id==='reading-settings-font'`);
 await evaluate(`const font=document.querySelector('#reading-settings-font');font.value='hei';font.dispatchEvent(new Event('change',{bubbles:true}));`);
 await check('reading preference changes answer typography',`document.documentElement.style.getPropertyValue('--reading-font').includes('Heiti')`);
 await click('#reading-settings-close');await check('reading closes to visible trigger',`document.querySelector('#reading-settings-panel').hidden&&document.activeElement.id==='header-more'`);
 await click('#header-more');await click('#memory-open');await check('knowledge opens with focus',`!document.querySelector('#memory-drawer').hidden&&document.activeElement.id==='memory-close'`);
 await key('Escape','Escape');await check('knowledge closes to visible trigger',`document.querySelector('#memory-drawer').hidden&&document.activeElement.id==='header-more'`);
 await click('#header-more');await click('#record-toggle');await check('recording dispatches',`uiMessages.some(m=>m.kind==='demo'&&m.action==='start')`);
 await evaluate(`uiEmit({kind:'demo',recording:true,steps:[],truncated:false})`);
 await check('recording stop visible',`!document.querySelector('#demo-stop').hidden`);
 await click('#demo-stop');await check('recording stops via visible button',`uiMessages.some(m=>m.kind==='demo'&&m.action==='stop')`);
 await evaluate(`uiEmit({kind:'demo',recording:false,steps:[],truncated:false});const mode=document.querySelector('#teach-toggle');mode.value='teach';mode.dispatchEvent(new Event('change',{bubbles:true}));`);
 await check('mode dispatches teach',`uiMessages.some(m=>m.kind==='client'&&m.msg.type==='set_mode'&&m.msg.mode==='teach')`);
 await evaluate(`uiEmit({kind:'mode',mode:'act'})`);
 await check('mode authoritative update restores selection',`document.querySelector('#teach-toggle').value==='act'`);
 await click('#conversation-switcher');await check('history opens',`!document.querySelector('#conversation-menu').hidden`);
 await click('#conversation-switcher');await click('#conversation-new');await check('new conversation dispatches and stays compact',`uiMessages.some(m=>m.kind==='client'&&m.msg.type==='conversation_create')&&document.querySelector('#conversation-new').getAttribute('aria-busy')==='true'`);
 for(const width of [320,360,400,520])for(const state of ['idle','running','user']){
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false},sid);
   await evaluate(`uiEmit({kind:'server',msg:{type:'status',conversationId:'default',state:${JSON.stringify(state)}}})`);
   await check(`${width}/${state} no horizontal overflow`,`document.documentElement.scrollWidth<=innerWidth`);
   if(state==='user'){
     // T03：控制权状态改由任务条（task-bar.ts）表达；这里按真实结构补一份暂停视图。
     await evaluate(`uiEmit({kind:'server',msg:{type:'task_view',conversationId:'default',view:{conversationId:'default',runId:'run-sidebar-header',controlVersion:1,observedAt:Date.now(),state:'paused',goal:'打开知乎，找一篇有评论的文章',revisions:[],page:{tabId:1,urlHash:'h'},active:[],lastAction:null,waiting:{reason:'human_control',detail:null},results:[],outstanding:[],latestDelivery:null,resumable:false}}})`);
     await check('takeover state remains visible',`document.querySelector('#task-bar-root')?.textContent.includes('页面归你')===true`);
   }
 }
 await evaluate(`uiEmit({kind:'server',msg:{type:'status',conversationId:'default',state:'idle'}});uiEmit({kind:'conn',state:'disconnected'})`);
 await check('disconnect visible',`getComputedStyle(document.querySelector('#status-text')).display!=='none'`);
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:320,height:800,deviceScaleFactor:1,mobile:false},sid);
 await shot('03-disconnected-narrow');
 await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sid);
 await click('#header-more');await sleep(200);await check('reduced motion has no movement',`getComputedStyle(document.querySelector('#header-menu')).transform==='none'`);
 await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]},sid);await shot('04-dark');
 report.ok=report.clicks.every((c:any)=>c.ok)&&!report.errors.length;
 if(!report.ok)process.exitCode=1;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{
 if(cdp)await cdp.close();if(child){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await Promise.race([exited,sleep(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,checks:report.clicks,error:report.error,errors:report.errors}));
}
