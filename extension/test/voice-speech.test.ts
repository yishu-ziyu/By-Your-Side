import {afterEach, expect, it, vi} from 'vitest';
import {VoiceTurnDetector} from '../src/sidepanel/voice-signal.js';
import {SpeechClassifier} from '../src/sidepanel/voice-speech.js';
afterEach(()=>vi.unstubAllGlobals());
it('loud non-speech never opens a turn, quiet speech preserves its preroll and commits once',()=>{
 const start=vi.fn(),audio=vi.fn(),end=vi.fn(),detector=new VoiceTurnDetector({start,audio,end});
 const noise=new Int16Array(768).fill(12000),quiet=new Int16Array(768).fill(50);
 for(let i=0;i<50;i++)detector.push(noise,.02);
 expect(start).not.toHaveBeenCalled();
 for(let i=0;i<3;i++)detector.push(quiet,.9);
 expect(start).toHaveBeenCalledExactlyOnceWith(1);
 expect(audio.mock.calls.slice(-3).every(c=>c[1]===quiet)).toBe(true);
 for(let i=0;i<22;i++)detector.push(new Int16Array(768),.01);
 expect(end).toHaveBeenCalledExactlyOnceWith(1);
 for(let i=0;i<30;i++)detector.push(noise,.01);
 expect(start).toHaveBeenCalledTimes(1);expect(end).toHaveBeenCalledTimes(1);
});
it('a single uncertain frame cannot start speech, but lower confidence does not split an active word',()=>{
 const start=vi.fn(),end=vi.fn(),d=new VoiceTurnDetector({start,audio:()=>{},end});const pcm=new Int16Array(768).fill(50);
 d.push(pcm,.99);d.push(pcm,.1);expect(start).not.toHaveBeenCalled();
 for(let i=0;i<3;i++)d.push(pcm,.9);
 for(let i=0;i<30;i++)d.push(pcm,.4);
 expect(start).toHaveBeenCalledTimes(1);expect(end).not.toHaveBeenCalled();
});
it('accepts sustained moderate speech confidence without requiring a louder repeat',()=>{
 const start=vi.fn(),audio=vi.fn(),end=vi.fn();
 const d=new VoiceTurnDetector({start,audio,end});
 const pcm=new Int16Array(768).fill(1600);
 // Controlled probabilities in the range observed during missed live input;
 // this is a detector regression, not a replay of recorded microphone audio.
 for(const probability of [.32,.48,.53])d.push(pcm,probability);
 expect(start).toHaveBeenCalledExactlyOnceWith(1);
 expect(audio).toHaveBeenCalledTimes(3);
 for(let i=0;i<25;i++)d.push(pcm,.28);
 expect(end).not.toHaveBeenCalled();
 for(let i=0;i<22;i++)d.push(new Int16Array(768),0);
 expect(end).toHaveBeenCalledExactlyOnceWith(1);
});
it('rejects isolated moderate-confidence bursts separated by non-speech',()=>{
 const start=vi.fn();const d=new VoiceTurnDetector({start,audio:()=>{},end:()=>{}});
 const pcm=new Int16Array(768).fill(12000);
 for(let i=0;i<20;i++)for(const p of [.48,.53,.1])d.push(pcm,p);
 expect(start).not.toHaveBeenCalled();
});
function fixture(){
 const worker={onmessage:null as null|((e:any)=>void),onerror:null as null|(()=>void),postMessage:vi.fn(),terminate:vi.fn()};
 vi.stubGlobal('Worker',function(){return worker});vi.stubGlobal('chrome',{runtime:{getURL:(s:string)=>s}});
 return worker;
}
it('worker startup failure is explicit, and never falls back to volume detection',async()=>{
 const w=fixture(),frame=vi.fn(),error=vi.fn();const promise=SpeechClassifier.create(frame,error);
 w.onmessage?.({data:{kind:'error'}});
 await expect(promise).rejects.toThrow('Speech detection unavailable');expect(frame).not.toHaveBeenCalled();expect(w.terminate).toHaveBeenCalledTimes(1);
});
it('closing discards late inference and prevents further capture transfers',async()=>{
 const w=fixture(),frame=vi.fn(),error=vi.fn();const promise=SpeechClassifier.create(frame,error);w.onmessage?.({data:{kind:'ready'}});const c=await promise;
 const callback=w.onmessage!;c.push(new Int16Array(480));expect(w.postMessage).toHaveBeenCalledTimes(1);c.close();c.push(new Int16Array(480));callback({data:{kind:'frame',pcm:new Int16Array(768).buffer,probability:.9}});
 expect(frame).not.toHaveBeenCalled();expect(w.postMessage).toHaveBeenCalledTimes(1);expect(w.terminate).toHaveBeenCalledTimes(1);
});
it('inference errors stop capture and notify the current session once',async()=>{
 const w=fixture(),error=vi.fn();const promise=SpeechClassifier.create(vi.fn(),error);w.onmessage?.({data:{kind:'ready'}});await promise;const callback=w.onmessage!;
 callback({data:{kind:'error'}});callback({data:{kind:'error'}});expect(error).toHaveBeenCalledTimes(1);expect(w.terminate).toHaveBeenCalledTimes(1);
});

it('digital silence cannot sustain a turn even with delayed model confidence',()=>{
 const end=vi.fn(),d=new VoiceTurnDetector({start:()=>{},audio:()=>{},end});
 for(let i=0;i<3;i++)d.push(new Int16Array(768).fill(50),.9);
 for(let i=0;i<22;i++)d.push(new Int16Array(768),.9);
 expect(end).toHaveBeenCalledExactlyOnceWith(1);
});
