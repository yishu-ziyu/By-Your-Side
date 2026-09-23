import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {isVoiceClientMessage,validCapturePCM,VOICE_CAPTURE_MAX_BASE64,VOICE_DIAG_TEXT_MAX} from '../../shared/voice.js';
import {parseClientMessage} from '../../shared/protocol.js';
import {VoiceClient} from '../src/sidepanel/voice-client.js';

const b64=(values:number[]):string=>Buffer.from(new Int16Array(values).buffer).toString('base64');

const message=(command:unknown)=>({type:'voice',voiceId:'v1',conversationId:'conv-1',command});

const accepts=(command:unknown):boolean=>isVoiceClientMessage(message(command));

describe('capture command boundary',()=>{
  it('accepts every fact the extension can observe, alone or combined',()=>{
    expect(accepts({kind:'capture',turn:1,data:b64([1,2])})).toBe(true);
    expect(accepts({kind:'capture',turn:1,data:b64([1,2]),sampleRate:24000})).toBe(true);
    expect(accepts({kind:'capture',turn:1,mark:true})).toBe(true);
    expect(accepts({kind:'capture',turn:1,mark:true,note:'这条不对'})).toBe(true);
    expect(accepts({kind:'capture',turn:1,displayText:'你：打开邮箱'})).toBe(true);
    expect(accepts({kind:'capture',turn:1,serverText:'打开邮箱'})).toBe(true);
    expect(accepts({kind:'capture',turn:2,data:b64([1,2]),sampleRate:48000,displayText:'你：打开邮箱',mark:true,note:'x'})).toBe(true);
    expect(parseClientMessage(JSON.stringify(message({kind:'capture',turn:1,mark:true})))).not.toBeNull();
  });
  it('rejects a capture without any fact and any malformed field',()=>{
    expect(accepts({kind:'capture',turn:1})).toBe(false);
    expect(accepts({kind:'capture',turn:1,note:'只有备注'})).toBe(false);
    expect(accepts({kind:'capture'})).toBe(false);
    expect(accepts({kind:'capture',turn:0,mark:true})).toBe(false);
    expect(accepts({kind:'capture',turn:1.5,mark:true})).toBe(false);
    expect(accepts({kind:'capture',turn:-1,mark:true})).toBe(false);
    expect(accepts({kind:'capture',turn:1,mark:false})).toBe(false);
    expect(accepts({kind:'capture',turn:1,data:''})).toBe(false);
    expect(accepts({kind:'capture',turn:1,data:'not base64!'})).toBe(false);
    expect(accepts({kind:'capture',turn:1,data:'AAA'})).toBe(false);
    expect(accepts({kind:'capture',turn:1,data:b64([1,2]),sampleRate:0})).toBe(false);
    expect(accepts({kind:'capture',turn:1,data:b64([1,2]),sampleRate:192001})).toBe(false);
    expect(accepts({kind:'capture',turn:1,serverText:'x'.repeat(VOICE_DIAG_TEXT_MAX+1)})).toBe(false);
    expect(accepts({kind:'capture',turn:1,displayText:'x'.repeat(VOICE_DIAG_TEXT_MAX+1)})).toBe(false);
    expect(accepts({kind:'capture',turn:1,mark:true,note:'x'.repeat(201)})).toBe(false);
    expect(parseClientMessage(JSON.stringify(message({kind:'capture',turn:1})))).toBeNull();
    expect(parseClientMessage(JSON.stringify(message({kind:'capture',turn:1,data:'AA'})))).toBeNull();
  });
  it('accepts a full 60-second turn inside the capture bound and rejects the next byte over',()=>{
    const data=Buffer.from(new Int16Array(60*24000).fill(1234).buffer).toString('base64');
    expect(data.length).toBeLessThanOrEqual(VOICE_CAPTURE_MAX_BASE64);
    expect(validCapturePCM(data)).toBe(true);
    expect(accepts({kind:'capture',turn:3,sampleRate:24000,data})).toBe(true);
    expect(validCapturePCM('A'.repeat(VOICE_CAPTURE_MAX_BASE64+4))).toBe(false);
  });
  it('keeps the start flags honest',()=>{
    expect(accepts({kind:'start',capture:true})).toBe(true);
    expect(accepts({kind:'start',diagnostic:true})).toBe(true);
    expect(accepts({kind:'start',diagnostic:true,capture:true})).toBe(true);
    expect(accepts({kind:'start'})).toBe(true);
    expect(accepts({kind:'start',capture:false})).toBe(false);
    expect(accepts({kind:'start',diagnostic:false})).toBe(false);
  });
});

describe('normal voice capture on the client',()=>{
  class Audit {
    sent:any[]=[];
    send=(message:any):boolean=>{this.sent.push(message);

return true};
    kinds=():string[]=>this.sent.map(message=>message.command.kind);
    commands=():any[]=>this.sent.map(message=>message.command);
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

  let worklet:{port:{onmessage:null|((e:any)=>void)},connect:ReturnType<typeof vi.fn>,disconnect:ReturnType<typeof vi.fn>};
  beforeEach(()=>{
    const context=audioContext();
    vi.stubGlobal('AudioContext',function(){return context;});
    const track={stop:vi.fn(),onended:null as null|(()=>void),getSettings:()=>({sampleRate:24000,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true})};
    vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
    vi.stubGlobal('chrome',{runtime:{getURL:(path:string)=>path}});
    worklet={port:{onmessage:null},connect:vi.fn(),disconnect:vi.fn()};
    vi.stubGlobal('AudioWorkletNode',function(){return worklet;});
  });
  afterEach(()=>vi.unstubAllGlobals());
  const frame=(value:number)=>worklet.port!.onmessage?.({data:{pcm:new Int16Array(480).fill(value).buffer,rms:.1}});

  async function session(audit:Audit,phase=vi.fn()){
    const client=new VoiceClient(audit.send,phase,()=>{});
    await client.start('conv-1');
    const voiceId=audit.sent[0]!.voiceId;
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'state',state:'ready',inputMode:'server_vad'}});

    return {client,voiceId};
  }

  const voiced=()=>{for(let i=0;i<5;i++)frame(1000);};

  const silence=()=>{for(let i=0;i<35;i++)frame(0);};

  it('starts without capture and streams continuously to server VAD, not a local classifier',async()=>{
    const audit=new Audit();
    const {client}=await session(audit);
    expect(client.diagnosticMode).toBe(false);
    expect(client.diagnosticRecording).toBe(false);
    expect(audit.commands()[0]).toEqual({kind:'start'});
    // Realtime 3 receives every frame after ready; local classifier is no longer part of the route.
    frame(1000);frame(1000);
    expect(audit.kinds().filter(kind=>kind==='audio')).toHaveLength(2);

    for(let i=0;i<3;i++)frame(1000);
    expect(audit.kinds().filter(kind=>kind==='audio')).toHaveLength(5);
    // Nothing is sent per frame beyond the ordinary upstream audio.
    expect(audit.kinds().filter(kind=>kind==='capture')).toHaveLength(0);
    client.stop();
  });

  it('does not send C0 PCM on a normal session',async()=>{
    const audit=new Audit();
    const {client}=await session(audit);
    voiced();
    frame(1000);frame(1000);
    expect(audit.sent.filter(message=>message.command.kind==='audio')).toHaveLength(7);
    silence();
    expect(audit.commands().filter(command=>command.kind==='capture')).toHaveLength(0);
    expect(audit.kinds().at(-1)).toBe('audio');
    expect(audit.kinds()).not.toContain('interrupt');
    voiced();
    silence();
    expect(audit.commands().filter(command=>command.kind==='capture')).toHaveLength(0);
    client.stop();
  });

  it('marks the latest turn with one command and no change to voice state',async()=>{
    const audit=new Audit();const phase=vi.fn();
    const {client,voiceId}=await session(audit,phase);
    expect(client.markLatest().ok).toBe(false);
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'input_turn',turn:2}});
    voiced();
    const before=audit.sent.length,phases=phase.mock.calls.length;
    expect(client.markLatest()).toEqual({ok:true,turn:2});
    expect(audit.sent.slice(before).map(message=>message.command)).toEqual([{kind:'capture',turn:2,mark:true}]);
    expect(phase.mock.calls.length).toBe(phases);
    expect(client.active).toBe(true);
    expect(client.diagnosticRecording).toBe(false);
    expect(audit.sent.slice(before).some(message=>['stop','interrupt','audio','commit'].includes(message.command.kind))).toBe(false);
    client.stop();
  });

  it('refuses to mark without a session or a finished turn instead of faking one',async()=>{
    const audit=new Audit();
    const client=new VoiceClient(audit.send,vi.fn(),()=>{});
    expect(client.markLatest()).toMatchObject({ok:false,turn:0});
    expect(audit.sent).toHaveLength(0);
    await client.start('conv-1');
    const voiceId=audit.sent[0]!.voiceId;
    client.receive({type:'voice',voiceId,conversationId:'conv-1',event:{kind:'state',state:'ready'}});
    const before=audit.sent.length;
    expect(client.markLatest()).toMatchObject({ok:false,turn:0});
    expect(audit.sent.length).toBe(before);
    client.stop();
  });

  it('sends the rendered question text once the panel has it, and nothing for empty text',async()=>{
    const audit=new Audit();
    const {client}=await session(audit);
    const before=audit.sent.length;
    expect(client.captureDisplay(1,'你：打开邮箱')).toBe(true);
    expect(audit.sent.slice(before).map(message=>message.command)).toEqual([{kind:'capture',turn:1,displayText:'你：打开邮箱'}]);
    expect(client.captureDisplay(1,'   ')).toBe(false);
    expect(audit.sent.length).toBe(before+1);
    client.stop();
  });
});
