import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {VoiceDiagnosticLog,VOICE_DIAG_MAX_CAPTURES} from '../src/sidepanel/voice-diagnostic.js';
import {VoiceClient} from '../src/sidepanel/voice-client.js';
import {mountVoiceUI} from '../src/sidepanel/voice-ui.js';
import {parseServerMessage} from '../../shared/protocol.js';
import * as speechModule from '../src/sidepanel/voice-speech.js';

vi.mock('../src/sidepanel/voice-speech.js',()=>{
  const pushed:Int16Array[]=[];
  return {
    pushed,
    SpeechClassifier:{create:async(onFrame:(pcm:Int16Array,probability:number)=>void)=>({
      push:(pcm:Int16Array)=>{pushed.push(Int16Array.from(pcm));onFrame(pcm,0.9);},
      close:vi.fn(),
    })},
  };
});

const b64=(values:number[]):string=>Buffer.from(new Int16Array(values).buffer).toString('base64');
const samples=(pcm:Int16Array):number[]=>Array.from(pcm);

describe('diagnostic log evidence rules',()=>{
  it('survives the server-message boundary that the sidepanel really uses',()=>{
    const wrap=(record:unknown)=>parseServerMessage(JSON.stringify({type:'voice',voiceId:'v1',event:{kind:'diag',record}}));
    expect(wrap({type:'ready',sampleRate:24000,maxSeconds:60})).not.toBeNull();
    expect(wrap({type:'append',seq:1,eventId:'voice_a',turn:1,frame:0,samples:2,audio:b64([1,2])})).not.toBeNull();
    expect(wrap({type:'asr',turn:null,itemId:'item-1',outcome:'unknown',text:'x'})).not.toBeNull();
    expect(wrap({type:'gap',code:'truncated',turn:1,detail:'server-limit'})).not.toBeNull();
    expect(wrap({type:'append',seq:1,eventId:'voice_a',turn:1,frame:0,samples:2,audio:''})).toBeNull();
    expect(wrap({type:'ready',sampleRate:0,maxSeconds:60})).toBeNull();
  });
  it('takes C1 from the accepted upstream payload, not from the local candidate frame',()=>{
    const log=new VoiceDiagnosticLog();
    log.sessionStarted({voiceId:'v1',conversationId:'conv-1',diagnostic:true});
    const capture=log.captureStarted({turn:1,sampleRate:24000,track:null})!;
    log.captureFrame(new Int16Array([1000,1000]));
    log.apply({type:'append',seq:1,eventId:'voice_a',turn:1,frame:0,samples:2,audio:b64([2000,2000])});
    expect(capture.upstream[0]!.c0Match).toBe('mismatch');
    expect(samples(log.audio(capture.id,'c1')!.chunks[0]!)).toEqual([2000,2000]);
    expect(samples(log.audio(capture.id,'c0')!.chunks[0]!)).toEqual([1000,1000]);
    expect(log.status(capture).reasons).toContain('上行音频与本地连续收音不一致');
    expect(log.wav(capture.id,'c1')).not.toBeNull();
  });
  it('copies each captured frame so a later mutation cannot rewrite the record',()=>{
    const log=new VoiceDiagnosticLog();
    log.sessionStarted({voiceId:'v1',conversationId:'conv-1',diagnostic:true});
    const capture=log.captureStarted({turn:1,sampleRate:24000,track:null})!;
    const source=new Int16Array([5,6,7]);
    log.captureFrame(source);
    source.fill(0);
    expect(samples(capture.frames[0]!)).toEqual([5,6,7]);
  });
  it('keeps raw ASR, forwarded text, received event and DOM text as separate records',()=>{
    const log=new VoiceDiagnosticLog();
    log.sessionStarted({voiceId:'v1',conversationId:'conv-1',diagnostic:true});
    const capture=log.captureStarted({turn:1,sampleRate:24000,track:null})!;
    log.captureFrame(new Int16Array([1,2]));
    log.apply({type:'append',seq:1,eventId:'voice_a',turn:1,frame:0,samples:2,audio:b64([1,2])});
    log.apply({type:'commit',seq:2,eventId:'voice_b',turn:1});
    log.apply({type:'item',turn:1,itemId:'item-1'});
    log.apply({type:'asr',turn:1,itemId:'item-1',outcome:'current',text:'打开邮箱'});
    log.apply({type:'forward',turn:1,itemId:'item-1',text:'打开邮箱'});
    log.textEvent('user',1,'打开邮箱');
    log.displayText('你：打开邮箱');
    log.captureEnded('manual');
    expect(capture.rawAsr?.text).toBe('打开邮箱');
    expect(capture.forwarded?.text).toBe('打开邮箱');
    expect(capture.serverText?.text).toBe('打开邮箱');
    expect(capture.displayText?.text).toBe('你：打开邮箱');
    expect(log.checks(capture)).toEqual({rawMatchesForward:true,forwardMatchesServer:true,displayMatchesServer:true});
    expect(log.status(capture).complete).toBe(true);
    log.displayText('你：打开相册');
    expect(log.checks(capture).displayMatchesServer).toBe(false);
  });
  it('keeps the last DOM read authoritative once the turn text is rendered',()=>{
    const log=new VoiceDiagnosticLog();
    log.sessionStarted({voiceId:'v1',conversationId:'conv-1',diagnostic:true});
    log.captureStarted({turn:1,sampleRate:24000,track:null});
    log.displayText('');
    log.displayText('你：打开邮箱',true);
    log.displayText('');
    expect(log.latest()!.displayText).toMatchObject({text:'你：打开邮箱',final:true});
  });
  it('stops a take at the duration bound and reports it as truncated',()=>{
    const log=new VoiceDiagnosticLog();
    log.sessionStarted({voiceId:'v1',conversationId:'conv-1',diagnostic:true});
    const capture=log.captureStarted({turn:1,sampleRate:24000,track:null})!;
    log.confirmedBy({sampleRate:24000,maxSeconds:2});
    const frame=new Int16Array(24000);
    expect(log.captureFrame(frame)).toBe('ok');
    expect(log.captureFrame(frame)).toBe('full');
    expect(capture.samples).toBe(48000);
    expect(capture.capped).toBe(false);
    expect(log.captureFrame(frame)).toBe('full');
    expect(capture.samples).toBe(48000);
    expect(capture.capped).toBe(true);
    log.captureEnded('limit');
    expect(log.status(capture).reasons).toContain('已达时长上限，音频被截断');
    expect(log.status(capture).complete).toBe(false);
    const second=log.captureStarted({turn:2,sampleRate:24000,track:null})!;
    expect(log.captureFrame(frame)).toBe('ok');
    expect(log.captureFrame(frame)).toBe('full');
    log.captureEnded('limit');
    expect(log.status(second).reasons).toContain('已达时长上限而结束');
    expect(log.status(second).reasons).not.toContain('已达时长上限，音频被截断');
  });
  it('keeps metadata bounded and releases older audio',()=>{
    const log=new VoiceDiagnosticLog();
    log.sessionStarted({voiceId:'v1',conversationId:'conv-1',diagnostic:true});
    for(let turn=1;turn<=VOICE_DIAG_MAX_CAPTURES+2;turn++){
      log.captureStarted({turn,sampleRate:24000,track:null});
      log.captureFrame(new Int16Array([turn]));
      log.apply({type:'append',seq:turn,eventId:`voice_${turn}`,turn,frame:0,samples:1,audio:b64([turn])});
      log.captureEnded('manual');
    }
    const items=log.captures();
    expect(items).toHaveLength(VOICE_DIAG_MAX_CAPTURES);
    const withAudio=items.filter(capture=>capture.frames.length);
    expect(withAudio).toHaveLength(3);
    expect(items[0]!.upstream[0]!.audio).toBe('');
    expect(items[0]!.notes.some(note=>note.code==='audio_released')).toBe(true);
    expect(items.at(-1)!.frames).toHaveLength(1);
  });
  it('attaches a filtered transcript to the take it originally belonged to',()=>{
    const log=new VoiceDiagnosticLog();
    log.sessionStarted({voiceId:'v1',conversationId:'conv-1',diagnostic:true});
    log.captureStarted({turn:1,sampleRate:24000,track:null});
    log.captureEnded('manual');
    const second=log.captureStarted({turn:2,sampleRate:24000,track:null})!;
    log.apply({type:'asr',turn:1,itemId:'item-1',outcome:'filtered',text:'迟到的旧转写'});
    expect(log.captures()[0]!.rawAsr).toMatchObject({turn:1,outcome:'filtered',text:'迟到的旧转写'});
    expect(second.rawAsr).toBeNull();
  });
  it('exports the texts and linkage without audio bytes, and clear releases audio',()=>{
    const log=new VoiceDiagnosticLog();
    log.sessionStarted({voiceId:'v1',conversationId:'conv-1',diagnostic:true});
    const capture=log.captureStarted({turn:1,sampleRate:24000,track:null})!;
    log.captureFrame(new Int16Array([9,9]));
    log.apply({type:'append',seq:1,eventId:'voice_a',turn:1,frame:0,samples:2,audio:b64([9,9])});
    const payload=JSON.parse(log.exportJSON()) as any;
    expect(payload.captures[0].upstream[0].audio).toBeUndefined();
    expect(payload.captures[0].upstream[0].retained).toBe(true);
    expect(payload.captures[0].c1.available).toBe(true);
    const frames=capture.frames;
    log.clear();
    expect(log.captures()).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });
});

describe('diagnostic capture stays manual and confirmed',()=>{
  class Audit {
    sent:any[]=[];
    send=(message:any):boolean=>{this.sent.push(message);return true};
    kinds=():string[]=>this.sent.map(message=>message.command.kind);
  }
  function audioContext(){
    const context={currentTime:0,destination:{},sampleRate:24000,resume:vi.fn(async()=>{}),close:vi.fn(async()=>{}),
      audioWorklet:{addModule:vi.fn(async()=>{})},
      createAnalyser:()=>({fftSize:0,connect:vi.fn(),disconnect:vi.fn(),getFloatTimeDomainData:vi.fn()}),
      createMediaStreamSource:()=>({connect:vi.fn()}),
      createBuffer:(_c:number,n:number)=>({getChannelData:()=>new Float32Array(n)}),
      createBufferSource:()=>({connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn(),onended:()=>{}})};
    return context as unknown as AudioContext;
  }
  function stream(){
    const track={stop:vi.fn(),onended:null as null|(()=>void),getSettings:()=>({sampleRate:24000,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true})};
    return {getTracks:()=>[track],getAudioTracks:()=>[track],track};
  }
  let worklet:{port:{onmessage:null|((e:any)=>void)},connect:ReturnType<typeof vi.fn>,disconnect:ReturnType<typeof vi.fn>};
  const classifierFrames=()=>((speechModule as unknown as {pushed:Int16Array[]}).pushed);
  beforeEach(()=>{
    classifierFrames().length=0;
    const context=audioContext();
    vi.stubGlobal('AudioContext',function(){return context;});
    const media=stream();
    vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:media.getTracks,getAudioTracks:media.getAudioTracks})}});
    vi.stubGlobal('chrome',{runtime:{getURL:(path:string)=>path}});
    worklet={port:{onmessage:null},connect:vi.fn(),disconnect:vi.fn()};
    vi.stubGlobal('AudioWorkletNode',function(){return worklet;});
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()});
  const frame=(value:number)=>worklet.port!.onmessage?.({data:{pcm:new Int16Array(480).fill(value).buffer,rms:.1}});

  it('sends audio only after the backend confirms, then streams a manual take with frame indexes',async()=>{
    const audit=new Audit();const log=new VoiceDiagnosticLog();const phase=vi.fn();
    const client=new VoiceClient(audit.send,phase,()=>{},()=>({}),undefined,log);
    await client.startDiagnostic('conv-1');
    const voiceId=audit.sent[0]!.voiceId;
    expect(audit.sent[0]!.command).toEqual({kind:'start',diagnostic:true});
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'state',state:'ready'}});
    expect(client.beginDiagnosticRecording()).toMatchObject({ok:false});
    frame(1000);
    expect(audit.kinds()).toEqual(['start']);
    expect(classifierFrames().flatMap(pcm=>Array.from(pcm)).every(value=>value===1000)).toBe(true);
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'diag',record:{type:'ready',sampleRate:24000,maxSeconds:60}}});
    expect(client.diagnosticConfirmed).toBe(true);
    expect(client.diagnosticRecording).toBe(true);
    expect(audit.sent.at(-1)!.command).toMatchObject({kind:'interrupt',turn:1});
    frame(1000);frame(1000);
    const audio=audit.sent.filter(message=>message.command.kind==='audio');
    expect(audio.map(message=>message.command.frame)).toEqual([0,1]);
    expect(audio.every(message=>Buffer.from(message.command.data,'base64').readInt16LE(0)===1000)).toBe(true);
    const capture=log.latest()!;
    expect(capture.frames).toHaveLength(2);
    expect(samples(capture.frames[0]!)).toEqual(Array(480).fill(1000));
    const events:any[]=[];const spy=vi.spyOn(client as any,'event').mockImplementation((event:any)=>events.push(event));
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'text',turn:1,role:'assistant',text:'诊断期间不应出现的回答'}});
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'audio',turn:1,data:Buffer.from(new Int16Array([1,2]).buffer).toString('base64'),itemId:'item-1',responseId:'resp-1'}});
    expect(events).toHaveLength(0);
    audit.sent.length=0;
    client.endDiagnosticRecording('manual');
    expect(audit.sent.at(-1)!.command).toMatchObject({kind:'commit',turn:1});
    // The take that just ended is not a reason to drop the confirmed session; the next click starts take 2.
    expect(client.beginDiagnosticRecording()).toEqual({ok:true});
    expect(log.latest()!.turn).toBe(2);
    expect(audit.sent.at(-1)!.command).toMatchObject({kind:'interrupt',turn:2});
    client.stop();
  });
  it('fails closed without sending audio when the backend never confirms the mode',async()=>{
    vi.useFakeTimers();
    const audit=new Audit();const phase=vi.fn();
    const client=new VoiceClient(audit.send,phase,()=>{});
    await client.startDiagnostic('conv-1');
    const voiceId=audit.sent[0]!.voiceId;
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'state',state:'ready'}});
    vi.advanceTimersByTime(8000);
    expect(phase).toHaveBeenLastCalledWith('error','当前后端未确认诊断模式，本次没有发送音频。');
    expect(audit.kinds()).toEqual(['start','stop']);
    expect(audit.sent.some(message=>message.command.kind==='audio')).toBe(false);
    expect(client.active).toBe(false);
  });
  it('ends an over-length take by itself and closes the session once the transcript arrives',async()=>{
    vi.useFakeTimers();
    const audit=new Audit();const log=new VoiceDiagnosticLog();const phase=vi.fn();
    const client=new VoiceClient(audit.send,phase,()=>{},()=>({}),undefined,log);
    await client.startDiagnostic('conv-1');
    const voiceId=audit.sent[0]!.voiceId;
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'state',state:'ready'}});
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'diag',record:{type:'ready',sampleRate:24000,maxSeconds:0.05}}});
    audit.sent.length=0;
    frame(1000);frame(1000);frame(1000);
    expect(client.diagnosticRecording).toBe(false);
    expect(log.latest()!.capped).toBe(true);
    expect(log.latest()!.endReason).toBe('limit');
    expect(log.status(log.latest()!).reasons).toContain('已达时长上限，音频被截断');
    // The cut frame is never sent upstream, and the commit still closes the real take.
    expect(audit.sent.filter(message=>message.command.kind==='audio').map(message=>message.command.frame)).toEqual([0,1]);
    expect(audit.sent.at(-1)!.command).toMatchObject({kind:'commit',turn:1});
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'diag',record:{type:'asr',turn:1,itemId:'item-1',outcome:'current',text:'到上限的一句'}}});
    vi.advanceTimersByTime(600);
    expect(client.active).toBe(false);
    expect(audit.sent.at(-1)!.command).toMatchObject({kind:'stop'});
    expect(log.latest()!.notes.some(note=>note.code==='transcript_timeout')).toBe(false);
  });
  it('marks a take incomplete on transport loss instead of resuming it silently',async()=>{
    const audit=new Audit();const log=new VoiceDiagnosticLog();const phase=vi.fn();
    const client=new VoiceClient(audit.send,phase,()=>{},()=>({}),undefined,log);
    await client.startDiagnostic('conv-1');
    const voiceId=audit.sent[0]!.voiceId;
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'state',state:'ready'}});
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'diag',record:{type:'ready',sampleRate:24000,maxSeconds:60}}});
    frame(1000);
    client.onTransportDisconnected();
    expect(phase).toHaveBeenLastCalledWith('error','诊断录音连接中断，本次记录未完成，请重试。');
    expect(log.latest()!.notes.some(note=>note.code==='transport_gap')).toBe(true);
    expect(log.latest()!.endedAt).not.toBeNull();
    client.stop();
  });
});

describe('voice diagnostics panel block',()=>{
  let mockElements:any[];
  function createMockElement(tag="div"):any{
    const children:any[]=[];const attrs=new Map<string,string>();const classList=new Set<string>();
    const element:any={
      tagName:tag.toUpperCase(),className:"",hidden:false,disabled:false,textContent:"",innerHTML:"",children,dataset:{},src:"",
      setAttribute:(k:string,v:string)=>attrs.set(k,v),getAttribute:(k:string)=>attrs.get(k)??null,removeAttribute:(k:string)=>attrs.delete(k),
      getContext:()=>({fillRect(){},clearRect(){},beginPath(){},arc(){},fill(){},save(){},restore(){},scale(){}}),
      querySelector:(sel:string)=>{
        const found=children.find(child=>child.matches?.(sel));if(found)return found;
        const created=createMockElement(sel.startsWith("canvas")?"canvas":sel.startsWith("button")?"button":"div");
        if(sel.startsWith("."))created.className=sel.slice(1);
        if(sel.startsWith("#"))created.id=sel.slice(1);
        children.push(created);return created;
      },
      querySelectorAll:(sel:string)=>children.filter(child=>child.matches?.(sel)),
      before:(...nodes:any[])=>children.unshift(...nodes),
      after:(...nodes:any[])=>children.push(...nodes),
      append:(...nodes:any[])=>children.push(...nodes),
      appendChild:(child:any)=>{children.push(child);return child},
      replaceChildren:(...nodes:any[])=>{children.length=0;children.push(...nodes)},
      click:()=>{element.clicked=true},
      classList:{add:(name:string)=>classList.add(name),remove:(name:string)=>classList.delete(name),contains:(name:string)=>classList.has(name)},
      matches:(sel:string)=>{
        if(sel.startsWith("."))return classList.has(sel.slice(1))||element.className.includes(sel.slice(1));
        if(sel.startsWith("#"))return element.id===sel.slice(1);
        return element.tagName.toLowerCase()===sel.toLowerCase();
      },
    };
    mockElements.push(element);
    return element;
  }
  beforeEach(()=>{
    mockElements=[];
    vi.stubGlobal("document",{createElement:(tag:string)=>createMockElement(tag)});
    vi.stubGlobal("devicePixelRatio",1);
    vi.stubGlobal("requestAnimationFrame",()=>1);
    vi.stubGlobal("cancelAnimationFrame",()=>{});
    vi.stubGlobal("window",{addEventListener:()=>{},requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{},devicePixelRatio:1,matchMedia:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{}})});
  });
  afterEach(()=>vi.unstubAllGlobals());
  const byClass=(name:string)=>mockElements.find(element=>element.className&&element.className.split(' ').includes(name));
  it('offers a compact manual block and starts nothing by itself',()=>{
    const composer=createMockElement("div");
    const input=createMockElement("input");input.id="input";composer.appendChild(input);
    const spacer=createMockElement("div");spacer.id="composer-spacer";composer.appendChild(spacer);
    const send=vi.fn(()=>true);
    const voice=mountVoiceUI(composer,()=>"conv-1",send);
    expect(byClass('voice-diag')).toBeTruthy();
    // The block now covers automatic records too, so its title changed; the manual tools stay.
    expect(byClass('voice-diag-summary').textContent).toBe('语音记录');
    expect(byClass('voice-diag-start').textContent).toBe('开始录音');
    expect(byClass('voice-diag-start').disabled).toBe(false);
    expect(byClass('voice-diag-stop').disabled).toBe(true);
    expect(byClass('voice-diag-export').textContent).toBe('导出JSON');
    expect(byClass('voice-diag-clear').textContent).toBe('清空');
    expect(send).not.toHaveBeenCalled();
    expect(byClass('voice-diag-state').textContent).toContain('未开启');
    byClass('voice-diag-clear').onclick();
    expect(byClass('voice-diag-state').textContent).toContain('已清空');
    voice.stop();
  });
});
