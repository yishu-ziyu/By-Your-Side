/** Synthetic PCM -> real Step ASR -> real manager/Pi -> real TTS -> production
 * VoicePlayer in isolated headless Chrome. No human microphone or personal tabs.
 * Transport is a harness bridge, not the installed native-host/sidepanel transport.
 */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {VoiceService,readStepVoiceKey} from '../../agent/src/voice-service.js';
import {StepVoiceSession} from '../../agent/src/voice-session.js';
import {launchIsolatedExtension,sleep,until} from './isolated-extension.mts';
import type {ServerMessage} from '../../shared/protocol.js';

if(!process.argv.includes('--headless'))throw Error('Required --headless');
const out=resolve('out/acceptance',`voice-greeting-live-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(out,{recursive:true});
const model='opencode-go/deepseek-flash';
const sourcePaths=['agent/src/session.ts','agent/src/voice-session.ts','agent/src/conversation-manager.ts','agent/src/voice-model.ts','agent/src/voice-intent.ts','agent/src/voice-turn.ts','shared/voice.ts','agent/src/voice-receipt.ts','agent/src/voice-service.ts','agent/src/prompt.ts','extension/src/sidepanel/voice-player.ts'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
const loadedHashes=await sourceHashes();
const report:any={scope:'Synthetic PCM; real ASR, classifier, Pi, TTS and production VoicePlayer; isolated Chrome; harness transport; no human microphone',model,cases:[],ok:false};
const browser=await launchIsolatedExtension();
const events:any[]=[];const frames=new Map<number,Buffer[]>();
let manager:ConversationManager|undefined,voice:VoiceService|undefined,playerTarget='';
let playbackWork=Promise.resolve();let playbackError:unknown;let turn=0;const voiceId=randomUUID();
const consume=(msg:ServerMessage)=>{
  const safe=msg.type==='voice'&&msg.event.kind==='audio'?{...msg,event:{...msg.event,data:undefined,bytes:Buffer.from(msg.event.data,'base64').length}}:msg;
  events.push({at:Date.now(),msg:safe});
  if(msg.type!=='voice')return;
  const e=msg.event;
  if(e.kind==='audio'){const list=frames.get(e.turn)??[];list.push(Buffer.from(e.data,'base64'));frames.set(e.turn,list);}
  if(['audio','reset_output','response_end'].includes(e.kind))playbackWork=playbackWork.then(()=>browser.evalIn(playerTarget,`globalThis.receiveVoice(${JSON.stringify(e)})`)).then(()=>{}).catch(err=>{playbackError=err;});
};
try{
  const fixture=await browser.newTarget(`${browser.fixtureOrigin}/job-fixture`);
  await until(async()=>await browser.evalIn(fixture,"document.readyState==='complete'")?true:undefined,10000,'fixture');
  await browser.evalIn(fixture,`document.title='招聘页面验收';document.body.innerHTML='<h1>AI Builder 招聘</h1><p>工作地点：深圳。要求三年经验。</p><label>姓名<input id="name" aria-label="姓名"></label>'`);
  const tab=await browser.swEval(`chrome.tabs.query({}).then(ts=>ts.find(t=>t.url===${JSON.stringify(`${browser.fixtureOrigin}/job-fixture`)}))`);
  const context={tabId:tab.id,title:tab.title,url:tab.url};
  playerTarget=await browser.newTarget(`${browser.fixtureOrigin}/player`);
  await until(async()=>await browser.evalIn(playerTarget,"document.readyState==='complete'")?true:undefined,10000,'player');
  const bundle=await build({stdin:{contents:"export {VoicePlayer} from './extension/src/sidepanel/voice-player.ts'",resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'ProductionPlayer',platform:'browser'});
  await browser.evalIn(playerTarget,bundle.outputFiles![0]!.text);
  await browser.evalIn(playerTarget,`(async()=>{globalThis.audioContext=new AudioContext({sampleRate:24000});await audioContext.resume();globalThis.played=[];globalThis.player=new ProductionPlayer.VoicePlayer(audioContext,id=>played.push({id,at:Date.now()}));globalThis.receiveVoice=e=>{if(e.kind==='audio')player.enqueue(e);else if(e.kind==='reset_output')player.begin(e.turn);else if(e.kind==='response_end')player.responseEnd(e.responseId);};})()`);
  manager=new ConversationManager(async(id,emit)=>{
    return createConversationRuntime(id,emit,model);
  },msg=>{
    voice?.observe(msg);consume(msg);
    if(msg.type==='tool_call'){
      void browser.tool(msg.name,msg.params,msg.sessionId??'main').then(result=>manager!.handleMessage({type:'tool_result',conversationId:msg.conversationId,id:msg.id,ok:result.ok,data:result.data,error:result.error,executionFact:result.executionFact} as any)).catch(error=>manager!.handleMessage({type:'tool_result',conversationId:msg.conversationId,id:msg.id,ok:false,error:String(error)}));
    }
    if(msg.type==='task_control'){
      // 测试台在这里扮演扩展的控制闸门，只为让"喊停"这条路走完、好量回执多久出声。
      // 它不检验授权、页面归属与执行版本，也不代表页面真的停了——那些由原生验收脚本覆盖。
      // 第一版没有这段应答，结果管理器一直等扩展确认（45 秒），语音层先到 30 秒报超时，
      // 看起来像"喊停没声音"的产品缺陷，实际是测试台缺应答。见 docs/evals/20260914-voice-stop-and-ruler.md。
      manager!.handleMessage({type:'task_control_result',requestId:msg.requestId,action:msg.action,runId:msg.runId,ok:true} as any);
    }
  });
  const entry=await manager.ensureDefault();assert.ok(entry.runtime.session.available,'real Pi model available');
  report.actualModel=entry.runtime.session.modelName();
  voice=new VoiceService(id=>manager!.getTaskProgress(id),consume,undefined,undefined,undefined,
    (id,text,started,stillCurrent,ctx)=>manager!.routeVoiceInput(id,text,started,stillCurrent,ctx),
    (name,fields)=>events.push({at:Date.now(),diagnostic:name,fields}),()=>manager!.voiceTargets(),
    (id,delivery,status)=>manager!.markDeliveryPlayback(id,delivery,status),(id,text,run)=>manager!.recordSpokenAck(id,text,run));
  const command=async(command:any)=>voice!.handle('default',{type:'voice',voiceId,command});
  await command({kind:'start'});
  await until(async()=>events.some(x=>x.msg?.type==='voice'&&x.msg.event.kind==='state'&&x.msg.event.state==='ready')?true:undefined,25000,'voice ready');
  let drained=0;
  async function drain(){
    await playbackWork;if(playbackError)throw playbackError;
    const played=await browser.evalIn(playerTarget,'played');
    for(const item of played.slice(drained)){await command({kind:'playback_done',responseId:item.id});events.push({at:Date.now(),playerDrained:item.id});}
    drained=played.length;
  }
  /** 只把这句话说完，不等回答。用于"说完不等它答完"的场景，例如任务还在跑的时候插话。 */
  async function send(text:string){
    const current=++turn,start=Date.now();
    execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',`${out}/input-${turn}.aiff`,text]);
    execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',`${out}/input-${turn}.aiff`,'-ar','24000','-ac','1','-f','s16le',`${out}/input-${turn}.pcm`]);
    const speech=await readFile(`${out}/input-${turn}.pcm`);
    const pcm=Buffer.concat([speech,Buffer.alloc(24000)]);
    await command({kind:'interrupt',turn});
    // 两个计时起点，别混：
    // - speechEnd = 真人"说完"那一刻。脚本按 100ms/4800B 实时送真实语音，最后一帧送出即话音结束。
    // - commitAt  = 应用收到"这句说完了"那一刻。
    // 中间补的 24000 字节（24kHz/16bit = 500ms 静音）是喂给服务端收尾用的，属于用户等待，不算说话。
    // 真人端的停句判断（服务端多久认定你说完了）本脚本测不到，真人验收时另计。
    let speechEnd=0;
    for(let offset=0;offset<pcm.length;offset+=4800){
      await command({kind:'audio',turn,data:pcm.subarray(offset,offset+4800).toString('base64')});
      if(offset+4800>=speech.length&&!speechEnd)speechEnd=Date.now();
      await sleep(100);
    }
    await command({kind:'commit',turn,input:{context}});
    return {current,start,speechEnd,commitAt:Date.now()};
  }
  /** 等这一轮说完并收集结果。 */
  async function settle(sent:{current:number;start:number;speechEnd:number;commitAt:number},text:string){
    const {current,start,speechEnd,commitAt}=sent;
    await until(async()=>{
      await drain();
      const own=events.filter(x=>x.at>=start&&x.msg?.type==='voice'&&x.msg.event.turn===current).map(x=>x.msg.event);
      const ends=own.filter(e=>e.kind==='response_end');
      const state=manager!.getTaskProgress('default');
      const completed=new Set(events.filter(x=>x.at>=start&&x.playerDrained).map(x=>x.playerDrained));
      const error=events.find(x=>x.at>=start&&x.msg?.type==='voice'&&x.msg.event.kind==='state'&&x.msg.event.state==='error');
      if(error)throw Error(error.msg.event.detail);
      if(events.some(x=>x.at>=start&&x.diagnostic==='tts_failed'))throw Error('TTS failed before completing the answer');
      return ends.length&&ends.every(e=>completed.has(e.responseId))&&state?.state!=='running'?true:undefined;
    },90000,'complete spoken answer');
    await sleep(1200);await drain();
    const own=events.filter(x=>x.at>=start&&x.msg?.type==='voice'&&x.msg.event.turn===current);
    const textEvents=own.filter(x=>x.msg.event.kind==='text');
    const textUpdates=textEvents.filter(x=>x.msg.event.role==='assistant').map(x=>x.msg.event.text);
    const cumulative=textUpdates.every((text,index)=>index===0||text.startsWith(textUpdates[index-1]));
    const answer=cumulative&&textUpdates.length?[textUpdates.at(-1)]:textUpdates;
    const audio=Buffer.concat(frames.get(current)??[]);let energy=0;for(let i=0;i<audio.length;i+=2)energy+=audio.readInt16LE(i)**2;
    const branch=events.filter(x=>x.at>=start&&x.diagnostic==='prepare_result'&&x.fields?.turn===current).map(x=>String(x.fields?.branch??'none')).at(-1)??'none';
    const protocol=events.filter(x=>x.at>=start&&x.diagnostic==='prepare_result'&&x.fields?.turn===current).map(x=>String(x.fields?.protocol??'none')).at(-1)??'none';
    const firstAudioAt=own.find(x=>x.msg.event.kind==='audio')?.at;
    const result={turn:current,input:text,branch,protocol,textUpdates,cumulative,recognized:textEvents.filter(x=>x.msg.event.role==='user').map(x=>x.msg.event.text),answer,responses:own.filter(x=>x.msg.event.kind==='response_end').map(x=>x.msg.event.responseId),audioBytes:audio.length,rms:audio.length?Math.sqrt(energy/(audio.length/2))/32768:0,
      // 体验口径：说完话 → 听到第一声。版本对照用上面这个（同一套送法，可比）。
      userWaitMs:firstAudioAt?firstAudioAt-speechEnd:undefined,
      // 工程口径：应用收到"说完了" → 出第一帧音频。
      firstAudioMs:firstAudioAt?firstAudioAt-commitAt:undefined};
    await writeFile(`${out}/output-${current}.pcm`,audio);
    if(audio.length)execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-f','s16le','-ar','24000','-ac','1','-i',`${out}/output-${current}.pcm`,`${out}/output-${current}.wav`]);
    report.cases.push(result);console.log(JSON.stringify(result));
    assert.ok(result.audioBytes>0&&result.rms>0.001,'non-silent audio drained by production player');
    return result;
  }
  async function speak(text:string){return settle(await send(text),text);}
  if(process.argv.includes('--post-page-greeting')){
    // Supply the fixture excerpt to isolate the transition back to chat.
    // Natural page reading is checked in the four-case mode separately.
    const reading=await speak('页面写着工作地点深圳，要求三年经验。请简短确认要求是几年。');
    assert.ok(/三年|3年/.test(reading.answer.join('')),'page-content history setup');
    const greeting=await speak('嗨，晚上好。');
    assert.equal(greeting.responses.length,1,'one greeting after a page answer');
    assert.equal(greeting.answer.length,1);
    assert.ok(greeting.answer.join('').length<=55&&!/任务已收到|深圳|三年|3年|经验/.test(greeting.answer.join('')),'brief greeting may refer to the shared topic but must not reintroduce page facts');
  }else{
  for(const greeting of ['嗨，晚上好。','你好。']){
    const r=await speak(greeting);assert.equal(r.responses.length,1,'one spoken response');
    assert.ok(r.answer.length===1,'one answer text');
    assert.ok(!/任务已收到|招聘|Builder|深圳|岗位/.test(r.answer.join('')),'greeting stays conversational');
  }
  const knowledge=await speak('十加七等于多少？');assert.ok(/17|十七/.test(knowledge.answer.join('')),'knowledge answer');assert.equal(knowledge.responses.length,1);
  const reading=await speak('当前招聘页面要求几年经验？');assert.ok(/三年|3年/.test(reading.answer.join('')),'page question retains browser context');
  // 控制句轮次：同一口径报首声。闲置态下"暂停任务"与"继续"都得到确定的拒绝回执，
  // 但都必须先过判定与控制链前的固定成本，用来核对第 8 条不因合并变慢。
  for(const control of ['暂停任务','继续']){
    const r=await speak(control);
    assert.equal(r.responses.length,1,`one spoken control receipt for ${control}`);
    assert.equal(r.branch,'control',`control sentence stays on the control branch: ${control}`);
    assert.ok(r.audioBytes>0&&r.rms>0.001,`control receipt spoken aloud: ${control}`);
  }
  // 运行中的控制：先起一个真任务，趁它还在跑的时候说"暂停任务"。
  // 闲置态的"暂停任务"只会得到一句"没有正在执行的任务"，测不出"能不能真的停住"。
  // 这一轮量两件事：说完话 → 听到回执；以及任务是不是真的停了（不是只念一句没用的话）。
  // 任务在暂停落地前就跑完时，回执会明说"没有正在执行的任务"——那种情况下这一轮没被真正测到，
  // 必须换更长的任务重来；都不成就判失败，不能因为"状态不是 running"而假过。
  {
    const tasks=[
      '把当前页面里每一句话都逐条读出来，读完再总结一句。',
      '把当前页面里每一句话都逐条读出来，然后写一段一百字的介绍，再逐句翻译成英文。',
      '把当前页面里每一句话都逐条读出来，写一段一百字的介绍，逐句翻译成英文，最后核对一遍有没有漏掉的话。',
    ];
    let exercised:{task:string;receipt:any;stateAfterPause:string|null}|null=null;
    for(const [index,runningTask] of tasks.entries()){
      await send(runningTask);
      const entered=await until(async()=>manager!.getTaskProgress('default')?.state==='running'?true:undefined,60000,'说暂停之前任务已进入运行').catch(()=>undefined);
      if(!entered){
        await until(async()=>manager!.getTaskProgress('default')?.state!=='running'?true:undefined,90000,'上一轮任务结束').catch(()=>undefined);
        continue;
      }
      const receipt=await speak('暂停任务');
      const after=manager!.getTaskProgress('default');
      if(/没有正在执行的任务|没有正在运行的任务/.test(receipt.answer.join(''))){
        await until(async()=>manager!.getTaskProgress('default')?.state!=='running'?true:undefined,90000,'上一轮任务结束').catch(()=>undefined);
        report.controlWhileRunningAttempts=(report.controlWhileRunningAttempts??[]).concat([{task:runningTask,missed:'任务在暂停落地前已结束'}]);
        continue;
      }
      exercised={task:runningTask,receipt,stateAfterPause:after?.state??null};
      if(index>0)report.controlWhileRunningAttempts=(report.controlWhileRunningAttempts??[]).concat([{task:tasks[index-1],missed:'任务在暂停落地前已结束'}]);
      break;
    }
    report.controlWhileRunning=exercised??{exercised:false,note:'三次都没能在任务运行中说成暂停'};
    assert.ok(exercised,'运行中暂停没有被真正测到（任务在暂停落地前就结束了）');
    assert.equal(exercised!.receipt.responses.length,1,'运行中的暂停只播一份回执');
    assert.ok(exercised!.receipt.audioBytes>0&&exercised!.receipt.rms>0.001,'运行中的暂停回执有声音');
    // 这里**不**断言"页面真的停了"：本测试台把控制闸门的应答替成了"已受理"，
    // 所以它只能证明回执出不出声、多久出声。真实停住（授权、页面归属、执行版本、
    // 之后不再写入）由原生验收脚本覆盖，不在这里冒充。
    assert.ok(exercised!.stateAfterPause!=='running','控制受理后本会话不再处于运行态');
  }
  }
  // Independently transcribe the returned greeting PCM. Non-routing diagnostic
  // session only: verifies spoken content, not just nonzero waveform energy.
  let readback='',readbackReady=false;
  const listener=new StepVoiceSession({diagnosticMode:true,
    getSnapshot:()=>manager!.getTaskProgress('default'),
    emit:e=>{if(e.kind==='state'&&e.state==='ready')readbackReady=true;if(e.kind==='text'&&e.role==='user')readback=e.text;}});
  try{
    listener.start(await readStepVoiceKey());
    await until(async()=>readbackReady?true:undefined,25000,'audio readback ready');
    listener.command({kind:'interrupt',turn:1});
    const greetingTurn=report.cases.find((c:any)=>c.input==='嗨，晚上好。').turn;
    const pcm=Buffer.concat([await readFile(`${out}/output-${greetingTurn}.pcm`),Buffer.alloc(24000)]);
    for(let i=0;i<pcm.length;i+=4800){listener.command({kind:'audio',turn:1,data:pcm.subarray(i,i+4800).toString('base64')});await sleep(100);}
    listener.command({kind:'commit',turn:1});
    await until(async()=>readback||undefined,20000,'spoken greeting readback');
    report.spokenGreetingReadback=readback;
    assert.ok(/晚上好/.test(readback)&&!/任务已收到|招聘|岗位|深圳/.test(readback),'actual greeting audio matches the conversational answer');
  }finally{listener.close();}
  report.branchFirstAudioMs=Object.fromEntries(['reply','control','read_only','none'].map(branch=>[branch,report.cases.filter((c:any)=>c.branch===branch).map((c:any)=>c.firstAudioMs)]));
  report.branchUserWaitMs=Object.fromEntries(['reply','control','read_only','none'].map(branch=>[branch,report.cases.filter((c:any)=>c.branch===branch).map((c:any)=>c.userWaitMs)]));
  report.ok=true;
} catch(error){report.error=String(error);process.exitCode=1;}
finally{
  voice?.close();manager?.dispose();await playbackWork;
  report.events=events;
  report.sourceHashes=loadedHashes;report.finalSourceHashes=await sourceHashes();
  report.sourceStable=JSON.stringify(loadedHashes)===JSON.stringify(report.finalSourceHashes);
  if(!report.sourceStable){report.ok=false;report.error='Source changed during verification';process.exitCode=1;}
  await writeFile(`${out}/result.json`,JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({out,ok:report.ok,error:report.error}));
}
