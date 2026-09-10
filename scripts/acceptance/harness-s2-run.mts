/** Boss-owned explicit-delivery evaluator: production sidepanel action -> runtime/manager -> real Step audio.
 * Synthetic microphone input and recorded output; no user Chrome/profile, no human-ear claim.
 * Chrome tool handlers are production code, transport is a CDP test bridge (not native messaging).
 */
import {build} from 'esbuild';
import {defineTool} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,readdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,randomInt} from 'node:crypto';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {VoiceService} from '../../agent/src/voice-service.js';
import type {VoiceInputContext} from '../../shared/voice.js';
import {createCdp} from './cdp.mjs';
import {deliveryMetrics} from '../../agent/src/user-delivery.js';
import {voiceEvidence} from './voice-evidence.mts';
import {runLiveDialogue} from './live-dialogue-case.mts';


if (!process.argv.some(a=>a.startsWith('--case='))) {
 const suiteOut=await mkdtemp(join(tmpdir(),'ego-harness-s2-suite-'));const results:any[]=[];
 for(const name of ['correction','correction_voice','pause','navigation','cancel']){
  const child=spawn(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/acceptance/harness-s2-run.mts'),'--case='+name],{stdio:['ignore','pipe','pipe']});let log='';
  child.stdout!.on('data',b=>log+=b);child.stderr!.on('data',b=>log+=b);const exitCode=await new Promise(r=>child.on('exit',r));await writeFile(join(suiteOut,name+'.log'),log);
  let result:any;try{result=JSON.parse(log.trim().split('\n').at(-1)!);}catch{result={ok:false,error:'missing final report'};}results.push({name,exitCode,...result});await writeFile(join(suiteOut,'result.json'),JSON.stringify({suiteOut,ok:results.length===5&&results.every(r=>r.ok),results},null,2));console.log(JSON.stringify({name,...result}));
 }
 console.log(JSON.stringify({suiteOut,ok:results.every(r=>r.ok),passed:results.filter(r=>r.ok).length,total:results.length}));process.exit(results.every(r=>r.ok)?0:1);
}
const layout=process.argv.find(a=>a.startsWith('--layout='))?.slice(9)??'cards';
const contentKind=process.argv.find(a=>a.startsWith('--content='))?.slice(10)??'text';
const caseName=process.argv.find(a=>a.startsWith('--case='))?.slice(7)??'correction';
const out=await mkdtemp(join(tmpdir(),'ego-harness-s2-'));
const targetCode='cedar-flash-'+randomInt(1000,9999),otherCode='river-flash-'+randomInt(1000,9999),meterValue=randomInt(10000,99999);
const ext=join(out,'extension'),profile=join(out,'profile');await mkdir(ext);
const marker=randomUUID().slice(0,6);
const organizations=['青鹭','松风','鹤鸣','竹海','白榆','云杉','橙湾','星浦','海棠','岚川'];
const first=randomInt(organizations.length),second=(first+1+randomInt(organizations.length-1))%organizations.length;
const activityOrg=organizations[first]+'工作坊',interviewOrg=organizations[second]+'研究';
const eventName=`${activityOrg}活动邀请`,interviewName=`${interviewOrg}访谈邀请`;
const bodyMarker='纸鹤橙桥'+Math.floor(1000+Math.random()*9000);
const report:any={ok:false,evidence:voiceEvidence(),scope:'production sidepanel DOM/client/worklet/player + task runtime + real models; isolated tools via CDP; synthetic microphone stream, muted browser audio playback; test transport supplies production VoiceObservation grant at commit; not human listening',caseName,layout,contentKind,targetCode,otherCode,marker,activityOrg,interviewOrg,eventName,interviewName,bodyMarker,checks:[],voice:[],tools:[],stages:[]};
const uiMock=`globalThis.uiListeners=[];globalThis.uiMessages=[];globalThis.uiMicCalls=0;globalThis.uiEmit=e=>uiListeners.forEach(fn=>fn(e));
const storage={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL(p,location.href).href,connect:()=>({onMessage:{addListener:f=>uiListeners.push(f)},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:m=>{uiMessages.push(m);globalThis.hostSend(JSON.stringify(m));}})},storage:{local:storage,session:storage},tabs:{query:async()=>[{id:1,title:'受控收件箱',url:location.origin+'/'}],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
navigator.permissions.query=async()=>({state:'granted'});navigator.mediaDevices.getUserMedia=async()=>{uiMicCalls++;const context=new AudioContext({sampleRate:24000}),dest=context.createMediaStreamDestination();await context.resume();globalThis.capture={context,dest};return dest.stream;};
globalThis.injectSpeech=data=>{const {context,dest}=capture,bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),buffer=context.createBuffer(1,bytes.length/2,24000),pcm=buffer.getChannelData(0);for(let i=0;i<pcm.length;i++)pcm[i]=view.getInt16(i*2,true)/32768;const source=context.createBufferSource();source.buffer=buffer;source.connect(dest);source.start();};`;
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url!,'http://local').pathname;
 if(pathname==='/sidepanel.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end((await readFile('extension/sidepanel.html','utf8')).replace('<script type="module"','<script src="mock.js"></script><script type="module"'));return;}
 if(pathname==='/tone.wav'){res.setHeader('Content-Type','audio/wav');res.end(wav(Buffer.alloc(48000*180)));return;}
 if(pathname==='/mock.js'){res.setHeader('Content-Type','text/javascript');res.end(uiMock);return;}
 if(/\.(js|css|woff2|svg|png)$/.test(pathname)){try{const p=resolve('extension/dist','.'+pathname);if(!p.startsWith(resolve('extension/dist')+'/'))throw Error('path');res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'} as any)[extname(p)]??'application/octet-stream');res.end(await readFile(p));}catch{res.statusCode=404;res.end();}return;}

 res.setHeader('Content-Type','text/html; charset=utf-8');
 if(['state_environment','state_tools'].includes(caseName)){
  res.end(`<!doctype html><meta charset="utf-8"><title>视频与评论</title><style>body{font:20px sans-serif;padding:30px}video{width:600px;height:260px;background:#222}article{padding:16px}footer{height:1200px}</style><h1>周末海边</h1><video id="movie" aria-label="周末海边视频" controls autoplay loop src="/tone.wav"></video>${caseName==='state_tools'?`<input id="delayed" type="checkbox" ${req.url?.includes('checked=1')?'checked':''}>`:''}<h2>评论</h2><article>评论一：今天海风很舒服，${targetCode}。</article><article>评论二：下次一起去，${otherCode}。</article><article>评论三：记得带水，${bodyMarker}。</article><footer></footer><script>globalThis.pauseEvents=[];document.querySelector('video').addEventListener('pause',()=>pauseEvents.push(Date.now()));</script>`);return;
 }
 if(layout==='live'){res.end((await readFile('docs/previews/s2-live-check.html','utf8')).replace('id="temporary-model"','id="target"').replace('id="standard-model"','id="other"'));return;}
 if(caseName==='recovery'){
  const label='日程调整'+marker;
  const target=contentKind==='image'?`<img alt="${label}" width="190" height="100" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='190' height='100'%3E%3Crect width='190' height='100' fill='orange'/%3E%3C/svg%3E">`:contentKind==='shadow'?`<div id="shadow-host"></div><script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<p>${label}：下午三点出发。</p>'</script>`:`<p>${label}：下午三点出发。</p>`;
  res.end(`<!doctype html><meta charset="utf-8"><title>通知</title><style>body{font:22px sans-serif;padding:50px}article{max-width:700px;padding:20px;margin-bottom:50px;border:1px solid #ddd}p{margin:20px 0}</style><h1>本周消息</h1><article id="target"><h2>场地安排</h2><p>明天保持原计划。</p></article><article id="other">${target}</article>`);return;
 }
 const order=first%2?[['target',targetCode],['other',otherCode]]:[['other',otherCode],['target',targetCode]];
 res.end(`<!doctype html><meta charset="utf-8"><title>模型说明测试页</title><style>body{font:22px sans-serif;line-height:1.6;padding:36px;max-width:820px}section{padding:20px;border:1px solid #ccc;margin:24px 0}code{font-size:24px}footer{height:1700px}</style><h1>接口说明</h1>${order.map(([id,code])=>`<section id="${id}"><h2>${id==='target'?'临时模型':'标准模型'}</h2><code>${code}</code><p>${id==='target'?'临时模型的有效期为明天。':'标准模型长期有效。'}</p></section>`).join('')}<button id="expand" onclick="document.querySelector('#detail').hidden=false">展开说明</button><p id="detail" hidden>额外说明：松风海岸</p><footer></footer>`);

});
let releaseObservation=()=>{};let observationHeld=false;let holdObservation=!['streaming_voice','live_dialogue','state_environment','state_tools'].includes(caseName);const observationBarrier=new Promise<void>(r=>releaseObservation=r);
let child:ReturnType<typeof spawn>|undefined,cdp:ReturnType<typeof createCdp>|undefined,manager:ConversationManager|undefined,voice:VoiceService|undefined;
let panelReady=false;const bufferedPanel:any[]=[];let panelEval:((text:string)=>Promise<any>)|undefined;let panelQueue=Promise.resolve();let pendingInput=Promise.resolve();let uiSid='';let voiceId='',turn=0;const messages:any[]=[];const audio=new Map<string,Buffer[]>();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const check=(name:string,ok:boolean)=>{report.checks.push({name,ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw Error(name);};
async function until<T>(fn:()=>Promise<T|undefined>|T|undefined,ms=30000):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}throw Error('Timeout waiting for evaluator stage: '+report.stage);}
function wav(pcm:Buffer){const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(24000,24);h.writeUInt32LE(48000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);}
try{
 await writeFile(join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated voice conversation evaluator',version:'1.0',permissions:['debugger','tabs','tabGroups','storage','scripting'],host_permissions:['<all_urls>'],background:{service_worker:'background.js',type:'module'}}));
 const root=resolve('extension/src/background');
 await build({stdin:{contents:`
 import {openTab,listTabs,getActiveTab,switchTab,closeTab} from ${JSON.stringify(root+'/exec/tabs.ts')};
 import {navigate} from ${JSON.stringify(root+'/exec/navigate.ts')};
 import {snapshot} from ${JSON.stringify(root+'/exec/snapshot.ts')};
 import {screenshot} from ${JSON.stringify(root+'/exec/screenshot.ts')};
 import {click,hover,fill,typeText,pressKey,scroll,mark,clearMarks} from ${JSON.stringify(root+'/exec/input.ts')};
 import {evaluateJs} from ${JSON.stringify(root+'/exec/evaluate.ts')};
 import {readElement} from ${JSON.stringify(root+'/exec/read-element.ts')};
 import {executionKey} from ${JSON.stringify(root+'/state.ts')};
 import {VoiceObservation} from ${JSON.stringify(root+'/voice-observation.ts')};
 import {workerTabControl} from ${JSON.stringify(root+'/worker-tab-control.ts')};
 import {ControlGate} from ${JSON.stringify(resolve('shared/control.ts'))};
 const gate=new ControlGate();
 const observation=new VoiceObservation();
 const handlers={worker_tabs:(p,s)=>workerTabControl.manage(p,s),open_tab:openTab,navigate,snapshot,click,hover,fill,type_text:typeText,press_key:pressKey,scroll,mark,clear_marks:(_p,s)=>clearMarks(s),read_element:readElement,js:evaluateJs,list_tabs:(_p,s)=>listTabs(s),get_active_tab:(_p,s)=>getActiveTab(s),switch_tab:switchTab,close_tab:closeTab,screenshot:(_p,s)=>screenshot({},s),observe_page:p=>observation.capture(p.token,()=>true)};
 globalThis.probe={issue:()=>observation.issue(),gate,failMark:false,holdBeforeMark:false,recoverableMiss:false,execute:async(frame)=>{const handler=handlers[frame.name];if(!handler)throw Error('Unsupported evaluator bridge tool '+frame.name);if((frame.name==='open_tab'||frame.name==='navigate')&&!String(frame.params.url).startsWith('http://127.0.0.1:'))throw Error('Evaluator only permits its local fixture');if(frame.name==='mark'&&globalThis.probe.recoverableMiss){globalThis.probe.recoverableMiss=false;frame={...frame,params:{...frame.params,target:'.removed-before-action-${marker}'}};}if(frame.name==='mark'&&globalThis.probe.failMark)throw Error('受控注入：标注未落地');if(frame.name==='mark'&&globalThis.probe.holdBeforeMark)await gate.beginTakeover();return gate.run(frame.id||crypto.randomUUID(),frame.name,()=>handler(frame.params,executionKey(frame.conversationId||'default',frame.sessionId||'main')),frame.sessionId||'main');}};
 `,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',outfile:join(ext,'background.js')});
 for(const name of await readdir('extension/dist'))if(name!=='background.js'&&/\.(js|css)$/.test(name))await copyFile(join('extension/dist',name),join(ext,name));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 child=spawn('/Users/mahaoxuan/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',['--headless=new','--mute-audio','--enable-unsafe-extension-debugging',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
 report.stage='chrome startup';const port=await until(async()=>{try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return undefined;}});
 const info=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json()) as any;cdp=createCdp(info.webSocketDebuggerUrl);await cdp.ready();
 const sid=await until(async()=>{const r=await cdp!.send('Target.getTargets');for(const t of r.targetInfos.filter((t:any)=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'))){const sid=await cdp!.attachSession(t.targetId);const name=await cdp!.send('Runtime.evaluate',{expression:'chrome.runtime.getManifest().name',returnByValue:true},sid);if(name.result?.value==='Isolated voice conversation evaluator')return sid;}return undefined;});
 const evaluate=async(expression:string)=>{const r=await cdp!.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sid,45000);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value;};
 await until(async()=>await evaluate('!!globalThis.probe')||undefined);
 const uiTarget=await cdp.send('Target.createTarget',{url:'about:blank'});uiSid=await cdp.attachSession(uiTarget.targetId);
 panelEval=async(expression:string)=>{const r=await cdp!.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},uiSid);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result?.value;};
 await cdp.send('Runtime.enable',{},uiSid);await cdp.send('Runtime.addBinding',{name:'hostSend'},uiSid);await cdp.send('Page.enable',{},uiSid);await cdp.send('Emulation.setDeviceMetricsOverride',{width:400,height:1000,deviceScaleFactor:1,mobile:false},uiSid);
 const postPanel=(m:any)=>{if(!panelReady){bufferedPanel.push(m);return;}panelQueue=panelQueue.then(()=>panelEval!(`uiEmit(${JSON.stringify({kind:'server',msg:m})})`)).catch(error=>{report.transportError=String(error);});};
 cdp.onEvent('Runtime.bindingCalled',(event:any)=>{if(event.sessionId!==uiSid||event.params.name!=='hostSend')return;const envelope=JSON.parse(event.params.payload);if(envelope.kind!=='client')return;pendingInput=pendingInput.then(async()=>{const m=envelope.msg;if(m.type==='voice'&&['commit','playback_done'].includes(m.command.kind))(report.clientTiming??=[]).push({voiceId:m.voiceId,command:m.command.kind,turn:m.command.turn,responseId:m.command.responseId,at:Date.now()});if(m.type==='voice'){voiceId=m.voiceId;if(m.command.kind==='interrupt')turn=m.command.turn;if(m.command.kind==='commit'){const observation=await evaluate('probe.issue()');if(observation){const tab=await evaluate(`chrome.tabs.get(${observation.tabId})`);m.command={...m.command,input:{...m.command.input,context:{tabId:tab.id,url:tab.url,title:tab.title},observation}};}}await voice!.handle(m.conversationId??'default',m);}else await manager!.handleMessage(m);}).catch(error=>{report.transportError=String(error);});});
 const store=new ConversationStore(join(out,'conversations'));
 manager=new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,'minimax-cn/MiniMax-M3',{sessionManager:store.sessionManager(id),mode:summary?.mode,customTools:caseName==='live_dialogue'?[defineTool({name:'wait_for_fixture',label:'等待测试资料',description:'Wait until the local test fixture is ready, then read the current page with browser tools.',parameters:Type.Object({}),execute:async()=>{observationHeld=true;report.observationBarrierAt=Date.now();await observationBarrier;return {content:[{type:'text',text:'测试资料已就绪，请读取当前页面。'}],details:{ready:true}};}})]:caseName.startsWith('extra_tool')?[defineTool({name:'fixture_meter',label:'测试仪表',description:'Read the current reading of the test instrument. The number is available only from this tool, not the page or prior conversation.',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:String(meterValue)}],details:{reading:meterValue}})})]:[]}),message=>{
  messages.push(message);voice?.observe(message);postPanel(message);if(message.type==='agent_event'&&['tool_end','agent_end','user_delivery','user_delivery_stream'].includes(message.event.kind))(report.progressEvents??=[]).push({event:message.event,at:Date.now(),snapshot:manager?.getTaskProgress('default')});
  if(message.type==='tool_call'){
   const record:any={name:message.name,params:message.params,conversationId:message.conversationId,at:Date.now()};report.tools.push(record);
   void evaluate(`probe.execute(${JSON.stringify(message)})`).then(async data=>{record.ok=true;record.result=JSON.stringify(data,(key,value)=>key==='imageBase64'?'[image omitted]':value)?.slice(0,16000);if(message.name==='mark'){record.annotationBoxes=await marks();record.pageState=await pageState();}if(holdObservation&&['snapshot','read_element'].includes(message.name)){holdObservation=false;observationHeld=true;report.observationBarrierAt=Date.now();await observationBarrier;}return manager!.handleMessage({type:'tool_result',conversationId:message.conversationId,id:message.id,ok:true,data});},async error=>{record.ok=false;record.error=String(error);if(caseName==='takeover'&&message.name==='mark'){await manager!.handleMessage({type:'takeover',conversationId:message.conversationId,requestId:'injected-takeover',members:[{sessionId:'main',role:'lead',tabId:fixtureTab.id,activity:'running'}]});}return manager!.handleMessage({type:'tool_result',conversationId:message.conversationId,id:message.id,ok:false,error:String(error)});});
  }
 },store);
 voice=new VoiceService(id=>manager!.getTaskProgress(id),message=>{
  messages.push(message);postPanel(message);if(message.type!=='voice')return;
  const e=message.event;if(e.kind==='audio'){if(!audio.has(e.responseId))(report.audioTiming??=[]).push({voiceId:message.voiceId,turn:e.turn,responseId:e.responseId,firstAudioAt:Date.now()});const chunks=audio.get(e.responseId)??[];chunks.push(Buffer.from(e.data,'base64'));audio.set(e.responseId,chunks);}else report.voice.push({voiceId:message.voiceId,event:e,at:Date.now()});
  // Playback acknowledgement is emitted by the production browser VoicePlayer.
 },undefined,undefined,undefined,(id,text,startedAt,current,context)=>manager!.routeVoiceInput(id,text,startedAt,current,context),(event,fields)=>{report.stages.push({event,...fields,at:Date.now()});},()=>manager!.voiceTargets(),(id,deliveryId,status)=>manager!.markDeliveryPlayback(id,deliveryId,status),(id,text,runId)=>manager!.recordSpokenAck(id,text,runId));
 await manager.ensureDefault();check('actual task model initialized',manager.get('default')!.runtime.session.available);
 await cdp.send('Page.navigate',{url:url+'sidepanel.html'},uiSid);await until(async()=>await panelEval!('globalThis.uiListeners?.length>0')||undefined);
 await panelEval!(`uiEmit({kind:'conversations',selectedConversationId:'default',conversations:[{id:'default',title:'受控收件箱',createdAt:1,updatedAt:1,state:'idle',mode:'act'}]});uiEmit({kind:'conn',state:'connected'});uiEmit({kind:'server',msg:{type:'hello_ok',version:1,model:'minimax-cn/MiniMax-M3',models:[{id:'minimax-cn/MiniMax-M3',provider:'minimax-cn',modelId:'MiniMax-M3',name:'MiniMax-M3'}]}});`);
 panelReady=true;for(const m of bufferedPanel.splice(0))postPanel(m);await panelQueue;
 const click=async(selector:string)=>{const point=await panelEval!(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp!.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point},uiSid);await cdp!.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point},uiSid);};
 const listen=async()=>{const from=messages.length;await click('.voice-start');await until(()=>messages.slice(from).some(m=>m.type==='voice'&&m.event.kind==='state'&&m.event.state==='ready')||undefined,25000);await panelQueue;};
 const speak=async(text:string,_input?:VoiceInputContext)=>{
  const begin=messages.length;report.stage=`speech ${text}`;console.log(report.stage);const base=join(out,`input-${report.voice.length}`);
  execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',base+'.aiff',text]);execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',base+'.aiff','-ar','24000','-ac','1','-f','s16le',base+'.pcm']);
  const pcm=Buffer.concat([await readFile(base+'.pcm'),Buffer.alloc(48000)]);await evaluate(`chrome.tabs.update(${fixtureTab.id},{active:true})`);await panelEval!(`injectSpeech(${JSON.stringify(pcm.toString('base64'))})`);
  // S1 evaluates speech input -> real browser action. The separately scheduled output-latency fix must not be simulated here.
  await until(()=>{if(report.transportError)throw Error(report.transportError);const events=messages.slice(begin);return events.find(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery?.kind!=='ack');},120000);
  await until(()=>manager!.getTaskProgress('default')?.state==='idle'||undefined,120000);await panelQueue;
  return {deliveredText:messages.slice(begin).filter(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery?.kind!=='ack').map(m=>m.event.delivery.text),voiceTexts:messages.slice(begin).filter(m=>m.type==='voice'&&m.event.kind==='text'&&m.event.role==='assistant').map(m=>m.event.text),playbackFinished:messages.slice(begin).some(m=>m.type==='voice'&&m.event.kind==='response_end')};

 };

 const fixtureTab=await evaluate(`chrome.tabs.create({url:${JSON.stringify(url)},active:true})`);await sleep(350);
 await panelEval!(`chrome.tabs.query=async()=>[${JSON.stringify(fixtureTab)}]`);
 const pageState=async()=>evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>{const rect=id=>{const r=document.querySelector('#'+id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {target:rect('target'),other:rect('other'),viewportHeight:innerHeight,viewportWidth:innerWidth,scrollY,hasHost:!!document.querySelector('[data-sideagent-overlay="marks"]'),detailVisible:document.querySelector('#detail')?!document.querySelector('#detail').hidden:false};}}).then(r=>r[0].result)`);
 const marks=async()=>{
  await evaluate(`chrome.debugger.attach({tabId:${fixtureTab.id}},'1.3').catch(()=>{})`);
  const tree=await evaluate(`chrome.debugger.sendCommand({tabId:${fixtureTab.id}},'DOM.getDocument',{depth:-1,pierce:true})`);const nodes:any[]=[];
  const walk=(n:any)=>{const attrs=n.attributes??[],index=attrs.indexOf('class');if(index>=0&&/(^| )mark( |$)/.test(attrs[index+1]))nodes.push(n);for(const child of [...n.children??[],...n.shadowRoots??[]])walk(child);};walk(tree.root);
  const boxes:any[]=[];for(const node of nodes){const r=await evaluate(`chrome.debugger.sendCommand({tabId:${fixtureTab.id}},'DOM.getBoxModel',{backendNodeId:${node.backendNodeId}}).catch(()=>null)`);if(r?.model){const q=r.model.border;boxes.push({x:Math.min(q[0],q[2],q[4],q[6]),y:Math.min(q[1],q[3],q[5],q[7]),width:Math.max(q[0],q[2],q[4],q[6])-Math.min(q[0],q[2],q[4],q[6]),height:Math.max(q[1],q[3],q[5],q[7])-Math.min(q[1],q[3],q[5],q[7])});}}return boxes;
 };
 const sendText=async(text:string)=>{const from=messages.length;await panelEval!(`(()=>{document.querySelector('#input').value=${JSON.stringify(text)};document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}));})()`);await panelEval!(`document.querySelector('#input').focus()`);await cdp!.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},uiSid);await cdp!.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},uiSid);await evaluate(`chrome.tabs.update(${fixtureTab.id},{active:true})`);return from;};
 const audit=async(action='read')=>evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},world:'ISOLATED',func:(action)=>{if(action==='install'){const records=[];const capture=items=>records.push(...items.map(m=>({type:m.type,node:m.target.nodeName,attribute:m.attributeName,added:[...m.addedNodes].map(n=>n.nodeName),removed:[...m.removedNodes].map(n=>n.nodeName)})));const observer=new MutationObserver(capture);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});window.__s2Audit={read:()=>{capture(observer.takeRecords());return [...records];}};}return window.__s2Audit.read();},args:[${JSON.stringify(action)}]}).then(r=>r[0].result)`);
 await audit('install');
 const currentContext={tabId:fixtureTab.id,url,title:'模型说明测试页'};
 const pendingWrites=()=>report.tools.filter((t:any)=>['mark','fill','click','type_text','press_key','navigate','open_tab','clear_marks'].includes(t.name)&&t.ok);
 const settle=async(from:number)=>{await until(()=>messages.slice(from).some(m=>m.type==='agent_event'&&m.event.kind==='agent_end')||undefined,120000);await until(()=>manager!.getTaskProgress('default')?.state==='idle'||undefined,120000);await panelQueue;};
 const shot=async(name:string)=>{await evaluate(`chrome.tabs.update(${fixtureTab.id},{active:true})`);const data=await evaluate(`chrome.tabs.captureVisibleTab(${fixtureTab.windowId},{format:'png'})`);await writeFile(join(out,name+'.png'),Buffer.from(data.split(',')[1],'base64'));};
 const noMark=async()=>check('no old target annotation before continuation',(await marks()).length===0);
 const onlyOther=async()=>{const boxes=await marks(),state=await pageState();report.boxes=boxes;report.pageState=state;check('annotation is visible',boxes.length>0);check('every successful annotation, including transient ones, belongs to Y',report.tools.filter((t:any)=>t.name==='mark'&&t.ok).every((t:any)=>t.annotationBoxes?.length&&t.annotationBoxes.every((b:any)=>b.x>=t.pageState.other.x-16&&b.y>=t.pageState.other.y-16&&b.x+b.width<=t.pageState.other.x+t.pageState.other.width+16&&b.y+b.height<=t.pageState.other.y+t.pageState.other.height+16)));check('all annotations belong to corrected Y, never X',boxes.every(b=>b.x>=state.other.x-16&&b.y>=state.other.y-16&&b.x+b.width<=state.other.x+state.other.width+16&&b.y+b.height<=state.other.y+state.other.height+16));};
 await shot('before');
 if(caseName==='state_tools'){
  const execute=(name:string,params:any)=>evaluate(`probe.execute(${JSON.stringify({name,params,conversationId:'default'})})`);
  await execute('switch_tab',{tabId:fixtureTab.id});
  const snap=await execute('snapshot',{});
  const ref=snap.text.split('\n').find(l=>l.includes('Video "周末海边视频"'))?.match(/ref=(\d+)/)?.[1];
  check('native media has an observed AX ref',!!ref);
  const state=await execute('read_element',{target:'@'+ref,properties:['paused','currentTime']});
  check('AX state reading returns actual media values',state.properties?.paused===false&&state.properties.currentTime>=0);
  let failed=false;try{await execute('read_element',{target:'@'+ref,expect:{property:'paused',equals:true}});}catch(error){failed=String(error).includes('条件未满足');}
  check('unmet state cannot produce verified success',failed);
  await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>{setTimeout(()=>document.querySelector('#delayed').checked=true,250);}})`);
  const checked=await execute('read_element',{target:'#delayed',expect:{property:'checked',equals:true},timeoutMs:1500});
  check('native condition becomes true within one bounded call',checked.check?.matched===true&&checked.properties.checked===true&&checked.check.elapsedMs>0);
  failed=false;try{await execute('read_element',{target:'article',properties:['visible']});}catch(error){failed=String(error).includes('匹配 3');}
  check('ambiguous targets remain rejected',failed);
  await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>{document.querySelector('#delayed').checked=false;setTimeout(()=>location.href='/?checked=1',75);}})`);
  failed=false;try{await execute('read_element',{target:'#delayed',expect:{property:'checked',equals:true},timeoutMs:1500});}catch(error){failed=String(error).includes('文档已变化');}
  check('navigation while waiting invalidates result even when replacement state matches',failed);
  report.ok=true;
 }else if(caseName==='state_environment'){
  report.stage='media fixture readiness';
  const media=()=>evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},world:'MAIN',func:()=>{const v=document.querySelector('video');return {paused:v.paused,time:v.currentTime,events:globalThis.pauseEvents};}}).then(r=>r[0].result)`);
  await until(async()=>{const s=await media();return !s.paused&&s.time>0?s:undefined;},10000);
  report.requestAt=Date.now();
  const from=await sendText('暂停正在播放的视频，确认它已经停住；然后读取前三条评论，逐条告诉我。');
  report.stage='autonomous pause and read comments';
  await until(()=>messages.slice(from).some(m=>m.type==='agent_event'&&m.event.kind==='agent_end')||undefined,180000);
  await panelQueue;
  report.finishedAt=Date.now();report.media=await media();
  const text=messages.slice(from).filter(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery.kind!=='ack').map(m=>m.event.delivery.text).join('\n');
  report.answer=text;
  report.environmentMetrics={modelTurns:messages.slice(from).filter(m=>m.type==='agent_event'&&m.event.kind==='turn_start').length,jsCalls:report.tools.filter(t=>t.name==='js').length,readCalls:report.tools.filter(t=>t.name==='read_element').length,pauseMs:report.media.events[0]-report.requestAt,totalMs:report.finishedAt-report.requestAt};
  check('real media is paused',report.media.paused&&report.media.events.length===1);
  check('all three actual comment values are in official answer',[targetCode,otherCode,bodyMarker].every(v=>text.includes(v)));
  report.ok=true;
 }else if(caseName==='live_dialogue'){
  await runLiveDialogue({out,report,messages,manager,panelEval:panelEval!,listen,until,check,release:releaseObservation,isHeld:()=>observationHeld,targetCode,otherCode});
  report.ok=true;
 }else if(caseName==='streaming_voice'){
  report.stage='streaming voice input readiness';
  await listen();
  await panelEval!(`globalThis.audioStops=[];const originalStop=AudioBufferSourceNode.prototype.stop;AudioBufferSourceNode.prototype.stop=function(...a){audioStops.push(performance.now());return originalStop.apply(this,a);};`);
  const from=await sendText('请先读取当前页面，然后用约三百字向我解释临时模型与标准模型的区别、各自适用的情况以及使用时需要注意什么。请形成一段完整自然的回答，不要只列一句结论。不需要操作网页。');
  report.stage='first audio from actual task model';
  await until(()=>messages.slice(from).some(m=>m.type==='voice'&&m.event.kind==='audio')||undefined,60000);
  report.stage='streaming TTS completion';
  await until(()=>messages.slice(from).some(m=>m.type==='voice'&&m.event.kind==='response_end')||undefined,60000);
  await panelQueue;
  const streams=report.progressEvents.filter((e:any)=>e.event.kind==='user_delivery_stream'&&e.event.stream.phase==='streaming');
  const done=report.progressEvents.find((e:any)=>e.event.kind==='user_delivery'&&e.event.delivery.kind==='finding');
  const first=report.audioTiming?.[0];
  check('real model publishes incremental official answer',streams.length>1&&!!done);
  const id=done.event.delivery.id;
  check('official stream and final answer share one identity',streams.every((e:any)=>e.event.stream.id===id));
  check('real TTS receives incremental official answer',report.stages.some((e:any)=>e.event==='tts_first_audio'&&e.deliveryId===id));
  check('legacy whole-answer speech validation is not used',!report.stages.some((e:any)=>e.event==='receipt_speech_rejected'||e.event==='receipt_speech_verified'));
  const seconds=[...audio.values()].flat().reduce((n,b)=>n+b.length,0)/48000;
  report.streamTiming={firstTextAt:streams[0].at,finalTextAt:done.at,firstAudioAt:first?.firstAudioAt,audioSeconds:seconds};
  report.streamTiming.audioBeforeFinalText=first?.firstAudioAt<done.at;
  check('answer longer than twenty seconds is returned',seconds>20);
  check('one completed official answer bubble',await panelEval!(`document.querySelectorAll('[data-delivery-id="${id}"]').length===1`));
  const stops=await panelEval!('audioStops.length');
  await panelEval!(`injectSpeech(${JSON.stringify(Buffer.from(Int16Array.from({length:24000},(_,i)=>Math.round(Math.sin(i*2*Math.PI*220/24000)*5000)).buffer).toString('base64'))})`);
  await until(async()=>await panelEval!('audioStops.length')>stops||undefined,3000);
  check('production voice detector stops queued audio on interruption',await panelEval!('audioStops.length')>stops);
  check('ordinary interruption did not pause a webpage task',!messages.slice(from).some(m=>m.type==='task_control'));
  report.ok=true;
 }else if(caseName==='mechanism'){
  await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>{document.body.innerHTML='<main><section><h2>相同标题</h2></section><section><h2>相同标题</h2></section><p>独立正文锚点</p><img alt="图像锚点" width="190" height="100" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTAiIGhlaWdodD0iMTAwIj48cmVjdCB3aWR0aD0iMTkwIiBoZWlnaHQ9IjEwMCIgZmlsbD0ib3JhbmdlIi8+PC9zdmc+"><div id="nested"></div></main>';document.querySelector('#nested').attachShadow({mode:'open'}).innerHTML='<p>嵌套文字锚点</p>';}})`);
  check('image fixture is actually loaded',await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>document.querySelector('img').decode().then(()=>true)}).then(r=>r[0].result)`));
  const execute=(name:string,params:any)=>evaluate(`probe.execute(${JSON.stringify({name,params,conversationId:'default'})})`);
  await execute('switch_tab',{tabId:fixtureTab.id});
  const snap=await execute('snapshot',{});report.directSnapshot=snap.text;
  const headings=[...snap.text.matchAll(/\[ref=(\d+)\] heading "相同标题"/g)].map(m=>m[1]);
  check('same-tag same-name headings retain distinct actionable identities',headings.length===2&&headings[0]!==headings[1]);
  const refs=[headings[1],...['text: 独立正文锚点','image "图像锚点"','text: 嵌套文字锚点'].map(label=>snap.text.split('\n').find(l=>l.includes(label))?.match(/\[ref=(\d+)\]/)?.[1])];
  check('heading, text, image and shadow text have snapshot refs',refs.every(Boolean));
  for(let i=0;i<refs.length;i++){
   const ref='@'+refs[i];
   const read=await execute('read_element',{target:ref});
   check('observed ref '+i+' resolves to expected content',i===2?read.tagName==='img':read.textContent.includes(['相同标题','独立正文锚点','','嵌套文字锚点'][i]));
   await execute('mark',{target:ref});
   await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>{window.scrollBy(0,25);window.dispatchEvent(new Event('resize'));}})`);
   await sleep(100);
   const boxes=await marks();
   const expected=await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:i=>{let node=[document.querySelectorAll('h2')[1],document.querySelector('p').firstChild,document.querySelector('img'),document.querySelector('#nested').shadowRoot.querySelector('p').firstChild][i];let r;if(node.nodeType===3){const range=document.createRange();range.selectNodeContents(node);r=range.getBoundingClientRect();}else r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};},args:[${i}]}).then(r=>r[0].result)`);
   (report.directGeometry??=[]).push({i,boxes,expected});
   check('observed ref '+i+' produces precise visible annotation',boxes.length===1&&boxes.every(b=>Math.abs(b.x-expected.x)<16&&Math.abs(b.y-expected.y)<16&&Math.abs(b.width-expected.width)<32&&Math.abs(b.height-expected.height)<32));
   await sleep(550);await shot('content-'+i);await execute('clear_marks',{});
  }
  await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>document.querySelectorAll('h2')[1].remove()})`);
  let staleRejected=false;try{await execute('mark',{target:'@'+headings[1]});}catch{staleRejected=true;}
  check('removed observed node cannot silently retarget another heading',staleRejected&&(await marks()).length===0);
  report.ok=true;
 }else{
 if(caseName==='correction_voice')await listen();
 if(caseName==='recovery')await evaluate('probe.recoverableMiss=true');
 const start=await sendText(caseName==='recovery'?`请圈出当前页面的日程调整${marker}${contentKind==='image'?'图片':'内容'}。`:layout==='live'?'帮我找到临时模型，然后圈出来。':'请先用页面快照找到临时模型ID，然后把它圈出来。只处理当前页。');
 report.stage='first observation held before returning to model';await until(()=>observationHeld||undefined,120000);
 const origin=manager.getTaskProgress('default')!;report.originalRun=origin.runId;report.afterObservation=origin;await noMark();
 if(caseName==='recovery'){
  releaseObservation();await settle(start);await onlyOther();
  check('real missing-target failure was exercised',report.tools.some((t:any)=>t.name==='mark'&&!t.ok&&/removed-before-action/.test(t.error)));
  check('model completed recovery without asking user to reauthorize',manager.getTaskProgress('default')?.resultState==='satisfied');
 }else if(caseName==='correction'||caseName==='correction_voice'){
  report.stage='correction accepted';const correctionFrom=messages.length;const speech=caseName==='correction_voice'?speak('对象改成标准模型ID，其他要求保留。'):null;if(!speech)await sendText(layout==='live'?'改成标准模型，其他要求不变。':'对象改成标准模型ID，其他要求保留。');
  await until(()=>messages.slice(correctionFrom).some(m=>m.type==='agent_event'&&m.event.kind==='notice'&&m.event.receipt?.action==='steer'&&['accepted','applied'].includes(m.event.receipt.status))||undefined,20000);
  report.correctionAcceptedAt=Date.now();check('correction preserves original run',manager.getTaskProgress('default')?.runId===origin.runId);releaseObservation();if(speech)report.speechInputResult=await speech;await settle(start);await onlyOther();
 }else if(caseName==='pause'){
  await evaluate('probe.gate.takeover()');await manager.handleMessage({type:'takeover',conversationId:'default',requestId:'pause',members:[{sessionId:'main',role:'lead',tabId:fixtureTab.id,activity:'running'}]});releaseObservation();
  await until(()=>manager!.getTaskProgress('default')?.state==='paused'||undefined);await noMark();
  const pausedCount=pendingWrites().length,pausedDOM=(await audit()).length;await sendText('对象改成标准模型ID，其他要求保留。');await pendingInput;
  await sleep(1200);check('paused supplement does not write page',pendingWrites().length===pausedCount&&(await marks()).length===0&&(await audit()).length===pausedDOM);check('paused supplement retains run',manager.getTaskProgress('default')?.runId===origin.runId);
  let blocked=false;try{await evaluate(`probe.execute({name:'mark',params:{target:'#target'},conversationId:'default'})`);}catch{blocked=true;}check('production control gate rejects paused write',blocked);await noMark();
  const fresh=await evaluate(`probe.execute({name:'snapshot',params:{tabId:${fixtureTab.id}},conversationId:'default'})`);const resumeFrom=messages.length;await evaluate('probe.gate.handback()');await manager.handleMessage({type:'handback',conversationId:'default',requestId:'resume',context:currentContext,snapshot:fresh.text});await settle(resumeFrom);check('resume preserves original task identity',manager.getTaskProgress('default')?.runId===origin.runId);await onlyOther();
 }else if(caseName==='cancel'){
  await manager.handleMessage({type:'abort',conversationId:'default'});releaseObservation();await manager.get('default')!.runtime.session.waitForStop();const before=pendingWrites().length;
  const result=await manager.routeVoiceInput('default','我只是问你有没有标注能力，不要操作页面。',null,()=>true,{requestId:'capability-after-cancel',voiceId:'test-voice',turn:1,runId:origin.runId!});report.capabilityReply=result;
  await sleep(1200);check('general capability question does not replay cancelled action',pendingWrites().length===before);await noMark();check('cancelled run remains cancelled',manager.getTaskProgress('default')?.state==='aborted');
 }else if(caseName==='navigation'){
  await evaluate(`chrome.tabs.update(${fixtureTab.id},{url:${JSON.stringify(url+'changed')}})`);await sleep(700);
  // Replace X in the new document; stale refs must never mark the new unrelated node.
  await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>{document.querySelector('#target').remove();document.querySelector('#other').insertAdjacentHTML('beforeend','<p>新文档，临时模型已经移除。</p>');}})`);
  report.navigationAt=Date.now();releaseObservation();await settle(start);await noMark();check('no successful mark against stale document',!report.tools.some((t:any)=>t.name==='mark'&&t.ok));
 }else throw Error('Unknown S2 case '+caseName);
 await shot('after');const panelShot=await cdp.send('Page.captureScreenshot',{format:'png'},uiSid);await writeFile(join(out,'panel-after.png'),Buffer.from(panelShot.data,'base64'));report.finalSnapshot=manager.getTaskProgress('default');
 if(['correction','correction_voice','pause'].includes(caseName)){
  check('the real model registers separate observation and operation results',messages.some(m=>m.type==='agent_event'&&m.event.kind==='tool_start'&&m.event.name==='record_task_results')&&report.finalSnapshot.results?.some((r:any)=>r.tool==='mark'));
  check('observation leaves the registered annotation outstanding',report.progressEvents?.some((p:any)=>p.snapshot?.results?.some((r:any)=>r.tool==='snapshot'&&r.status==='satisfied')&&p.snapshot?.results?.some((r:any)=>r.tool==='mark'&&r.status!=='satisfied')));
  check('real matching receipts satisfy the registered remaining task',report.finalSnapshot.resultState==='satisfied');
  const beforeReplay=report.tools.length;const prior=await panelEval!(`uiMessages.find(m=>m.kind==='client'&&m.msg.type==='task_action'&&m.msg.request.action==='start')?.msg`);if(prior)await manager.handleMessage(prior);
  const delivery=report.finalSnapshot.conversationContext?.latestDelivery;if(delivery){manager.markDeliveryPlayback('default',delivery.id,'played');manager.markDeliveryPlayback('default',delivery.id,'played');}
  await sleep(300);check('duplicate request and playback do not execute another browser action',report.tools.length===beforeReplay);
  const done=report.finalSnapshot.results.find((r:any)=>r.tool==='mark'&&r.status==='satisfied');let duplicateBlocked=false;try{await (manager.get('default')!.runtime.session as any).session.getToolDefinition('mark').execute('duplicate-probe',{target:done.target});}catch{duplicateBlocked=true;}
  check('completed write is blocked before browser RPC',duplicateBlocked&&report.tools.length===beforeReplay);
 }
 report.deliveries=messages.slice(start).filter(m=>m.type==='agent_event'&&m.event.kind==='user_delivery').map(m=>m.event.delivery);report.ok=true;
 }

}catch(e){report.error=String(e);process.exitCode=1;console.error(report.error);}
finally{
 releaseObservation();
 report.deliveryMetrics={composeCalls:deliveryMetrics.composeCalls,composeMs:[...deliveryMetrics.composeMs]};
 if(panelEval)await panelEval(`document.querySelector('.voice-start')?.getAttribute('aria-expanded')==='true'&&document.querySelector('.voice-start').click()`).catch(()=>{});await pendingInput;voice?.close();manager?.dispose();await panelQueue.catch(()=>{});
 for(const [id,chunks] of audio)await writeFile(join(out,`output-${id.replace(/[^a-zA-Z0-9_-]/g,'')}.wav`),wav(Buffer.concat(chunks)));
 await writeFile(join(out,'task-events.json'),JSON.stringify(messages.filter(m=>m.type!=='voice'||m.event.kind!=='audio'),null,2));
 if(cdp)await cdp.close();if(child){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await Promise.race([exited,sleep(3000)]);report.browserExited=child.exitCode!==null||child.signalCode!==null;if(!report.browserExited){child.kill('SIGKILL');await exited;report.browserExited=true;}}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,error:report.error,checks:report.checks}));await new Promise<void>(r=>process.stdout.write('',()=>r()));process.exit(report.ok?0:1);
}
