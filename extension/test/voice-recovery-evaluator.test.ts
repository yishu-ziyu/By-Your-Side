// Boss-owned independent recovery acceptance. Implementers must not edit.
import {afterEach,expect,it,vi} from 'vitest';
import {VoiceClient} from '../src/sidepanel/voice-client.js';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function fixture(){
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-09T08:00:00Z'));
 const track={readyState:'live',stop:vi.fn(),onended:null as null|(()=>void)};
 const mic=vi.fn(async()=>({getTracks:()=>[track]}));
 const node=()=>({connect:vi.fn(),disconnect:vi.fn()});
 const context={state:'running',sampleRate:24000,currentTime:0,destination:{},resume:vi.fn(async()=>{}),close:vi.fn(async()=>{}),audioWorklet:{addModule:vi.fn(async()=>{})},createAnalyser:()=>({...node(),fftSize:256,getFloatTimeDomainData:vi.fn()}),createMediaStreamSource:node};
 vi.stubGlobal('AudioContext',function(){return context;});
 vi.stubGlobal('AudioWorkletNode',function(){return {...node(),port:{onmessage:null}};});
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:mic}});vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>p}});
 const sent:any[]=[];const phases:string[]=[];const events:any[]=[];
 const client=new VoiceClient(m=>{sent.push(m);return true;},p=>phases.push(p),e=>events.push(e));
 const starts=()=>sent.filter(m=>m.command.kind==='start');
 const ready=()=>client.receive({...starts().at(-1),event:{kind:'state',state:'ready'}});
 return {client,track,mic,sent,phases,events,starts,ready};
}
it('silent reconnect attempts finish within the frozen 30 second budget',async()=>{
 const f=fixture();await f.client.start('same');f.ready();f.client.onTransportDisconnected();
 await vi.advanceTimersByTimeAsync(30_001);
 expect(f.client.active).toBe(false);expect(f.phases.at(-1)).toBe('error');
 expect(f.starts().length).toBeGreaterThan(1);expect(f.starts().length).toBeLessThanOrEqual(4);f.client.stop();
});
it('duplicate transport-ready notifications do not exhaust a pending attempt',async()=>{
 const f=fixture();await f.client.start('same');f.ready();const old=f.starts()[0];f.client.onTransportDisconnected();
 for(let i=0;i<5;i++)f.client.onTransportReady();await Promise.resolve();
 expect(f.client.active).toBe(true);expect(f.starts()).toHaveLength(2);f.ready();
 f.client.receive({...old,event:{kind:'text',turn:0,role:'assistant',text:'stale'}});expect(f.events).toEqual([]);
 expect(f.mic).toHaveBeenCalledTimes(1);expect(f.starts()[1].voiceId).not.toBe(old.voiceId);expect(f.starts()[1].conversationId).toBe('same');f.client.stop();
});
it('microphone removal remains observable after stream reuse',async()=>{
 const f=fixture();await f.client.start('same');f.ready();f.client.onTransportDisconnected();f.client.onTransportReady();await Promise.resolve();f.ready();
 f.track.readyState='ended';f.track.onended?.();expect(f.client.active).toBe(false);expect(f.phases.at(-1)).toBe('error');f.client.stop();
});
it('explicit stop cancels delayed recovery and does not replay commands',async()=>{
 const f=fixture();await f.client.start('same');f.ready();f.client.onTransportDisconnected();f.client.stop();f.client.onTransportReady();await vi.advanceTimersByTimeAsync(60_000);
 expect(f.starts()).toHaveLength(1);expect(f.client.active).toBe(false);expect(f.sent.every(m=>['start','stop'].includes(m.command.kind))).toBe(true);
});
it.each(['权限拒绝','未配置凭据','模型不匹配'])('permanent %s failure does not restart',async(detail)=>{
 const f=fixture();await f.client.start('same');f.ready();f.client.receive({...f.starts()[0],event:{kind:'state',state:'error',detail,recoverable:false}});f.client.onTransportReady();await vi.advanceTimersByTimeAsync(60_000);expect(f.client.active).toBe(false);expect(f.starts()).toHaveLength(1);
});


// Capture/transport fixtures provide speech probabilities; real model audio is checked separately.
vi.mock('../src/sidepanel/voice-speech.js', () => ({ SpeechClassifier: {
 create: async (onFrame: (pcm: Int16Array, probability: number) => void) => ({
  push: (pcm: Int16Array) => onFrame(pcm, pcm[0] ? 0.9 : 0), close: vi.fn(),
 }),
} }));
