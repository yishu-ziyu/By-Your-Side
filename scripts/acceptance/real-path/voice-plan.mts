/** Real isolated sidebar + real Step Plan audio. Only assistant/classifier responses are scripted.
 * npx tsx scripts/acceptance/real-path/voice-plan.mts --headless --case=chat|task|failure|timeout|cancel|new-speech|missing-asr-id|missing-vad-id|missing-transcript
 * Oracle: fixture click count; independent output audio meter; actual provider config and ASR.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, recordScreen, sleep, until, exportDiagnosticsViaSettings } from './harness.mts';
import { modelStorageItems, loadModelPlan } from './inproc-config.mts';
import { startScriptedModel, type Rule } from './scripted-model.mts';
requireHeadless();
const name = process.argv.find(a => a.startsWith('--case='))?.slice(7) ?? 'chat';
assert.ok(['chat','task','failure','timeout','cancel','new-speech','missing-asr-id','missing-vad-id','missing-transcript'].includes(name));
const missingSource = name === 'missing-asr-id' || name === 'missing-vad-id';
const noDispatch = name === 'failure' || name === 'timeout' || name === 'cancel' || missingSource || name === 'missing-transcript';
const realModel = process.argv.find(a => a.startsWith('--model='))?.slice(8);
if (realModel) assert.ok(['chat','task'].includes(name), '真实分类仅用于正常闲聊/任务；故障夹具不要改用真实服务');
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g,'-')}-voice-plan-${name}`);
await mkdir(out, { recursive: true });
const phrase = name === 'chat' ? '你好，陪我聊聊今天的心情。' : '帮我点击这个网页上的保存按钮。';
const followup = '你好，陪我聊聊今天的心情。';
const wav = join(out, 'microphone.wav');
execFileSync('say', ['-v','Tingting','-o',wav,'--data-format=LEI16@24000',name === 'new-speech' ? `[[slnc 7000]]${phrase}[[slnc 4000]]${followup}[[slnc 18000]]` : `[[slnc 7000]]${phrase}[[slnc 18000]]`]);
const rules: Rule[] = [
  ...(name === 'new-speech' ? [{match: '"text":"你好', steps: [{text:'{"steps":[{"action":"chat","target":null}]}',delayMs:2000}]}] : []),
  { match: '"clauses"', steps: [name === 'failure' ? { status: 500, body: '{"error":{"message":"fixture classifier unavailable"}}' } : { text: JSON.stringify({ steps: [{ action: name === 'chat' ? 'chat' : 'start', target: null }] }), delayMs: name === 'timeout' ? 27000 : name === 'cancel' || name === 'new-speech' ? 7000 : 2000 }] },
  { match: '"lastReply"', steps: [{text:'{"status":"done","remaining":"","correction":""}'}] },
  { match: '保存按钮', steps: [{tool:{name:'click',args:{target:'loc=css:#save'}}},{text:'保存按钮已点击。'}] },
];
const model = realModel ? null : await startScriptedModel(rules);
const plan = realModel ? await loadModelPlan(realModel) : {providerId:"custom",modelId:"demo-model",baseUrl:model!.baseUrl,credential:{type:"api_key",key:"local-demo-no-secret"}};
const site = createServer((_q,r) => r.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><title>套餐语音练习页</title><button id="save" onclick="window.clicks++">保存</button><script>window.clicks=0</script>'));
await new Promise<void>(r => site.listen(0,'127.0.0.1',r));
const port = (site.address() as {port:number}).port;
const key = (await readFile(join(homedir(),'.sideagent/step-plan.key'),'utf8')).trim();
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let panelSession: string | undefined;
let stopVideo: (() => Promise<string|null>) | null = null;
let error: string | null = null, video: string | null = null;
const wire: Array<{direction:string;at:number;type:string;responseId?:string;itemId?:string;transcript?:string;inputText?:string;errorMessage?:string}> = [];
const sockets: string[] = [], configs: unknown[] = [];
let evidence: Record<string,unknown> = {};
try {
  rp = await launchRealPath({ microphoneWav: wav });
  const blank = await until(async () => (await rp!.targets()).find(t => t.type==='page' && t.url==='about:blank'),10000,'fixture tab');
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send('Page.navigate',{url:`http://127.0.0.1:${port}/`},page);
  await until(async () => await rp!.evaluate(page,'!!document.querySelector("#save")'),10000,'fixture loaded');
  const panel = await rp.attach(await rp.openSidePanel());
  panelSession = panel;
  await rp.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true},panel);
  await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify({...modelStorageItems(plan),inproc_voice_key:key,inproc_voice_model:'stepaudio-2.5-realtime'})})`);
  await until(async () => await rp!.evaluate(panel,'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.getAttribute("aria-busy")!=="true"'),60000,'assistant ready');
  const target = await until(async () => (await rp!.targets()).find(t=>t.url.endsWith('/inproc.html')),10000,'real offscreen');
  const off = await rp.attach(target.targetId);
  await rp.cdp.send('Network.enable',{},off);
  // 元数据故障注入：真实服务商帧保持在CDP证据里；应用收到的消息只删一个来源字段或丢最终转写。
  if (missingSource || name === 'missing-transcript') await rp.evaluate(off, `(() => {
    window.__mutations=[]; const add=WebSocket.prototype.addEventListener, send=WebSocket.prototype.send;
    const delayedCancels=[], completed=new WeakSet();
    // 延迟真实取消直到服务商生成结束，稳定复现真实的 no ongoing response 提示。
    WebSocket.prototype.send=function(data){
      if(${JSON.stringify(name)}==='missing-vad-id' && JSON.parse(data).type==='response.cancel' && !completed.has(this)){
        delayedCancels.push({socket:this,data});return;
      }
      return send.call(this,data);
    };
    WebSocket.prototype.addEventListener=function(type,listener,...rest){
      if(type!=='message'||typeof listener!=='function')return add.call(this,type,listener,...rest);
      return add.call(this,type,function(event){
        const frame=JSON.parse(event.data), mode=${JSON.stringify(name)};
        if(frame.type==='response.done'){
          completed.add(this);
          for(const pending of delayedCancels.splice(0))send.call(pending.socket,pending.data);
        }
        const target=mode==='missing-vad-id'?'input_audio_buffer.speech_started':'conversation.item.input_audio_transcription.completed';
        if(frame.type===target){
          window.__mutations.push({type:frame.type,originalItemId:frame.item_id??null});
          if(mode==='missing-transcript')return;
          delete frame.item_id;
          return listener.call(this,new MessageEvent('message',{data:JSON.stringify(frame),origin:event.origin}));
        }
        return listener.call(this,event);
      },...rest);
    };return true;
  })()`);
  rp.cdp.onEvent('Network.webSocketCreated',(m:any)=>{if(m.sessionId===off)sockets.push(m.params.url);});
  for (const [event,direction] of [['Network.webSocketFrameSent','sent'],['Network.webSocketFrameReceived','received']]) rp.cdp.onEvent(event!,(m:any)=>{
    if(m.sessionId!==off)return;
    try { const e=JSON.parse(m.params.response.payloadData); if(e.type==='session.update')configs.push(e.session); wire.push({direction:direction!,at:Date.now(),type:e.type,responseId:e.response_id??e.response?.id,itemId:e.item_id,transcript:e.transcript,inputText:e.item?.content?.find((part:{type:string})=>part.type==='input_text')?.text,errorMessage:e.error?.message}); } catch {}
  });
  // Observe actual speaker output. Do not inject playback results or provider events.
  await rp.evaluate(panel,`(() => {
    window.__output=[]; const connect=AudioNode.prototype.connect;
    AudioNode.prototype.connect=function(target,...rest){
      if(this instanceof AnalyserNode && target instanceof AudioDestinationNode && !this.__meter){
        this.__meter=true;const tap=this.context.createAnalyser();connect.call(this,tap);const buf=new Float32Array(tap.fftSize);
        window.__meterTimer=setInterval(()=>{tap.getFloatTimeDomainData(buf);const rms=Math.sqrt(buf.reduce((s,v)=>s+v*v,0)/buf.length);if(rms>0.001)window.__output.push(Date.now());},20);
      } return connect.call(this,target,...rest);
    };return true;
  })()`);
  stopVideo = await recordScreen(rp.cdp,panel,join(out,'panel.mp4')).catch(()=>null);
  await rp.click(panel,'.voice-start');
  await until(async()=>wire.some(e=>e.type==='conversation.item.input_audio_transcription.completed'),45000,'real Step Plan final ASR');
  if (model && !missingSource && name !== 'missing-transcript') await until(async()=>model.requests.some(r=>r.rule==='"clauses"'),15000,'real host classification request');
  const transcript = wire.find(e=>e.type==='conversation.item.input_audio_transcription.completed')?.transcript ?? '';
  assert.equal(transcript.replace(/[\p{P}\s]/gu,''), phrase.replace(/[\p{P}\s]/gu,''), 'ASR必须忠于说出的原话，不能增加新委托');
  const classifierStartedAt = Date.now();
  const earlyAudio = await rp.evaluate(panel,'window.__output.length');
  if (model) assert.equal(earlyAudio,0,'原生回复必须等宿主分类，不先出声');
  if(name==='cancel') await rp.click(panel,'.voice-start');
  if(name==='task') {
    await until(async()=>Number(await rp!.evaluate(page,'window.clicks'))===1,45000,'real task click');
    const finalText = model ? '保存按钮已点击' : String(await until(async()=>await rp!.evaluate(panel,"document.querySelector('#messages .msg.assistant > p')?.textContent") || undefined,45000,'formal assistant result')).split(/[。！？]/)[0]!;
    const normalize = (text: string) => text.replace(/[\p{P}\s]/gu,'');
    assert.ok(finalText.includes('保存'), '助手结果必须对应本轮保存按钮');
    const notice = await until(async()=>wire.find(e=>e.direction==='sent' && e.type==='conversation.item.create' && normalize(e.inputText??'').includes(normalize(finalText))),45000,'formal result sent to StepPlan');
    const response = await until(async()=>wire.find(e=>e.type==='response.created' && e.at>=notice.at),15000,'formal result voice response');
    await until(async()=>wire.some(e=>e.type==='response.audio_transcript.done' && e.responseId===response.responseId && !!e.transcript),30000,'formal result voice transcript');
    await until(async()=>await rp!.evaluate(panel,`window.__output.some(at=>at>=${response.at})`),15000,'formal result actually plays');
  }
  if(name==='new-speech') {
    await until(async()=>wire.filter(e=>e.type==='conversation.item.input_audio_transcription.completed').length>=2,45000,'second real utterance supersedes first');
    const second=wire.filter(e=>e.type==='conversation.item.input_audio_transcription.completed')[1]!;
    assert.equal((second.transcript??'').replace(/[\p{P}\s]/gu,''),followup.replace(/[\p{P}\s]/gu,''),'第二句实际ASR');
    await until(async()=>Number(await rp!.evaluate(panel,'window.__output.length'))>0,45000,'second native chat really plays');
    const played=await rp.evaluate(panel,'window.__output') as number[];
    assert.ok(played.every(at=>at>=second.at),'旧网页请求不能先播出原生承诺');
  }
  if(name==='chat') await until(async()=>Number(await rp!.evaluate(panel,'window.__output.length'))>0,45000,'actual native audio playback');
  await sleep(name==='timeout'?33000:name==='failure'||name==='missing-transcript'?22000:name==='cancel'?11000:4000);
  if(name==='missing-vad-id') {
    await until(async()=>wire.some(e=>e.direction==='received' && /no ongoing response to cancel/i.test(e.errorMessage??'')),30000,'真实服务商取消提示');
    await sleep(300);
  }
  const clicks = await rp.evaluate(page,'window.clicks');
  const outputAudio = await rp.evaluate(panel,'window.__output');
  const text = await rp.evaluate(panel,'document.body.textContent');
  const status = await rp.evaluate(panel,'document.querySelector(".voice-state")?.innerText ?? ""');
  const mutations = await rp.evaluate(off,'window.__mutations??[]') as Array<{type:string;originalItemId:string|null}>;
  evidence = {clicks,outputAudio,earlyAudio,classifierStartedAt,text,status,mutations};
  assert.equal(clicks,name==='task'?1:0,'只有任务场景真实点击且恰好一次');
  const config = configs[0] as {tools?:unknown[];input_audio_transcription?:{model?:string}};
  assert.deepEqual(config?.tools,[],'2.5不注册工具');
  assert.equal(config?.input_audio_transcription?.model,'stepaudio-2.5-asr');
  assert.ok(sockets.length>0 && sockets.every(url=>url==='wss://api.stepfun.com/step_plan/v1/realtime?model=stepaudio-2.5-realtime'),'无按量回退');
  if(name==='chat' && model) assert.ok(model.requests.every(r=>!r.tools),'闲聊只分类，不交主助手执行');
  if(noDispatch) assert.equal((outputAudio as unknown[]).length,0,'缺来源、分类失败或结束后不放行原生声音');
  if(name==='failure') assert.match(String(status),/分流.*失败|分流.*没有完成/,'失败原因在侧栏可见');
  if(name==='timeout') {
    assert.ok(model!.requests.some(r=>r.rule==='"clauses"' && (r.firstTextAt??0)>classifierStartedAt+20_000),'分类模型实际在保护上限之后给出结果');
    assert.match(String(status),/分流.*失败|分流.*没有完成/,'超过上限的分类返回后仍不执行，并保留可见失败说明');
  }
  if(missingSource || name==='missing-transcript') {
    assert.equal(model!.requests.length,0,'未确认来源的输入不发分类模型请求');
    assert.ok(mutations.some(m=>m.originalItemId),'原始供应商事件确实带来源，本试验没有伪造转写');
    assert.match(String(status),missingSource?/无法确认这句话属于当前语音/:/没有及时听清这句话/);
  }
  if(name==='missing-vad-id') assert.ok(wire.some(e=>e.direction==='received' && /no ongoing response to cancel/i.test(e.errorMessage??'')), '真实取消提示确实到达，不能靠未触发故障算通过');
  await rp.screenshot(panel,join(out,'panel.png'));
} catch(e) {
  error=e instanceof Error?e.stack??e.message:String(e);
  if(rp && panelSession) {
    evidence.failureView = await rp.evaluate(panelSession,"({state:document.querySelector('.voice-progress')?.dataset.state,status:document.querySelector('.voice-state')?.innerText,answer:document.querySelector('.voice-answer')?.innerText,outputAudio:window.__output,text:document.body.innerText})").catch(()=>null);
    await rp.screenshot(panelSession,join(out,'failure.png')).catch(()=>{});
    evidence.diagnostics = await exportDiagnosticsViaSettings(rp,rp.extensionId,join(out,'downloads')).catch(e=>({error:String(e)}));
  }
}
finally {
  video=await stopVideo?.().catch(()=>null)??null;
  await writeFile(join(out,'summary.json'),JSON.stringify({status:error?'FAIL':'PASS',case:name,dependency:realModel ? 'real isolated extension + real Step Plan + selected real assistant' : 'real isolated extension + real Step Plan; scripted assistant only',phrase,evidence,sockets,configs,wire,modelRequests:model?.requests??null,mainModel:realModel??"scripted",video,error},null,2));
  await rp?.close();await rp?.remove();await model?.close();site.closeAllConnections();site.close();
}
console.log(JSON.stringify({status:error?'FAIL':'PASS',out,error:error?.split('\n')[0]??null}));
if(error)process.exitCode=1;
