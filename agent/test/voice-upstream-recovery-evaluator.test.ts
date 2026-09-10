// Boss-owned typed upstream recovery acceptance.
import {EventEmitter} from 'node:events';
import {it,expect,vi,afterEach} from 'vitest';
import {StepVoiceSession,STEP_VOICE} from '../src/voice-session.js';
class Socket extends EventEmitter {readyState=1;bufferedAmount=0;send(){}close(){}server(e:object){this.emit('message',Buffer.from(JSON.stringify(e)));}}
afterEach(()=>vi.useRealTimers());
function fixture(){vi.useFakeTimers();const events:any[]=[];const sockets:Socket[]=[];const session=new StepVoiceSession({getSnapshot:()=>({conversationId:'same',state:'none',observedAt:Date.now(),goal:null,startedAt:null,active:[],lastAction:null,successVerified:false}),emit:e=>events.push(e),connect:()=>{const s=new Socket();sockets.push(s);return s as any;}});session.start('synthetic');const ready=()=>{sockets.at(-1)!.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});sockets.at(-1)!.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:{type:''}}});};return {session,events,sockets,ready};}
it('29 minute lifetime emits an explicitly recoverable error',async()=>{const f=fixture();try{f.ready();await vi.advanceTimersByTimeAsync(29*60_000);expect(f.events.find(e=>e.kind==='state'&&e.state==='error')).toMatchObject({recoverable:true});}finally{f.session.close();}});
it('network reconnect timeout after a successful handshake is recoverable',async()=>{const f=fixture();try{f.ready();f.sockets[0]!.emit('close',1006);await vi.advanceTimersByTimeAsync(16_000);expect(f.events.find(e=>e.kind==='state'&&e.state==='error')).toMatchObject({recoverable:true});}finally{f.session.close();}});
it('model mismatch is never marked recoverable',()=>{const f=fixture();try{f.sockets[0]!.server({type:'session.created',session:{model:'wrong'}});expect(f.events.find(e=>e.kind==='state'&&e.state==='error')?.recoverable).not.toBe(true);}finally{f.session.close();}});
