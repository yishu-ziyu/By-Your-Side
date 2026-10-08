/** BDD: unresolved automatic replies cannot impersonate task notices; output without created metadata cannot play.
 * Real Step Plan frames are delayed/dropped only. No invented audio, transcript, playback or product receipts.
 * npx tsx scripts/acceptance/real-path/voice-plan-output-boundaries.mts --headless --case=delayed-created|unknown-output|source-timeout
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, recordScreen, sleep, until, exportDiagnosticsViaSettings } from './harness.mts';
import { modelStorageItems } from './inproc-config.mts';
import { startScriptedModel } from './scripted-model.mts';
requireHeadless();
const name = process.argv.find(a=>a.startsWith('--case='))?.slice(7) ?? 'delayed-created';
assert.ok(['delayed-created','unknown-output','source-timeout'].includes(name));
const out = join(REPO,'out/acceptance/real-path',`${new Date().toISOString().replace(/[:.]/g,'-')}-voice-plan-output-${name}`);
await mkdir(out,{recursive:true});
const phrase = name==='unknown-output' ? '你好，陪我聊聊今天的心情。' : '帮我点击这个网页上的保存按钮。';
const wav = join(out,'microphone.wav');
execFileSync('say',['-v','Tingting','-o',wav,'--data-format=LEI16@24000',`[[slnc 7000]]${phrase}[[slnc 28000]]`]);
const model = await startScriptedModel([
  {match:'"clauses"',steps:[{text:JSON.stringify({steps:[{action:name==='unknown-output'?'chat':'start',target:null}]}),delayMs:300}]},
  {match:'"lastReply"',steps:[{text:'{"status":"done","remaining":"","correction":""}'}]},
  {match:'保存按钮',steps:[{tool:{name:'click',args:{target:'loc=css:#save'}}},{text:'保存按钮已点击。'}]},
]);
const site = createServer((_q,r)=>r.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<!doctype html><title>语音来源边界</title><button id="save" onclick="window.clicks++">保存</button><script>window.clicks=0</script>'));
await new Promise<void>(r=>site.listen(0,'127.0.0.1',r));
const port=(site.address() as {port:number}).port;
const key=(await readFile(join(homedir(),'.sideagent/step-plan.key'),'utf8')).trim();
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined, panelSession: string | undefined;
let stopVideo:(()=>Promise<string|null>)|null=null, video:string|null=null, error:string|null=null;
const wire:Array<{direction:string;at:number;type:string;responseId?:string;transcript?:string;inputText?:string}>=[];
const sockets:string[]=[];
let evidence: Record<string,unknown>={};
try {
  rp=await launchRealPath({microphoneWav:wav});
  const blank=await until(async()=>(await rp!.targets()).find(t=>t.type==='page'&&t.url==='about:blank'),10000,'fixture');
  const page=await rp.attach(blank.targetId);
  await rp.cdp.send('Page.navigate',{url:`http://127.0.0.1:${port}/`},page);
  await until(async()=>await rp!.evaluate(page,'!!document.querySelector("#save")'),10000,'fixture loaded');
  const panel=await rp.attach(await rp.openSidePanel()); panelSession=panel;
  await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);
  const plan={providerId:'custom',modelId:'demo-model',baseUrl:model.baseUrl,credential:{type:'api_key',key:'local-demo-no-secret'}};
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({...modelStorageItems(plan),inproc_voice_key:key,inproc_voice_model:'stepaudio-2.5-realtime'})})`);
  await until(async()=>await rp!.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.getAttribute("aria-busy")!=="true"'),60000,'assistant ready');
  const target=await until(async()=>(await rp!.targets()).find(t=>t.url.endsWith('/inproc.html')),10000,'real offscreen');
  const off=await rp.attach(target.targetId); await rp.cdp.send('Network.enable',{},off);
  await rp.evaluate(off,`(() => {
    window.__mutations=[]; const add=WebSocket.prototype.addEventListener, mode=${JSON.stringify(name)};
    WebSocket.prototype.addEventListener=function(type,listener,...rest){
      if(type!=='message'||typeof listener!=='function')return add.call(this,type,listener,...rest);
      let heard=false, hasAudio=false; const pending=[];
      const release=()=>{
        if(!heard||!hasAudio)return;
        for(const p of pending.splice(0)){p.record.deliveredAt=Date.now();listener.call(p.receiver,p.event);}
      };
      return add.call(this,type,function(event){
        const f=JSON.parse(event.data);
        if(!f.type.startsWith('response.')){
          if(mode==='unknown-output'&&f.type==='conversation.item.input_audio_transcription.completed')heard=true;
          const result=listener.call(this,event);release();return result;
        }
        const id=f.response_id??f.response?.id??null;
        const record={type:f.type,responseId:id,receivedAt:Date.now(),deliveredAt:null,operation:'none'};
        window.__mutations.push(record);
        if(mode==='source-timeout'||(mode==='unknown-output'&&f.type==='response.created')){record.operation='drop';return;}
        if(mode==='unknown-output'){
          record.operation='buffer-until-real-asr-and-audio';pending.push({record,event,receiver:this});
          if(f.type==='response.audio.delta')hasAudio=true;
          release();return;
        }
        if(mode==='delayed-created'){
          record.operation='delay';setTimeout(()=>{record.deliveredAt=Date.now();listener.call(this,event);},6000);return;
        }
        record.deliveredAt=Date.now();return listener.call(this,event);
      },...rest);
    };return true;
  })()`);
  rp.cdp.onEvent('Network.webSocketCreated',(m:any)=>{if(m.sessionId===off)sockets.push(m.params.url);});
  for(const [event,direction] of [['Network.webSocketFrameSent','sent'],['Network.webSocketFrameReceived','received']])rp.cdp.onEvent(event!,(m:any)=>{
    if(m.sessionId!==off)return;
    try{const f=JSON.parse(m.params.response.payloadData);wire.push({direction:direction!,at:Date.now(),type:f.type,responseId:f.response_id??f.response?.id,transcript:f.transcript,inputText:f.item?.content?.find((p:{type:string})=>p.type==='input_text')?.text});}catch{}
  });
  await rp.evaluate(panel,`(() => {
    window.__output=[];window.__displayedTexts=[];
    new MutationObserver(()=>{const text=document.querySelector('.voice-answer')?.textContent;if(text)window.__displayedTexts.push({at:Date.now(),text});}).observe(document.body,{subtree:true,childList:true,characterData:true});
    const connect=AudioNode.prototype.connect;
    AudioNode.prototype.connect=function(target,...rest){
      if(this instanceof AnalyserNode&&target instanceof AudioDestinationNode&&!this.__meter){
        this.__meter=true;const tap=this.context.createAnalyser();connect.call(this,tap);const b=new Float32Array(tap.fftSize);
        window.__meterTimer=setInterval(()=>{tap.getFloatTimeDomainData(b);if(Math.sqrt(b.reduce((s,v)=>s+v*v,0)/b.length)>0.001)window.__output.push(Date.now());},20);
      }return connect.call(this,target,...rest);
    };return true;
  })()`);
  stopVideo=await recordScreen(rp.cdp,panel,join(out,'panel.mp4')).catch(()=>null);
  await rp.click(panel,'.voice-start');
  await until(async()=>wire.some(e=>e.type==='conversation.item.input_audio_transcription.completed'),45000,'real final ASR');
  const heard=wire.find(e=>e.type==='conversation.item.input_audio_transcription.completed')?.transcript??'';
  assert.equal(heard.replace(/[\p{P}\s]/gu,''),phrase.replace(/[\p{P}\s]/gu,''),'真实ASR不得添加或替换任务要求');
  if(name!=='unknown-output')await until(async()=>Number(await rp!.evaluate(page,'window.clicks'))===1,30000,'accepted task actually executes once');
  if(name==='delayed-created') await until(async()=>{
    const notice=wire.find(e=>e.direction==='sent'&&e.type==='conversation.item.create'&&e.inputText?.includes('保存按钮已点击'));
    const response=notice&&wire.find(e=>e.type==='response.created'&&e.at>=notice.at);
    if(!response)return false;
    return rp!.evaluate(off,`window.__mutations.find(m=>m.type==='response.created'&&m.responseId===${JSON.stringify(response.responseId)})?.deliveredAt`).then(async at=>at && await rp!.evaluate(panel,`window.__output.some(t=>t>=${at})`));
  },45000,'source resolves and final task result actually plays');
  else await sleep(name==='source-timeout'?24000:5000);
  const mutations=await rp.evaluate(off,'window.__mutations') as Array<{type:string;responseId:string;receivedAt:number;deliveredAt:number|null;operation:string}>;
  const clicks=await rp.evaluate(page,'window.clicks');
  const played=await rp.evaluate(panel,'window.__output') as number[];
  const displayedTexts=await rp.evaluate(panel,'window.__displayedTexts') as Array<{at:number;text:string}>;
  const text=String(await rp.evaluate(panel,'document.body.innerText'));
  const acceptedNotice=wire.find(e=>e.direction==='sent'&&e.type==='conversation.item.create'&&e.inputText?.includes('保存按钮已点击'));
  evidence={mutations,clicks,played,displayedTexts,text,acceptedNotice};
  assert.ok(wire.some(e=>e.type==='response.audio.delta'),'真实供应商确实产生音频，不能把无音频当保护通过');
  if(name==='unknown-output') assert.ok(mutations.some(m=>m.type==='response.audio.delta'&&m.deliveredAt!==null),'真实音频确实尝试交给应用，不能仅丢全部帧而通过');
  assert.equal(clicks,name==='unknown-output'?0:1,'不取消已接收任务，不重复或新增点击');
  assert.ok(sockets.length>0&&sockets.every(s=>s==='wss://api.stepfun.com/step_plan/v1/realtime?model=stepaudio-2.5-realtime'),'没有按量回退');
  if(name==='delayed-created'){
    const firstCreated=mutations.find(m=>m.type==='response.created'&&m.deliveredAt!==null);
    assert.ok(firstCreated,'真实自动created最终交给应用');
    assert.ok(acceptedNotice,'恢复后正式结果不会永久扣住');
    assert.ok(wire.filter(e=>e.direction==='sent'&&(e.type==='response.create'||e.type==='conversation.item.create')).every(e=>e.at>=firstCreated!.deliveredAt!),'来源未解决时不能发送通知或主动请求回复');
    const reply=wire.find(e=>e.type==='response.created'&&e.at>=acceptedNotice!.at);
    const deliveredReply=mutations.find(m=>m.type==='response.created'&&m.responseId===reply?.responseId);
    assert.ok(deliveredReply?.deliveredAt,'正式通知回复来源真实确认');
    const firstNotice=wire.find(e=>e.direction==='sent'&&e.type==='conversation.item.create'&&e.inputText?.startsWith('【系统通知】'));
    const firstReply=firstNotice&&wire.find(e=>e.type==='response.created'&&e.at>=firstNotice.at);
    const firstDelivered=mutations.find(m=>m.type==='response.created'&&m.responseId===firstReply?.responseId);
    assert.ok(firstDelivered?.deliveredAt,'接收请求的回执与最终结果都是宿主真实通知，不是原生空头承诺');
    assert.ok(played.length>0&&played.every(at=>at>=firstDelivered!.deliveredAt!),'只有已确认的宿主通知可以播放');
    assert.ok(played.some(at=>at>=deliveredReply!.deliveredAt!),'最终结果也实际播放');
    const normalize=(s:string)=>s.replace(/[\p{P}\s]/gu,'');
    assert.ok(displayedTexts.filter(t=>t.at<firstDelivered!.deliveredAt!).every(t=>normalize(t.text)==='保存按钮已点击'),'原生回复确认前只能显示助手已实际完成的结果，不能露出原生承诺');
  }else{
    assert.equal(played.length,0,'未知来源的真实音频不播放');
    if(name==='unknown-output')assert.equal(displayedTexts.length,0,'未知来源的真实文字不显示');
    else assert.ok(displayedTexts.every(t=>t.text.replace(/[\p{P}\s]/gu,'')==='保存按钮已点击'),'已经执行的任务结果保留，但未知来源的原生文字不显示');
    assert.match(text,/来源.*(?:确认|不明)|重新开启语音/,'来源问题必须有可见说明');
    assert.ok(!acceptedNotice,'来源未解决不能猜通知回复身份');
  }
  await rp.screenshot(panel,join(out,'panel.png'));
}catch(e){error=e instanceof Error?e.stack??e.message:String(e);if(rp&&panelSession)await rp.screenshot(panelSession,join(out,'failure.png')).catch(()=>{});}
finally{
  if(rp&&panelSession)await exportDiagnosticsViaSettings(rp,rp.extensionId,join(out,'downloads')).catch(()=>{});
  video=await stopVideo?.().catch(()=>null)??null;
  await writeFile(join(out,'summary.json'),JSON.stringify({status:error?'FAIL':'PASS',case:name,dependency:'real StepPlan frames, metadata fault injection only; scripted classifier/assistant',phrase,evidence,sockets,wire,modelRequests:model.requests,video,error},null,2));
  await rp?.close();await rp?.remove();await model.close();site.closeAllConnections();site.close();
}
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error:error?.split('\n')[0]??null}));if(error)process.exitCode=1;
