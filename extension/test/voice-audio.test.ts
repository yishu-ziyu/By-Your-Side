import {afterEach, expect, it, vi} from 'vitest';
import {VoiceTurnDetector} from '../src/sidepanel/voice-signal.js';
import {VoicePlayer} from '../src/sidepanel/voice-player.js';
import {VoiceClient} from '../src/sidepanel/voice-client.js';
afterEach(()=>vi.unstubAllGlobals());
it('ignores brief noise, streams preroll and commits once after silence',()=>{
 const start=vi.fn(),audio=vi.fn(),end=vi.fn();const d=new VoiceTurnDetector({start,audio,end});const pcm=new Int16Array(480);
 for(let i=0;i<3;i++)d.push(pcm,.1);d.push(pcm,0);expect(start).not.toHaveBeenCalled();
 for(let i=0;i<4;i++)d.push(pcm,.1);expect(start).toHaveBeenCalledExactlyOnceWith(1);expect(audio).toHaveBeenCalledTimes(8);
 for(let i=0;i<35;i++)d.push(pcm,0);expect(end).toHaveBeenCalledExactlyOnceWith(1);
 for(let i=0;i<50;i++)d.push(pcm,0);expect(end).toHaveBeenCalledTimes(1);
});
function audioContext(){
 const nodes:any[]=[];const context={currentTime:0,destination:{},sampleRate:24000,resume:vi.fn(async()=>{}),close:vi.fn(async()=>{}),createBuffer:(_c:number,n:number)=>({getChannelData:()=>new Float32Array(n)}),createBufferSource:()=>{const n={connect:vi.fn(),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn(),onended:()=>{}};nodes.push(n);return n;}};
 return {context:context as unknown as AudioContext,nodes,raw:context};
}
it('interruption stops queued audio and reports played milliseconds, not generated duration',()=>{
 const {context,nodes,raw}=audioContext(),drained=vi.fn();const p=new VoicePlayer(context,drained);
 p.begin(1);const data=Buffer.alloc(48000).toString('base64');
 p.enqueue({turn:1,itemId:'i1',responseId:'r1',data});p.enqueue({turn:1,itemId:'i1',responseId:'r1',data});
 p.responseEnd('r1');expect(drained).not.toHaveBeenCalled();raw.currentTime=.512;
 expect(p.begin(2)).toEqual({itemId:'i1',ms:500});expect(nodes.every(n=>n.stop.mock.calls.length===1)).toBe(true);
 nodes.forEach(n=>n.onended());expect(drained).not.toHaveBeenCalled();
 p.enqueue({turn:1,itemId:'late',responseId:'r1',data});expect(nodes).toHaveLength(2);
});
it('closing during microphone permission releases a late stream without starting upstream',async()=>{
 const {context,raw}=audioContext();vi.stubGlobal('AudioContext',function(){return context;});
 let resolve!:(s:MediaStream)=>void;const stream=new Promise<MediaStream>(r=>resolve=r);const stop=vi.fn();
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>stream}});
 const send=vi.fn(()=>true),phase=vi.fn();const client=new VoiceClient(send,phase,()=>{});
 const starting=client.start('A');await Promise.resolve();client.stop();resolve({getTracks:()=>[{stop}]} as unknown as MediaStream);await starting;
 expect(stop).toHaveBeenCalledTimes(1);expect(raw.close).toHaveBeenCalledTimes(1);
 expect(send.mock.calls.flat().some((m:any)=>m?.command?.kind==='start')).toBe(false);
});
it('microphone denial gives an error and closes audio resources',async()=>{
 const {context,raw}=audioContext();vi.stubGlobal('AudioContext',function(){return context;});
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:()=>Promise.reject(new DOMException('denied','NotAllowedError'))}});
 const phase=vi.fn();const client=new VoiceClient(()=>true,phase,()=>{});await client.start('A');
 expect(phase).toHaveBeenLastCalledWith('error','未获得麦克风权限，请允许后重试。');expect(raw.close).toHaveBeenCalledTimes(1);expect(client.active).toBe(false);
});
it('streams only after ready, rejects foreign and old turns, and releases capture on stop',async()=>{
 const {context,raw,nodes}=audioContext();const track={stop:vi.fn(),onended:null};
 Object.assign(raw,{audioWorklet:{addModule:vi.fn(async()=>{})},createAnalyser:()=>({fftSize:0,connect:vi.fn(),disconnect:vi.fn(),getFloatTimeDomainData:vi.fn()}),createMediaStreamSource:()=>({connect:vi.fn()})});
 vi.stubGlobal('AudioContext',function(){return context;});
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track]})}});
 vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>p}});
 const worklet={port:{onmessage:null as null|((e:any)=>void)},connect:vi.fn(),disconnect:vi.fn()};
 vi.stubGlobal('AudioWorkletNode',function(){return worklet;});
 const sent:any[]=[];const change=vi.fn(),event=vi.fn();const c=new VoiceClient(m=>{sent.push(m);return true;},change,event);
 await c.start('A');await c.start('A');expect(sent.filter(m=>m.command.kind==='start')).toHaveLength(1);
 const voiceId=sent[0].voiceId;const frame=(rms:number)=>worklet.port.onmessage?.({data:{pcm:new Int16Array(480).buffer,rms}});
 for(let i=0;i<5;i++)frame(.1);expect(sent).toHaveLength(1);
 c.receive({type:'voice',voiceId,conversationId:'B',event:{kind:'state',state:'ready'}});
 for(let i=0;i<5;i++)frame(.1);expect(sent).toHaveLength(1);
 c.receive({type:'voice',voiceId,conversationId:'A',event:{kind:'state',state:'ready'}});
 for(let i=0;i<4;i++)frame(.1);expect(sent[1].command).toMatchObject({kind:'interrupt',turn:1});
 for(let i=0;i<35;i++)frame(0);expect(sent.at(-1).command).toEqual({kind:'commit',turn:1});
 c.receive({type:'voice',voiceId,conversationId:'A',event:{kind:'state',state:'ready'}});
 expect(change).toHaveBeenLastCalledWith('listening',undefined);
 c.receive({type:'voice',voiceId,conversationId:'A',event:{kind:'state',state:'ready',detail:'没听清这句话，请再说一次。'}});
 expect(change).toHaveBeenLastCalledWith('listening','没听清这句话，请再说一次。');expect(c.active).toBe(true);
 c.receive({type:'voice',voiceId,conversationId:'A',event:{kind:'text',turn:1,role:'assistant',text:'这句没有判断清楚，未执行。可以继续说。'}});
 c.receive({type:'voice',voiceId,conversationId:'A',event:{kind:'state',state:'ready',detail:'这句没有判断清楚，未执行。可以继续说。'}});
 expect(track.stop).not.toHaveBeenCalled();expect(raw.close).not.toHaveBeenCalled();expect(c.active).toBe(true);
 c.receive({type:'voice',voiceId,conversationId:'A',event:{kind:'audio',turn:1,itemId:'i1',responseId:'r1',data:Buffer.alloc(48000).toString('base64')}});expect(nodes).toHaveLength(1);
 for(let i=0;i<4;i++)frame(.1);expect(nodes[0].stop).toHaveBeenCalledTimes(1);
 c.receive({type:'voice',voiceId,conversationId:'A',event:{kind:'audio',turn:1,itemId:'i1',responseId:'r1',data:'AQABAA=='}});expect(nodes).toHaveLength(1);
 c.stop();expect(track.stop).toHaveBeenCalledTimes(1);expect(worklet.port.onmessage).toBeNull();expect(raw.close).toHaveBeenCalledTimes(1);
 c.receive({type:'voice',voiceId,conversationId:'A',event:{kind:'state',state:'ready'}});expect(change).toHaveBeenLastCalledWith('idle',undefined);
});
