/** Boss-owned explicit-delivery evaluator: production sidepanel action -> runtime/manager -> real Step audio.
 * Synthetic microphone input and recorded output; no user Chrome/profile, no human-ear claim.
 * Chrome tool handlers are production code, transport is a CDP test bridge (not native messaging).
 */
import {build} from 'esbuild';
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

const out=await mkdtemp(join(tmpdir(),'ego-user-delivery-'));
const ext=join(out,'extension'),profile=join(out,'profile');await mkdir(ext);
const marker=randomUUID().slice(0,6);
const organizations=['青鹭','松风','鹤鸣','竹海','白榆','云杉','橙湾','星浦','海棠','岚川'];
const first=randomInt(organizations.length),second=(first+1+randomInt(organizations.length-1))%organizations.length;
const activityOrg=organizations[first]+'工作坊',interviewOrg=organizations[second]+'研究';
const eventName=`${activityOrg}活动邀请`,interviewName=`${interviewOrg}访谈邀请`;
const bodyMarker='纸鹤橙桥'+Math.floor(1000+Math.random()*9000);
const report:any={ok:false,evidence:voiceEvidence(),scope:'production sidepanel DOM/client/worklet/player + task runtime + real models; isolated tools via CDP; synthetic microphone stream, muted browser audio playback; test transport supplies production VoiceObservation grant at commit; not human listening',marker,activityOrg,interviewOrg,eventName,interviewName,bodyMarker,checks:[],voice:[],tools:[],stages:[]};
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
 const invitations=[`<li><a href="/activity">${eventName}</a></li>`,`<li><a href="/interview">${interviewName}</a></li>`];if(first%2)invitations.reverse();
 const body=req.url==='/activity'?`<h1>${eventName}</h1><p>活动时间：周六下午三点。集合地点：南岸图书馆二楼。入场口令：${bodyMarker}。</p><a href="/">回收件箱</a>`:req.url==='/interview'?`<h1>${interviewName}</h1><p>访谈时间尚未确定，请回复可用时间。</p><a href="/">回收件箱</a>`:`<h1>收件箱：最近三封邮件</h1><p>此页仅列出标题，尚未打开正文。</p><ul>${invitations.join('')}<li>河岸周刊：本周阅读清单</li></ul>`;
 res.end(`<!doctype html><meta charset="utf-8"><title>收件箱</title><style>body{font:22px sans-serif;line-height:1.8;padding:36px}li{margin:18px}</style>${body}`);
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
 const observation=new VoiceObservation();
 const handlers={open_tab:openTab,navigate,snapshot,click,hover,fill,type_text:typeText,press_key:pressKey,scroll,mark,clear_marks:(_p,s)=>clearMarks(s),read_element:readElement,js:evaluateJs,list_tabs:(_p,s)=>listTabs(s),get_active_tab:(_p,s)=>getActiveTab(s),switch_tab:switchTab,close_tab:closeTab,screenshot:(_p,s)=>screenshot({},s),observe_page:p=>observation.capture(p.token,()=>true)};
 globalThis.probe={issue:()=>observation.issue(),execute:async(frame)=>{const handler=handlers[frame.name];if(!handler)throw Error('Unsupported evaluator bridge tool '+frame.name);if((frame.name==='open_tab'||frame.name==='navigate')&&!String(frame.params.url).startsWith('http://127.0.0.1:'))throw Error('Evaluator only permits its local fixture');return handler(frame.params,executionKey(frame.conversationId||'default',frame.sessionId||'main'));}};
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
 cdp.onEvent('Runtime.bindingCalled',(event:any)=>{if(event.sessionId!==uiSid||event.params.name!=='hostSend')return;const envelope=JSON.parse(event.params.payload);if(envelope.kind!=='client')return;pendingInput=pendingInput.then(async()=>{const m=envelope.msg;if(m.type==='voice'&&['commit','playback_done'].includes(m.command.kind))(report.clientTiming??=[]).push({voiceId:m.voiceId,command:m.command.kind,turn:m.command.turn,responseId:m.command.responseId,at:Date.now()});if(m.type==='voice'){voiceId=m.voiceId;if(m.command.kind==='interrupt')turn=m.command.turn;if(m.command.kind==='commit'){const observation=await evaluate('probe.issue()');if(observation)m.command={...m.command,input:{...m.command.input,observation}};}await voice!.handle(m.conversationId??'default',m);}else await manager!.handleMessage(m);}).catch(error=>{report.transportError=String(error);});});
 const store=new ConversationStore(join(out,'conversations'));
 manager=new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,'minimax-cn/MiniMax-M3',{sessionManager:store.sessionManager(id),mode:summary?.mode}),message=>{
  messages.push(message);voice?.observe(message);postPanel(message);
  if(message.type==='tool_call'){
   const record:any={name:message.name,conversationId:message.conversationId,at:Date.now()};report.tools.push(record);
   void evaluate(`probe.execute(${JSON.stringify(message)})`).then(data=>{record.ok=true;record.result=JSON.stringify(data,(key,value)=>key==='imageBase64'?'[image omitted]':value)?.slice(0,16000);return manager!.handleMessage({type:'tool_result',conversationId:message.conversationId,id:message.id,ok:true,data});},error=>{record.ok=false;record.error=String(error);return manager!.handleMessage({type:'tool_result',conversationId:message.conversationId,id:message.id,ok:false,error:String(error)});});
  }
 },store);
 voice=new VoiceService(id=>manager!.getTaskProgress(id),message=>{
  messages.push(message);postPanel(message);if(message.type!=='voice')return;
  const e=message.event;if(e.kind==='audio'){if(!audio.has(e.responseId))(report.audioTiming??=[]).push({voiceId:message.voiceId,turn:e.turn,responseId:e.responseId,firstAudioAt:Date.now()});const chunks=audio.get(e.responseId)??[];chunks.push(Buffer.from(e.data,'base64'));audio.set(e.responseId,chunks);}else report.voice.push({voiceId:message.voiceId,event:e,at:Date.now()});
  // Playback acknowledgement is emitted by the production browser VoicePlayer.
 },undefined,undefined,undefined,(id,text,startedAt,current,context)=>manager!.routeVoiceInput(id,text,startedAt,current,context),(event,fields)=>{report.stages.push({event,...fields});},()=>manager!.voiceTargets(),(id,deliveryId,status)=>manager!.markDeliveryPlayback(id,deliveryId,status),(id,text,runId)=>manager!.recordSpokenAck(id,text,runId));
 await manager.ensureDefault();check('actual task model initialized',manager.get('default')!.runtime.session.available);
 await cdp.send('Page.navigate',{url:url+'sidepanel.html'},uiSid);await until(async()=>await panelEval!('uiListeners.length>0')||undefined);
 await panelEval!(`uiEmit({kind:'conversations',selectedConversationId:'default',conversations:[{id:'default',title:'受控收件箱',createdAt:1,updatedAt:1,state:'idle',mode:'act'}]});uiEmit({kind:'conn',state:'connected'});uiEmit({kind:'server',msg:{type:'hello_ok',version:1,model:'minimax-cn/MiniMax-M3',models:[{id:'minimax-cn/MiniMax-M3',provider:'minimax-cn',modelId:'MiniMax-M3',name:'MiniMax-M3'}]}});`);
 panelReady=true;for(const m of bufferedPanel.splice(0))postPanel(m);await panelQueue;
 const click=async(selector:string)=>{const point=await panelEval!(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp!.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point},uiSid);await cdp!.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point},uiSid);};
 const listen=async()=>{const from=messages.length;await click('.voice-start');await until(()=>messages.slice(from).some(m=>m.type==='voice'&&m.event.kind==='state'&&m.event.state==='ready')||undefined,25000);await panelQueue;};
 const speak=async(text:string,_input?:VoiceInputContext)=>{
  const begin=messages.length;report.stage=`speech ${text}`;console.log(report.stage);const base=join(out,`input-${report.voice.length}`);
  execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',base+'.aiff',text]);execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',base+'.aiff','-ar','24000','-ac','1','-f','s16le',base+'.pcm']);
  const pcm=Buffer.concat([await readFile(base+'.pcm'),Buffer.alloc(48000)]);const pageList=await evaluate(`probe.execute(${JSON.stringify({name:'list_tabs',params:{},conversationId:'default',sessionId:'main'})})`).catch(()=>null);const activePage=pageList?.tabs?.find((t:any)=>t.working&&t.url.startsWith(url)&&!t.url.endsWith('sidepanel.html'));if(activePage?.id)await evaluate(`chrome.tabs.update(${JSON.stringify(activePage.id)},{active:true})`);await panelEval!(`injectSpeech(${JSON.stringify(pcm.toString('base64'))})`);
  await until(()=>{if(report.transportError)throw Error(report.transportError);const events=messages.slice(begin).filter(m=>m.type==='voice'&&m.voiceId===voiceId);const err=events.find(m=>m.event.kind==='state'&&m.event.state==='error');if(err)throw Error(err.event.detail);return events.find(m=>m.event.kind==='response_end');},60000);
  await panelQueue;await until(async()=>await panelEval!(`document.querySelector('.voice-progress').dataset.state==='listening'`)||undefined,60000);
  return messages.slice(begin).filter(m=>m.type==='voice'&&m.voiceId===voiceId&&m.event.kind==='text'&&m.event.role==='assistant').map(m=>m.event.text).join('\n');
 };
 report.stage='voice connect';await listen();await speak('你好。');
 report.stage='read controlled inbox';const start=messages.length;
 // The real sidepanel is not a navigable tab. Keep the HTTP test UI out of the task's active-page fallback.
 await evaluate(`chrome.tabs.create({url:'about:blank',active:true})`);
 const request=`打开 ${url} 看最近三封邮件的标题，简短说有什么。当前先不打开正文，不需要分工。`;await panelEval!(`(()=>{const i=document.querySelector('#input');i.value=${JSON.stringify(request)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('#send-btn');
 await until(()=>messages.slice(start).find(m=>m.type==='agent_event'&&m.event.kind==='agent_end'),120000);
 check('production lead marks this run as explicit delivery without depending on memory',messages.slice(start).some(m=>m.type==='agent_event'&&m.event.kind==='agent_start'&&m.event.deliveryMode==='explicit'));
 report.finalSnapshot=manager.getTaskProgress('default');
 await until(()=>messages.slice(start).find(m=>m.type==='voice'&&m.event.kind==='response_end'),60000);
 const assertDelivery=async(label:string,spoken:string,from:number)=>{
  await panelQueue;await until(async()=>await panelEval!(`document.querySelector('.voice-progress').dataset.state==='listening'`)||undefined,60000);const deliveries=messages.slice(from).filter(m=>m.type==='agent_event'&&m.event.kind==='user_delivery').map(m=>m.event.delivery).filter(d=>d&&d.kind!=='ack');
  const exact=deliveries.find(d=>d.text.trim()===spoken.trim());check(label+' has an explicit delivery matching spoken content',!!exact);
  const visible=await panelEval!(`[...document.querySelectorAll('.msg.assistant')].map(e=>e.textContent?.trim())`);check(label+' renders that delivery once in the existing answer area',visible.filter((t:string)=>t===exact.text.trim()).length===1);
  const voiceText=await panelEval!(`document.querySelector('.voice-answer').textContent.trim()`);check(label+' voice panel uses the same delivered text',voiceText===exact.text.trim());
  await until(()=>manager!.getTaskProgress('default')?.conversationContext?.latestDelivery?.id===exact.id&&manager!.getTaskProgress('default')?.conversationContext?.latestDelivery?.status==='played'||undefined,5000);check(label+' playback acknowledgement updates that same delivery',manager!.getTaskProgress('default')?.conversationContext?.latestDelivery?.status==='played');
  (report.deliveryMatches??=[]).push({label,id:exact.id,text:exact.text});
 };
 report.resultSpeech=messages.slice(start).filter(m=>m.type==='voice'&&m.event.kind==='text'&&m.event.role==='assistant').map(m=>m.event.text).join('\n');
 check('real webpage result traverses task manager and produces a specific spoken finding',[activityOrg,interviewOrg,'河岸周刊'].some(name=>report.resultSpeech.includes(name))&&!report.resultSpeech.includes('这一轮执行已经结束，结果还没有确认'));
 check('no body-only marker is invented before a detail page is opened',!report.resultSpeech.includes(bodyMarker));
 check('spoken result is natural prose without Markdown list or formatting markers',!/(^|\n)\s*[-*#]\s|\*\*|`/.test(report.resultSpeech));
 await assertDelivery('task result',report.resultSpeech,start);
 const resultIds=new Set(messages.slice(start).filter(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery?.kind!=='ack').map(m=>m.event.delivery.id));check('this compact task delivers one result instead of a second makeup copy',resultIds.size===1);
 const observation=await evaluate('probe.issue()');
 const followupIndex=messages.length;report.followup=await speak('活动那个呢？',observation?{observation}:undefined);
 // A follow-up may start a detail-reading task. Wait for that task and its own announcement when present.
 if(manager.getTaskProgress('default')?.state==='running'){const from=messages.length;await until(()=>manager!.getTaskProgress('default')?.state==='idle'||undefined,120000);await until(()=>messages.slice(from).find(m=>m.type==='voice'&&m.event.kind==='response_end'),60000);report.followup+='\n'+messages.slice(from).filter(m=>m.type==='voice'&&m.event.kind==='text'&&m.event.role==='assistant').map(m=>m.event.text).join('\n');}
 check('follow-up identifies the actual activity object, not just the generic word activity',report.followup.includes(activityOrg));
 await assertDelivery('follow-up',report.followup,followupIndex);
 const correctionIndex=messages.length;
 report.correction=await speak('不是访谈，是活动邀请。',await evaluate('probe.issue()').then(observation=>observation?{observation}:undefined));
 if(manager.getTaskProgress('default')?.state==='running'){
  await until(()=>manager!.getTaskProgress('default')?.state==='idle'||undefined,120000);
  await until(()=>messages.slice(correctionIndex).filter(m=>m.type==='voice'&&m.event.kind==='response_end').length>=2||undefined,60000);
  report.correction=messages.slice(correctionIndex).filter(m=>m.type==='voice'&&m.event.kind==='text'&&m.event.role==='assistant').map(m=>m.event.text).join('\n');
 }
 check('correction returns to the activity invitation with its known name',report.correction.includes(activityOrg));
 await assertDelivery('correction',report.correction,correctionIndex);
 const detailMentioned=/周六|南岸图书馆|纸鹤橙桥/.test(report.followup+'\n'+report.correction);
 check('any spoken body detail has a preceding actual page-read result',!detailMentioned||report.tools.some((t:any)=>t.ok&&t.result?.includes(bodyMarker)));
 report.stage='voice reopen';await click('.voice-start');await pendingInput;const reopenIndex=messages.length;await listen();await sleep(600);
 check('reopening voice does not replay old result',!messages.slice(reopenIndex).some(m=>m.type==='voice'&&m.event.kind==='text'&&m.event.role==='assistant'));
 report.reopenedAnswer=await speak('刚才那个活动邀请叫什么名字？');
 check('reopened voice can refer to the same activity result',report.reopenedAnswer.includes(activityOrg));
 await assertDelivery('reopened answer',report.reopenedAnswer,reopenIndex);
 report.stage='voice off text task';await click('.voice-start');await pendingInput;const textOnlyStart=messages.length;
 const textOnlyRequest=`打开 ${url}interview 读访谈邮件的正文，告诉我时间是否确定。只读，不回复，不分工。`;
 await panelEval!(`(()=>{const i=document.querySelector('#input');i.value=${JSON.stringify(textOnlyRequest)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('#send-btn');
 await until(()=>messages.slice(textOnlyStart).some(m=>m.type==='agent_event'&&m.event.kind==='agent_end')||undefined,120000);
 await until(()=>messages.slice(textOnlyStart).some(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery?.kind==='finding')||undefined,45000);await panelQueue;
 const textOnlyDeliveries=messages.slice(textOnlyStart).filter(m=>m.type==='agent_event'&&m.event.kind==='user_delivery').map(m=>m.event.delivery).filter(d=>d?.kind==='finding');report.textOnlyDelivery=textOnlyDeliveries.at(-1);
 check('voice-off task produces a fresh explicit result',!!report.textOnlyDelivery&&report.textOnlyDelivery.id!==report.deliveryMatches[0].id);
 check('voice-off task does not silently restart or synthesize voice',!messages.slice(textOnlyStart).some(m=>m.type==='voice'&&m.event.kind==='audio'));
 const textOnlyVisible=await panelEval!(`[...document.querySelectorAll('.msg.assistant')].map(e=>e.textContent.trim())`);
 check('voice-off result appears once in the existing answer area',textOnlyVisible.filter((t:string)=>t===report.textOnlyDelivery.text.trim()).length===1);
 report.deliveryToolCalls=messages.filter(m=>m.type==='agent_event'&&m.event.kind==='tool_start'&&m.event.name==='send_user_message').length;
 await panelQueue;report.visibleAnswer=await panelEval!(`[...document.querySelectorAll('.msg.assistant')].map(e=>e.textContent).join('\\n')`);check('actual production sidepanel displays a task answer identifying the activity',report.visibleAnswer.includes(activityOrg));const shot=await cdp.send('Page.captureScreenshot',{format:'png'},uiSid);await writeFile(join(out,'sidepanel.png'),Buffer.from(shot.data,'base64'));report.ok=true;
}catch(e){report.error=String(e);process.exitCode=1;console.error(report.error);}
finally{
 report.deliveryMetrics={composeCalls:deliveryMetrics.composeCalls,composeMs:[...deliveryMetrics.composeMs]};
 if(panelEval)await panelEval(`document.querySelector('.voice-start')?.getAttribute('aria-expanded')==='true'&&document.querySelector('.voice-start').click()`).catch(()=>{});await pendingInput;voice?.close();manager?.dispose();await panelQueue.catch(()=>{});
 for(const [id,chunks] of audio)await writeFile(join(out,`output-${id.replace(/[^a-zA-Z0-9_-]/g,'')}.wav`),wav(Buffer.concat(chunks)));
 await writeFile(join(out,'task-events.json'),JSON.stringify(messages.filter(m=>m.type!=='voice'||m.event.kind!=='audio'),null,2));
 if(cdp)await cdp.close();if(child){const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGTERM');await Promise.race([exited,sleep(3000)]);report.browserExited=child.exitCode!==null||child.signalCode!==null;if(!report.browserExited){child.kill('SIGKILL');await exited;report.browserExited=true;}}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,error:report.error,checks:report.checks}));
}
