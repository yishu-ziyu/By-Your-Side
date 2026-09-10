/** Boss-owned UI evaluator: production sidepanel bundle + CSS, stub transport only. */
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createCdp} from './cdp.mjs';
import {PanelHistory} from '../../extension/src/background/panel-history.js';
const baseline=process.argv.includes('--baseline');
const out=await mkdtemp(join(tmpdir(),'ego-user-delivery-ui-'));
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
 const assert=async(name:string,expression:string)=>{const ok=!!await evaluate(expression);report.clicks.push({name,ok});console.log(ok?'PASS':'FAIL',name);};
 const event=(event:any)=>({type:'agent_event',conversationId:'default',event});
 const legacy='过去保存的回答仍能阅读。';const internal='INTERNAL_WORK_TRACE_not_a_user_reply';const text='竹海工作坊发来活动邀请。我只看了标题，还没打开正文。';
 const delivery={conversationId:'default',id:'explicit-one',runId:'run-one',kind:'finding',text,composedAt:100,status:'composed'};
 const history=new PanelHistory();
 const status=(state:string)=>({type:'status',conversationId:'default',state});
 const historyEvents=[status('running'),event({kind:'agent_start'}),event({kind:'text_delta',delta:legacy}),status('idle'),event({kind:'agent_end'}),status('running'),event({kind:'agent_start',deliveryMode:'explicit'}),event({kind:'text_delta',delta:internal}),event({kind:'user_delivery',delivery}),status('idle'),event({kind:'agent_end'})];
 for(const msg of historyEvents)history.record({kind:'server',msg} as any);
 await evaluate(`uiEmit(${JSON.stringify({kind:'history',conversationId:'default',entries:history.since()})})`);await sleep(150);
 await assert('legacy history remains visible',`[...document.querySelectorAll('.msg.assistant')].some(e=>e.textContent.includes(${JSON.stringify(legacy)}))`);
 await assert('explicit delivery is visible once',`[...document.querySelectorAll('.msg.assistant')].filter(e=>e.textContent.trim()===${JSON.stringify(text)}).length===1`);
 await assert('internal output is not a formal answer',`![...document.querySelectorAll('.msg.assistant')].some(e=>e.textContent.includes(${JSON.stringify(internal)}))`);
 await assert('internal output remains available in execution details',`[...document.querySelectorAll('details.run-steps')].some(e=>e.textContent.includes(${JSON.stringify(internal)}))`);
 await assert('execution details precede the formal answer',`(()=>{const answer=[...document.querySelectorAll('.msg.assistant')].find(e=>e.textContent.trim()===${JSON.stringify(text)});const run=[...document.querySelectorAll('details.run-steps')].find(e=>e.textContent.includes(${JSON.stringify(internal)}));return !!answer&&!!run&&!!(run.compareDocumentPosition(answer)&Node.DOCUMENT_POSITION_FOLLOWING);})()`);
 for(const status of ['composed','speaking','played']){const msg=event({kind:'user_delivery',delivery:{...delivery,status}});history.record({kind:'server',msg} as any);await evaluate(`uiEmit(${JSON.stringify({kind:'server',msg})})`);}
 await evaluate(`uiEmit(${JSON.stringify({kind:'history',conversationId:'default',entries:history.since()})})`);
 await assert('status changes and replay do not duplicate the answer',`[...document.querySelectorAll('.msg.assistant')].filter(e=>e.textContent.trim()===${JSON.stringify(text)}).length===1`);
 const reply='你说的是竹海工作坊那封活动邀请。';
 await evaluate(`uiEmit(${JSON.stringify({kind:'server',msg:event({kind:'user_delivery',delivery:{...delivery,id:'reply-two',kind:'reply',text:reply,composedAt:200}})})})`);
 await assert('a follow-up receives a separate complete answer',`[...document.querySelectorAll('.msg.assistant')].filter(e=>e.textContent.trim()===${JSON.stringify(reply)}).length===1`);
 await assert('the earlier finding stays intact',`[...document.querySelectorAll('.msg.assistant')].filter(e=>e.textContent.trim()===${JSON.stringify(text)}).length===1`);
 await evaluate(`uiEmit(${JSON.stringify({kind:'server',msg:event({kind:'user_delivery',delivery:{...delivery,status:'played'}})})})`);
 await assert('late playback status cannot replace the newer voice answer',`document.querySelector('.voice-answer').textContent.trim()===${JSON.stringify(reply)}`);
 const shot=await cdp.send('Page.captureScreenshot',{format:'png'},sid);await writeFile(join(out,'sidepanel.png'),Buffer.from(shot.data,'base64'));
 report.ok=report.cases.every((c:any)=>c.ok)&&report.clicks.every((c:any)=>c.ok)&&!report.errors.length;
 if(!report.ok)process.exitCode=1;
}catch(e){report.error=String(e);process.exitCode=1;}
finally{
 if(cdp)await cdp.close();if(child){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await Promise.race([exited,sleep(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,failed:report.cases.filter((c:any)=>!c.ok).map((c:any)=>({width:c.width,state:c.state,voice:c.voice,scrollWidth:c.scrollWidth})),clicks:report.clicks,error:report.error,errors:report.errors}));
}
