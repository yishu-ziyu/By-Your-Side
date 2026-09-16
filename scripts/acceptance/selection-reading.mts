/** Actual headless extension UI. --live replaces only the fixture responder with the real model runtime. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {WebSocketServer, WebSocket} from 'ws';
import {launchIsolatedExtension, until, sleep} from './isolated-extension.mts';
import {createCdp, fetchJson} from './cdp.mjs';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {loadConfig} from '../../agent/src/config.js';
import {parseClientMessage, PROTOCOL_VERSION, DEFAULT_PORT, HOST_VERSION, STORAGE_SCHEMA_VERSION} from '../../shared/protocol.js';

if (!process.argv.includes('--headless')) throw new Error('Required: --headless');
const live = process.argv.includes('--live');
const out = resolve('out/acceptance', `selection-reading-${live?'live':'controlled'}-${Date.now()}`);
await mkdir(out,{recursive:true});
const fixtureHtml = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>一段论文 · 阅读验收</title><style>body{margin:0;background:#faf9f7;color:#343438;font:17px/1.9 Georgia,"Songti SC",serif}main{max-width:670px;margin:200px auto;padding:30px}h1{font:32px/1.3 Georgia}small{font:12px system-ui;color:#888}p{margin:25px 0}textarea{margin-top:40px;width:400px;height:60px}pre{padding:20px;background:#efefed}a{color:#555}</style><main><small>FIELD NOTES / METHODS</small><h1>理解研究中的质量控制</h1><p>研究团队为每个样本估算外源污染比例，用于判断测量结果是否可靠。本实验的内部代号是蓝桉四十七。</p><p id="passage">Samples were excluded when the contamination fraction exceeded 0.18. This threshold was selected before outcome analysis to reduce the influence of external DNA on variant detection.</p><p id="second">A sensitivity analysis repeated the estimation with a stricter threshold of 0.10. The direction of the primary result remained unchanged.</p><pre id="code">if (fraction > 0.18) {\n  exclude(sample);\n}</pre><textarea aria-label="编辑区">输入框里的文字不应触发划词</textarea></main></html>`;
const token=randomUUID();let socket:WebSocket|undefined;const events:any[]=[];const cases:string[]=[];
let mode:'answer'|'hold'|'fail'='answer';
const mockAnswer='这段话是在说明**样本的排除标准**。\n\n- 污染比例超过 **18%** 的样本不会进入分析。\n- 门槛在看结果之前确定，避免根据结果挑选样本。\n\n`contamination fraction` 指外源 DNA 在样本中所占的比例。';
const store = new ConversationStore(join(out,'conversations'));
const manager = live ? new ConversationManager((id,emit,summary)=>createConversationRuntime(id,emit,loadConfig().model,{sessionManager:store.sessionManager(id),mode:summary?.mode}), msg=>{events.push({direction:'server',msg});socket?.send(JSON.stringify(msg));},store) : undefined;
if(manager) await manager.ensureDefault();
const summary={id:'default',title:'原任务',createdAt:Date.now(),updatedAt:Date.now(),state:'idle',mode:'act'};
const mockSummaries:any[]=[summary];
const wss=new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise<void>((r,j)=>{wss.once('listening',r);wss.once('error',j);});
const reply=(msg:any)=>{events.push({direction:'server',msg});socket?.send(JSON.stringify(msg));};
wss.on('connection',client=>client.on('message',async raw=>{
  const msg=parseClientMessage(String(raw));if(!msg)return;
  if(msg.type==='hello'){
    if(msg.token!==token){client.close();return;}socket=client;
    reply({type:'hello_ok',version:PROTOCOL_VERSION,hostVersion:HOST_VERSION,storageSchema:STORAGE_SCHEMA_VERSION,extensionVersion:'0.1.0',model:manager?.get('default')?.runtime.session.modelName()??'fixture/reading',models:[]});
    reply({type:'conversation_list',conversations:manager?.list()??mockSummaries});return;
  }
  events.push({direction:'client',msg});
  if(manager){void manager.handleMessage(msg).catch(error=>{events.push({error:String(error)});});return;}
  if(msg.type==='conversation_list')reply({type:'conversation_list',conversations:mockSummaries});
  if(msg.type==='reading_request'){
    const base={type:'reading_event',requestId:msg.requestId,threadId:msg.transcript.threadId};
    reply({...base,state:'pending',text:''});
    if(mode==='hold') {reply({...base,state:'streaming',text:'已生成的部分'});return;}
    await sleep(80);reply({...base,state:'streaming',text:mockAnswer.slice(0,30)});
    await sleep(180);reply({...base,state:mode==='fail'?'error':'done',text:mockAnswer,error:mode==='fail'?'验收断流':undefined});
  }
  if(msg.type==='conversation_create'){const conversation={...summary,id:'c-'+msg.requestId.slice(0,8),title:msg.title??'新会话'};if(!mockSummaries.some(s=>s.id===conversation.id))mockSummaries.push(conversation);reply({type:'conversation_created',requestId:msg.requestId,conversationId:conversation.id,conversation});}
}));
let iso:Awaited<ReturnType<typeof launchIsolatedExtension>>|undefined;
let cdp:ReturnType<typeof createCdp>|undefined;
try {
  iso=await launchIsolatedExtension({fixtureHtml});
  await iso.swEval(`globalThis.WebSocket=class extends WebSocket { constructor(url, protocols){super(url==='ws://127.0.0.1:${DEFAULT_PORT}'?'ws://127.0.0.1:${(wss.address() as any).port}':url,protocols)} };`);
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
  const extensionId=await iso.swEval('chrome.runtime.id');
  const panel=await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(async()=>await iso!.evalIn(panel,"!!document.querySelector('#input')")||undefined,10000,'panel');
  await iso.evalIn(panel,"window.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
  await until(()=>socket?.readyState===WebSocket.OPEN||undefined,15000,'connection');
  const target=await iso.newTarget(`${iso.fixtureOrigin}/paper`);
  await until(async()=>await iso!.evalIn(target,"!!document.querySelector('[data-sideagent-ask]')")||undefined,10000,'injected selection UI');
  const port=(await readFile(join(iso.outDir,'profile','DevToolsActivePort'),'utf8')).split('\n')[0];
  cdp=createCdp((await fetchJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl);await cdp.ready();
  const session=await cdp.attachSession(target);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false},session);
  const find=(node:any):any=>{if(node.attributes?.includes('data-sideagent-ask'))return node;for(const child of [...node.children??[],...node.shadowRoots??[]]){const found=find(child);if(found)return found;}};
  async function ui(body:string):Promise<any>{
    const node=find((await cdp!.send('DOM.getDocument',{depth:-1,pierce:true},session)).root);
    assert(node?.shadowRoots?.[0],'closed shadow root exists');
    const resolved=await cdp!.send('DOM.resolveNode',{backendNodeId:node.shadowRoots[0].backendNodeId},session);
    const result=await cdp!.send('Runtime.callFunctionOn',{objectId:resolved.object.objectId,functionDeclaration:`function(){${body}}`,returnByValue:true,awaitPromise:true},session);
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description);return result.result.value;
  }
  async function click(selector:string){const point=await ui(`const el=this.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('control unavailable');const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`);for(const type of ['mousePressed','mouseReleased'])await cdp!.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point},session);await sleep(80);}
  async function type(text:string){await click('textarea');await cdp!.send('Input.insertText',{text},session);}
  async function select(selector:string){await iso!.evalIn(target,`(()=>{document.activeElement?.blur();const r=document.createRange();r.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));})()`);await sleep(60);}
  const records=async()=>await iso!.swEval("chrome.storage.session.get('readingRecords').then(v=>v.readingRecords??[])") as any[];
  const latest=async()=> (await records()).at(-1);
  async function done(turns=1){await until(async()=>{const r=await latest();return r?.turns.length===turns&&r?.turns.at(-1)?.state==='done'?r:undefined;},live?90000:10000,'reading complete');await sleep(250);}
  await select('#passage');
  assert.equal(await ui("return this.querySelector('.surface').hidden"),false);
  await iso.screenshot(target,join(out,'01-toolbar.png'));
  await click('[data-act="ask"]');await until(async()=>await ui("return !this.querySelector('.composer').hidden")||undefined,5000,'composer');
  await iso.screenshot(target,join(out,'02-input.png'));
  await type('解释这段话，用中文。');await click('.send');await done();
  assert.match(await ui("return this.querySelector('.messages').textContent"),live?/18|0.18/:/排除标准/);
  assert(!events.some(e=>e.msg?.type==='tool_call'), 'reading must expose no browser tools');
  await click('[data-act="copy"]');assert((await ui("return this.querySelector('[data-act=copy]').textContent")).includes('已复制'));cases.push('复制回答');
  const bounds=await ui("const r=this.querySelector('.surface').getBoundingClientRect();return {top:r.top,bottom:r.bottom};");
  const selection=await iso.evalIn(target,"(()=>{const r=document.querySelector('#passage').getBoundingClientRect();return {top:r.top,bottom:r.bottom}})()");
  assert(bounds.bottom<=selection.top||bounds.top>=selection.bottom,'normal selection must remain visible');
  await ui("this.querySelector('.messages').scrollTop=0;");
  await iso.screenshot(target,join(out,'03-answer.png'));cases.push('实际选区、输入、发送、流式回答');
  await type('文中的实验内部代号是什么？');await click('.send');await done(2);
  const completed=await latest();assert.equal(completed.turns.length,2);
  if(live)assert.match(completed.turns[1].answer,/蓝桉四十七/);
  assert(completed.source.surrounding.includes('蓝桉四十七'));cases.push('有限相邻段落和连续追问');
  await click('[data-act="close"]');assert.equal(await ui("return this.querySelector('.surface').hidden"),true);
  await click('[data-act="restore"]');await sleep(100);assert.equal(await ui("return this.querySelectorAll('.turn').length"),2);cases.push('关闭重开保留完整问答');
  const before=events.filter(e=>e.direction==='client'&&e.msg?.type==='reading_request').length;
  await ui("const input=this.querySelector('textarea');input.value='中文输入中';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));");
  await sleep(100);assert.equal(events.filter(e=>e.direction==='client'&&e.msg?.type==='reading_request').length,before);await ui("const i=this.querySelector('textarea');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));");cases.push('中文输入法 Enter 不误发送');
  await click('[data-act="handoff"]');
  const handoffRequest=await until(()=>events.find(e=>e.direction==='client'&&e.msg?.type==='conversation_create'&&e.msg.reading)?.msg,10000,'handoff request');
  assert(handoffRequest);
  const transfer=await until(()=>events.find(e=>e.msg?.type==='conversation_created'&&e.msg.requestId===handoffRequest.requestId)?.msg,20000,'handoff');
  await until(async()=>{const text=await iso!.evalIn(panel,'document.body.innerText');return text.includes('文中的实验内部代号')?text:undefined;},15000,'panel imported visible conversation');
  const imported=manager?.get(transfer.conversation.id);
  if(live){assert(imported);const persisted=await readFile(join(out,'conversations',transfer.conversation.id,'reading.json'),'utf8');assert(persisted.includes('蓝桉四十七'));assert.equal(imported!.runtime.session.isStreaming(),false);}
  const request=events.find(e=>e.direction==='client'&&e.msg?.type==='conversation_create'&&e.msg.reading)?.msg;
  assert.equal(request.reading.turns.length,2);assert.equal(request.reading.source.text,completed.source.text);
  await sleep(900);
  assert((await iso.evalIn(panel,'document.body.innerText')).includes('文中的实验内部代号'), 'handoff must remain selected after new sidepanel boot');
  assert.equal(await iso.swEval("chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId)"),transfer.conversation.id);
  await iso.screenshot(panel,join(out,'04-sidepanel.png'));cases.push('侧栏完整交接且不自动执行');
  if(live){
    const beforeAnswer=events.length;
    await iso.evalIn(panel, `(()=>{const i=document.querySelector('#input');i.value='我在网页浮层里上一条问题是什么？只复述那个问题。';i.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#send-btn').click();})()`);
    await until(()=>events.slice(beforeAnswer).some(e=>e.msg?.type==='agent_event'&&e.msg.conversationId===transfer.conversation.id&&e.msg.event.kind==='agent_end')||undefined,90000,'sidebar real followup');
    const answer=events.slice(beforeAnswer).filter(e=>e.msg?.type==='agent_event'&&e.msg.conversationId===transfer.conversation.id).map(e=>e.msg.event.kind==='user_delivery'?e.msg.event.delivery.text:e.msg.event.kind==='text_delta'?e.msg.event.delta:'').join('');
    assert.match(answer,/实验内部代号/);cases.push('侧栏真实模型能复述浮层中的上一条问题');
    await iso.screenshot(panel,join(out,'06-sidepanel-followup.png'));
  }
  if(!live){
    mode='hold';await select('#second');await click('[data-act="explain"]');await until(async()=> (await latest())?.turns.at(-1)?.state==='streaming'||undefined,5000,'held response');
    const held=await latest();await click('.send');await sleep(200);assert.equal((await latest()).turns.at(-1).state,'stopped');
    reply({type:'reading_event',requestId:held.requestId,threadId:held.threadId,state:'done',text:'LATE MUST NOT SHOW'});await sleep(150);assert(!(await ui("return this.querySelector('.messages').textContent")).includes('LATE'));cases.push('停止保留部分结果、迟到结果被拒绝');
    mode='fail';await click('[data-act="retry"]');await until(async()=> (await latest())?.turns.at(-1)?.state==='error'||undefined,5000,'partial failure');
    assert((await latest()).turns.at(-1).answer.length>0);
    mode='answer';await click('[data-act="retry"]');await done();assert.equal((await latest()).turns.length,1);cases.push('部分失败原地重试、不重复轮次');
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:360,height:700,deviceScaleFactor:1,mobile:false},session);await sleep(100);
  const box=await ui("const r=this.querySelector('.surface').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};");assert(box.left>=0&&box.right<=360&&box.top>=0&&box.bottom<=700);
  await iso.screenshot(target,join(out,'05-narrow.png'));cases.push('窄窗口边界');
  await select('#code');await click('[data-act="ask"]');await sleep(200);assert((await latest()).source.text.includes('\n  exclude'));cases.push('代码选区保留换行和缩进');
  // Selection inside editable content is ignored; keyboard text selection still opens the toolbar.
  await click('[data-act="close"]');
  await iso.evalIn(target, `(()=>{const field=document.querySelector('textarea');field.focus();field.setSelectionRange(0,5);getSelection().removeAllRanges();field.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));})()`);
  await sleep(100);assert.equal(await ui("return this.querySelector('.surface').hidden"),true);cases.push('编辑区选择不触发');
  await iso.evalIn(target, `(()=>{document.activeElement.blur();const r=document.createRange();r.selectNodeContents(document.querySelector('#second'));getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new KeyboardEvent('keyup',{key:'Shift',bubbles:true}));})()`);
  await sleep(100);assert.equal(await ui("return this.querySelector('.surface').hidden"),false);cases.push('键盘选区入口');
  await writeFile(join(out,'report.json'),JSON.stringify({passed:true,live,cases,model:manager?.get('default')?.runtime.session.modelName(),requests:events.filter(e=>e.direction==='client').map(e=>e.msg.type)},null,2));
  console.log(JSON.stringify({passed:true,live,cases,out}));
} catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({error:error instanceof Error?error.stack:String(error),cases,events},null,2));console.error(JSON.stringify({error:String(error),out}));process.exitCode=1;}
finally {for(const entry of manager?.list()??[])manager?.get(entry.id)?.runtime.dispose();socket?.close();for(const client of wss.clients)client.terminate();await new Promise<void>(r=>wss.close(()=>r()));await cdp?.close();await iso?.close();}
