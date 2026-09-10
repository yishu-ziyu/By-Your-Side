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


if(process.argv.includes('--suite')&&!process.argv.some(a=>a.startsWith('--case='))){
 const suiteOut=await mkdtemp(join(tmpdir(),'ego-harness-s1-suite-'));
 const core=['mark_voice','mark_text','correction','explicit_correction','readonly','polite'];
 const cases=[...core,...core,'capability','missing','disabled','mark_failure','takeover','extra_tool_voice','extra_tool_text'];
 const results:any[]=[];let next=0;
 const worker=async()=>{while(next<cases.length){const index=next++,name=cases[index]!;const task=spawn(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/acceptance/harness-capability-run.mts'),'--case='+name],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';task.stdout!.on('data',d=>stdout+=d);task.stderr!.on('data',d=>stderr+=d);const code=await new Promise<number|null>(r=>task.on('exit',r));await writeFile(join(suiteOut,`${index}-${name}.log`),stdout+'\n'+stderr);let result:any;try{result=JSON.parse(stdout.trim().split('\n').at(-1)!);}catch{result={ok:false,error:'case did not produce a complete report'};}results.push({index,name,exitCode:code,...result});await writeFile(join(suiteOut,'result.json'),JSON.stringify({ok:results.length===cases.length&&results.every(r=>r.ok),planned:cases.length,results},null,2));console.log(JSON.stringify({completed:results.length,total:cases.length,name,...result}));}};
 await Promise.all([worker(),worker()]);console.log(JSON.stringify({suiteOut,ok:results.every(r=>r.ok),passed:results.filter(r=>r.ok).length,total:cases.length}));process.exit(results.every(r=>r.ok)?0:1);
}
const caseName=process.argv.find(a=>a.startsWith('--case='))?.slice(7)??'mark_voice';
const out=await mkdtemp(join(tmpdir(),'ego-harness-capability-'));
const targetCode='cedar-flash-'+randomInt(1000,9999),otherCode='river-flash-'+randomInt(1000,9999),meterValue=randomInt(10000,99999);
const ext=join(out,'extension'),profile=join(out,'profile');await mkdir(ext);
const marker=randomUUID().slice(0,6);
const organizations=['青鹭','松风','鹤鸣','竹海','白榆','云杉','橙湾','星浦','海棠','岚川'];
const first=randomInt(organizations.length),second=(first+1+randomInt(organizations.length-1))%organizations.length;
const activityOrg=organizations[first]+'工作坊',interviewOrg=organizations[second]+'研究';
const eventName=`${activityOrg}活动邀请`,interviewName=`${interviewOrg}访谈邀请`;
const bodyMarker='纸鹤橙桥'+Math.floor(1000+Math.random()*9000);
const report:any={ok:false,evidence:voiceEvidence(),scope:'production sidepanel DOM/client/worklet/player + task runtime + real models; isolated tools via CDP; synthetic microphone stream, muted browser audio playback; test transport supplies production VoiceObservation grant at commit; not human listening',caseName,targetCode,otherCode,marker,activityOrg,interviewOrg,eventName,interviewName,bodyMarker,checks:[],voice:[],tools:[],stages:[]};
const uiMock=`globalThis.uiListeners=[];globalThis.uiMessages=[];globalThis.uiMicCalls=0;globalThis.uiEmit=e=>uiListeners.forEach(fn=>fn(e));
const storage={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome={runtime:{getURL:p=>new URL(p,location.href).href,connect:()=>({onMessage:{addListener:f=>uiListeners.push(f)},onDisconnect:{addListener:()=>{}},disconnect:()=>{},postMessage:m=>{uiMessages.push(m);globalThis.hostSend(JSON.stringify(m));}})},storage:{local:storage,session:storage},tabs:{query:async()=>[{id:1,title:'受控收件箱',url:location.origin+'/'}],onActivated:{addListener:()=>{}},onUpdated:{addListener:()=>{}},create:async()=>({id:2})}};
navigator.permissions.query=async()=>({state:'granted'});navigator.mediaDevices.getUserMedia=async()=>{uiMicCalls++;const context=new AudioContext({sampleRate:24000}),dest=context.createMediaStreamDestination();await context.resume();globalThis.capture={context,dest};return dest.stream;};
globalThis.injectSpeech=data=>{const {context,dest}=capture,bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),buffer=context.createBuffer(1,bytes.length/2,24000),pcm=buffer.getChannelData(0);for(let i=0;i<pcm.length;i++)pcm[i]=view.getInt16(i*2,true)/32768;const source=context.createBufferSource();source.buffer=buffer;source.connect(dest);source.start();};`;
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url!,'http://local').pathname;
 if(pathname==='/sidepanel.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end((await readFile('extension/sidepanel.html','utf8')).replace('<script type="module"','<script src="mock.js"></script><script type="module"'));return;}
 if(pathname==='/mock.js'){res.setHeader('Content-Type','text/javascript');res.end(uiMock);return;}
 if(/\.(js|css|woff2|svg|png)$/.test(pathname)){try{const p=resolve('extension/dist','.'+pathname);if(!p.startsWith(resolve('extension/dist')+'/'))throw Error('path');res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'} as any)[extname(p)]??'application/octet-stream');res.end(await readFile(p));}catch{res.statusCode=404;res.end();}return;}

 res.setHeader('Content-Type','text/html; charset=utf-8');
 const order=first%2?[['target',targetCode],['other',otherCode]]:[['other',otherCode],['target',targetCode]];
 res.end(`<!doctype html><meta charset="utf-8"><title>模型说明测试页</title><style>body{font:22px sans-serif;line-height:1.6;padding:36px;max-width:820px}section{padding:20px;border:1px solid #ccc;margin:24px 0}code{font-size:24px}footer{height:1700px}</style><h1>接口说明</h1>${order.map(([id,code])=>`<section id="${id}"><h2>${id==='target'?'临时模型':'标准模型'}</h2><code>${code}</code><p>${id==='target'?'临时模型的有效期为明天。':'标准模型长期有效。'}</p></section>`).join('')}<button id="expand" onclick="document.querySelector('#detail').hidden=false">展开说明</button><p id="detail" hidden>额外说明：松风海岸</p><footer></footer>`);

});
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
 globalThis.probe={issue:()=>observation.issue(),gate,failMark:false,holdBeforeMark:false,execute:async(frame)=>{const handler=handlers[frame.name];if(!handler)throw Error('Unsupported evaluator bridge tool '+frame.name);if((frame.name==='open_tab'||frame.name==='navigate')&&!String(frame.params.url).startsWith('http://127.0.0.1:'))throw Error('Evaluator only permits its local fixture');if(frame.name==='mark'&&globalThis.probe.failMark)throw Error('受控注入：标注未落地');if(frame.name==='mark'&&globalThis.probe.holdBeforeMark)await gate.beginTakeover();return gate.run(frame.id||crypto.randomUUID(),frame.name,()=>handler(frame.params,executionKey(frame.conversationId||'default',frame.sessionId||'main')),frame.sessionId||'main');}};
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
 manager=new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,'minimax-cn/MiniMax-M3',{sessionManager:store.sessionManager(id),mode:summary?.mode,customTools:caseName.startsWith('extra_tool')?[defineTool({name:'fixture_meter',label:'测试仪表',description:'Read the current reading of the test instrument. The number is available only from this tool, not the page or prior conversation.',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:String(meterValue)}],details:{reading:meterValue}})})]:[]}),message=>{
  messages.push(message);voice?.observe(message);postPanel(message);
  if(message.type==='tool_call'){
   const record:any={name:message.name,params:message.params,conversationId:message.conversationId,at:Date.now()};report.tools.push(record);
   void evaluate(`probe.execute(${JSON.stringify(message)})`).then(data=>{record.ok=true;record.result=JSON.stringify(data,(key,value)=>key==='imageBase64'?'[image omitted]':value)?.slice(0,16000);return manager!.handleMessage({type:'tool_result',conversationId:message.conversationId,id:message.id,ok:true,data});},async error=>{record.ok=false;record.error=String(error);if(caseName==='takeover'&&message.name==='mark'){await manager!.handleMessage({type:'takeover',conversationId:message.conversationId,requestId:'injected-takeover',members:[{sessionId:'main',role:'lead',tabId:fixtureTab.id,activity:'running'}]});}return manager!.handleMessage({type:'tool_result',conversationId:message.conversationId,id:message.id,ok:false,error:String(error)});});
  }
 },store);
 voice=new VoiceService(id=>manager!.getTaskProgress(id),message=>{
  messages.push(message);postPanel(message);if(message.type!=='voice')return;
  const e=message.event;if(e.kind==='audio'){if(!audio.has(e.responseId))(report.audioTiming??=[]).push({voiceId:message.voiceId,turn:e.turn,responseId:e.responseId,firstAudioAt:Date.now()});const chunks=audio.get(e.responseId)??[];chunks.push(Buffer.from(e.data,'base64'));audio.set(e.responseId,chunks);}else report.voice.push({voiceId:message.voiceId,event:e,at:Date.now()});
  // Playback acknowledgement is emitted by the production browser VoicePlayer.
 },undefined,undefined,undefined,(id,text,startedAt,current,context)=>manager!.routeVoiceInput(id,text,startedAt,current,context),(event,fields)=>{report.stages.push({event,...fields});},()=>manager!.voiceTargets(),(id,deliveryId,status)=>manager!.markDeliveryPlayback(id,deliveryId,status),(id,text,runId)=>manager!.recordSpokenAck(id,text,runId));
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
 const pageState=async()=>evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>{const rect=id=>{const r=document.querySelector('#'+id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};return {target:rect('target'),other:rect('other'),viewportHeight:innerHeight,viewportWidth:innerWidth,scrollY,hasHost:!!document.querySelector('[data-sideagent-overlay="marks"]'),detailVisible:!document.querySelector('#detail').hidden};}}).then(r=>r[0].result)`);
 const marks=async()=>{
  await evaluate(`chrome.debugger.attach({tabId:${fixtureTab.id}},'1.3').catch(()=>{})`);
  const tree=await evaluate(`chrome.debugger.sendCommand({tabId:${fixtureTab.id}},'DOM.getDocument',{depth:-1,pierce:true})`);const nodes:any[]=[];
  const walk=(n:any)=>{const attrs=n.attributes??[],index=attrs.indexOf('class');if(index>=0&&/(^| )mark( |$)/.test(attrs[index+1]))nodes.push(n);for(const child of [...n.children??[],...n.shadowRoots??[]])walk(child);};walk(tree.root);
  const boxes:any[]=[];for(const node of nodes){const r=await evaluate(`chrome.debugger.sendCommand({tabId:${fixtureTab.id}},'DOM.getBoxModel',{backendNodeId:${node.backendNodeId}}).catch(()=>null)`);if(r?.model){const q=r.model.border;boxes.push({x:Math.min(q[0],q[2],q[4],q[6]),y:Math.min(q[1],q[3],q[5],q[7]),width:Math.max(q[0],q[2],q[4],q[6])-Math.min(q[0],q[2],q[4],q[6]),height:Math.max(q[1],q[3],q[5],q[7])-Math.min(q[1],q[3],q[5],q[7])});}}return boxes;
 };
 const sendText=async(text:string)=>{const from=messages.length;await panelEval!(`(()=>{document.querySelector('#input').value=${JSON.stringify(text)};document.querySelector('#input').dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('#send-btn');await evaluate(`chrome.tabs.update(${fixtureTab.id},{active:true})`);if(caseName==='takeover'){await until(()=>messages.slice(from).find(m=>m.type==='control_result'&&m.action==='takeover'&&m.ok),120000);}else{await until(()=>messages.slice(from).find(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery.kind!=='ack'),120000);await until(()=>messages.slice(from).find(m=>m.type==='agent_event'&&m.event.kind==='agent_end'),120000);}return from;};
 const wantsMark=['mark_voice','mark_text','correction','explicit_correction','polite','heldout'].includes(caseName);
 if(['correction','explicit_correction'].includes(caseName)){
  const progress=(manager as any).progress.get('default');progress.recordUserTurn('找到当前页面的临时模型ID并圈出来。','seed-user');progress.observe({type:'agent_event',conversationId:'default',event:{kind:'user_delivery',delivery:{conversationId:'default',id:'seed-refusal',runId:null,kind:'reply',text:'我没法在页面上真的画圈，但可以用文字说明。',composedAt:Date.now(),status:'played'}}});report.seededRefusal=true;
 }
 if(caseName==='missing')await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>document.querySelector('#target').remove()})`);
 if(caseName==='disabled'){const sdk=(manager.get('default')!.runtime.session as any).session;sdk.setActiveToolsByName(sdk.getAllTools().map((t:any)=>t.name).filter((n:string)=>n!=='mark'));}
 if(caseName==='mark_failure')await evaluate('probe.failMark=true');
 if(caseName==='takeover')await evaluate('probe.holdBeforeMark=true');
 // Independent isolated-world evidence: any DOM write, not just the official mark host.
 const auditKey='__s1Audit'+randomUUID().replaceAll('-','');
 const audit=async(action:string)=>evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},world:'ISOLATED',func:(key,action)=>{
  if(action==='install'){
   const records=[];const capture=items=>records.push(...items.map(m=>({type:m.type,target:m.target.nodeName,attribute:m.attributeName,added:[...m.addedNodes].map(n=>n.nodeName),removed:[...m.removedNodes].map(n=>n.nodeName)})));
   const state=()=>({html:document.documentElement.outerHTML,styles:[...document.querySelectorAll('*')].map(e=>{const s=getComputedStyle(e);return [e.tagName,e.id,...[...s].map(p=>s.getPropertyValue(p))];}),sheets:[...document.styleSheets].map(s=>[...s.cssRules].map(r=>r.cssText))});
   const observer=new MutationObserver(capture);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
   window[key]={read:()=>{capture(observer.takeRecords());return {records:[...records],state:state()};},reset:()=>{observer.takeRecords();records.length=0;}};
  }
  if(action==='selftest'){const e=document.createElement('aside');e.style.cssText='position:fixed;inset:20px;border:4px solid red';document.body.append(e);const target=document.querySelector('#target');const before=target.getAttribute('style');target.style.outline='3px solid red';e.remove();if(before===null)target.removeAttribute('style');else target.setAttribute('style',before);}
  if(action==='reset')window[key].reset();
  return window[key].read();
 },args:${JSON.stringify([auditKey,action])}}).then(r=>r[0].result)`);
 let baselineAudit:any;
 if(caseName==='disabled'){
  await audit('install');const selftest=await audit('selftest');report.oracleSelftest=selftest.records;
  check('DOM oracle detects arbitrary overlays, target style writes and transient removal',selftest.records.some((r:any)=>r.added.includes('ASIDE'))&&selftest.records.some((r:any)=>r.attribute==='style')&&selftest.records.some((r:any)=>r.removed.includes('ASIDE')));
  baselineAudit=await audit('reset');
 }
 const utterances:Record<string,string>={mark_voice:'找到当前页面的临时模型ID，然后圈出来。',mark_text:'找到当前页面的临时模型ID，然后圈出来。',correction:'你可以圈出来的。',explicit_correction:'不是让你解释，请把它圈出来。',readonly:'只告诉我临时模型ID在哪里，先别圈，不要操作页面。',polite:'能帮我把当前页面的临时模型ID标出来吗？',capability:'只问你有没有标注能力，不要操作页面。',missing:'找到临时模型ID并圈出来。',mark_failure:'请把临时模型ID圈出来。',takeover:'请把临时模型ID圈出来。',extra_tool_voice:'测试仪表的当前读数是多少？',extra_tool_text:'测试仪表的当前读数是多少？',disabled:'请把临时模型ID圈出来。'};
 const utterance=caseName==='heldout'?'帮我在这页给临时模型ID做个醒目的圈注。':caseName==='root_target'?'root guard':caseName==='js_enabled'?'JS execution regression':utterances[caseName];if(!utterance)throw Error('Unknown case '+caseName);report.utterance=utterance;
 const start=messages.length;
 if(caseName==='root_target'){await evaluate(`probe.execute({name:'switch_tab',params:{tabId:${fixtureTab.id}},conversationId:'default',sessionId:'main'})`);let rejected=false;try{await evaluate(`probe.execute({name:'mark',params:{target:'body'},conversationId:'default',sessionId:'main'})`);}catch(error){rejected=String(error).includes('具体内容');report.rootError=String(error);}check('the actual browser mark tool rejects a whole-page placeholder',rejected);}
 else if(caseName==='js_enabled'){
  await evaluate(`probe.execute({name:'switch_tab',params:{tabId:${fixtureTab.id}},conversationId:'default',sessionId:'main'})`);
  const sdk=(manager.get('default')!.runtime.session as any).session;
  for(const name of ['js','browser_run']){
   const code=`(()=>{document.querySelector('#target').dataset.s1Js=${JSON.stringify(name)};return document.querySelector('#target code').textContent;})()`;
   const tool=sdk.getToolDefinition(name);const params=name==='js'?{code}:{code:`return await browser.js({code:${JSON.stringify(code)}});`};
   const result=await tool.execute('js-regression',params);
   check(name+' reaches production JS handler and reads the real target',JSON.stringify(result).includes(targetCode));
   const value=await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>document.querySelector('#target').dataset.s1Js}).then(r=>r[0].result)`);
   check(name+' changes the actual page',value===name);
   const active=sdk.getActiveToolNames();sdk.setActiveToolsByName(active.filter((n:string)=>n!=='take_tab'));
   const calls=report.tools.length;let rejected=false;
   try{await tool.execute('restricted-js',params);}catch(error){rejected=/不可用|未启用/.test(String(error));}
   check(name+' respects disabled registered tab control before RPC',rejected&&report.tools.length===calls);
   sdk.setActiveToolsByName(active);await tool.execute('restored-js',params);
   check(name+' resumes after actual registry restoration',report.tools.length===calls+1);
  }
 }
 else if(['mark_text','extra_tool_text','mark_failure','takeover'].includes(caseName))await sendText(utterance);else{await listen();report.speechInputResult=await speak(utterance);}
 if(!['root_target','takeover','js_enabled'].includes(caseName))await until(()=>manager!.getTaskProgress('default')?.state==='idle'||undefined,60000);await panelQueue;report.finalSnapshot=manager.getTaskProgress('default');report.markCalls=report.tools.filter((t:any)=>t.name==='mark');
 const boxes=await marks();report.boxes=boxes;
 if(caseName==='disabled'){
  const finalAudit=await audit('read');report.domAudit={baseline:baselineAudit,final:finalAudit};
  await writeFile(join(out,'dom-audit.json'),JSON.stringify(report.domAudit,null,2));
  check('disabled mark permits no arbitrary DOM writes or style changes',finalAudit.records.length===0&&JSON.stringify(finalAudit.state)===JSON.stringify(baselineAudit.state));
  check('disabled capabilities cannot reach page JS execution',!report.tools.some((t:any)=>t.name==='js'));
  const deliveries=messages.slice(start).filter(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery.kind!=='ack').map(m=>m.event.delivery.text);report.disabledDeliveries=deliveries;
  check('disabled annotation is explicitly reported unavailable or incomplete',deliveries.some(t=>/未启用|禁用|不可用|无法|不能|没有.*(工具|能力)|未完成|没有完成/.test(t)));
  check('disabled annotation does not claim success',!deliveries.some(t=>/(已|已经|成功).{0,8}(圈出|圈好|标出|标好|画出|标注完成)/.test(t)));
 }
 if(wantsMark){
  check('actual mark tool succeeds',report.markCalls.some((t:any)=>t.ok));check('page contains a visible annotation',boxes.some(b=>b.width>0&&b.height>0));
  const details=await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},world:'ISOLATED',func:()=>window.__sideagent?.markDetails?.()??[]}).then(r=>r[0].result)`);report.markDetails=details;check('the actual annotation uses hand-drawn boiling frames',details.some((d:any)=>d.isSketch&&d.isBoil&&d.boilFrameCount>=3));
  const tree=await evaluate(`chrome.debugger.sendCommand({tabId:${fixtureTab.id}},'DOM.getDocument',{depth:-1,pierce:true})`);let svgId:number|undefined;
  const findSvg=(n:any)=>{const attrs=n.attributes??[],i=attrs.indexOf('class');if(i>=0&&/(^| )sketch-svg( |$)/.test(attrs[i+1]))svgId=n.backendNodeId;for(const ch of [...n.children??[],...n.shadowRoots??[]])findSvg(ch);};findSvg(tree.root);
  const object=svgId?await evaluate(`chrome.debugger.sendCommand({tabId:${fixtureTab.id}},'DOM.resolveNode',{backendNodeId:${svgId}})`):null;const samples:any[]=[];
  if(object?.object?.objectId)for(let i=0;i<12;i++){const sample=await evaluate(`chrome.debugger.sendCommand({tabId:${fixtureTab.id}},'Runtime.callFunctionOn',{objectId:${JSON.stringify(object.object.objectId)},functionDeclaration:"function(){const s=getComputedStyle(this);return {frame:s.getPropertyValue('--mark-boil-frame'),animation:s.animationName,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches};}",returnByValue:true})`);samples.push(sample.result.value);await sleep(125);}
  report.motionSamples=samples;check('boiling motion actually changes frames unless reduced motion is requested',samples.some(s=>s.reduced)||new Set(samples.map(s=>s.frame)).size>1);

  const state=await pageState();report.pageState=state;check('annotation is in the visible viewport',boxes.some(b=>b.y+b.height>0&&b.y<state.viewportHeight&&b.x+b.width>0&&b.x<state.viewportWidth));
  const correct=boxes.find(b=>b.x>=state.target.x-16&&b.y>=state.target.y-16&&b.x+b.width<=state.target.x+state.target.width+16&&b.y+b.height<=state.target.y+state.target.height+16);check('annotation belongs to target card rather than its distractor',!!correct);
  await evaluate(`chrome.scripting.executeScript({target:{tabId:${fixtureTab.id}},func:()=>window.scrollBy(0,120)})`);await sleep(250);const scrolled=await marks(),after=await pageState();
  check('annotation follows the target when the page scrolls',scrolled.some(b=>Math.abs((b.y-after.target.y)-(correct.y-state.target.y))<4));
  const shot=await evaluate(`chrome.tabs.captureVisibleTab(${fixtureTab.windowId},{format:'png'})`);await writeFile(join(out,'annotation.png'),Buffer.from(shot.split(',')[1],'base64'));
  await evaluate(`probe.execute({name:'clear_marks',params:{},conversationId:'default',sessionId:'main'})`);check('existing clear-marks removes the annotation',(await marks()).length===0);
 }else{
  check('no annotation appeared',boxes.length===0);
  if(['readonly','capability'].includes(caseName))check('a read-only request did not call page-changing tools',!report.tools.some((t:any)=>['mark','clear_marks','click','fill','type_text','press_key','navigate','open_tab','js'].includes(t.name)));
  if(['mark_failure','takeover'].includes(caseName))check('the injected failure reached the real execution boundary',report.markCalls.some((t:any)=>!t.ok));
 }
 if(caseName.startsWith('extra_tool')){check('a new registered tool is used without a voice-specific routing rule',messages.slice(start).some(m=>m.type==='agent_event'&&m.event.kind==='tool_start'&&m.event.name==='fixture_meter'));check('the answer uses the actual new tool result',messages.slice(start).some(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery.text.includes(String(meterValue))));}
 if(caseName==='takeover'){check('native takeover message pauses the actual task',messages.some(m=>m.type==='control_result'&&m.action==='takeover'&&m.ok)&&report.finalSnapshot.state==='paused');}
 if(!['root_target','takeover','js_enabled'].includes(caseName))check('one current formal answer is retained',messages.slice(start).some(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery.kind!=='ack'));
 check('delivery/playback cannot claim independently verified task success',report.finalSnapshot?.successVerified===false);
 report.ok=true;

}catch(e){report.error=String(e);process.exitCode=1;console.error(report.error);}
finally{
 report.deliveryMetrics={composeCalls:deliveryMetrics.composeCalls,composeMs:[...deliveryMetrics.composeMs]};
 if(panelEval)await panelEval(`document.querySelector('.voice-start')?.getAttribute('aria-expanded')==='true'&&document.querySelector('.voice-start').click()`).catch(()=>{});await pendingInput;voice?.close();manager?.dispose();await panelQueue.catch(()=>{});
 for(const [id,chunks] of audio)await writeFile(join(out,`output-${id.replace(/[^a-zA-Z0-9_-]/g,'')}.wav`),wav(Buffer.concat(chunks)));
 await writeFile(join(out,'task-events.json'),JSON.stringify(messages.filter(m=>m.type!=='voice'||m.event.kind!=='audio'),null,2));
 if(cdp)await cdp.close();if(child){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await Promise.race([exited,sleep(3000)]);report.browserExited=child.exitCode!==null||child.signalCode!==null;if(!report.browserExited){child.kill('SIGKILL');await exited;report.browserExited=true;}}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,error:report.error,checks:report.checks}));await new Promise<void>(r=>process.stdout.write('',()=>r()));process.exit(report.ok?0:1);
}
