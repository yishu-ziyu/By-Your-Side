import {EventEmitter} from 'node:events';
import {describe,it,expect,vi} from 'vitest';
import {StepTtsStream,SpeechTextBuffer,type SpeechCallbacks} from '../src/streaming-tts.js';
import {StepVoiceSession,STEP_VOICE} from '../src/voice-session.js';
import {BrowserAgentSession} from '../src/session.js';
import {toolDeliveryId} from '../src/user-delivery.js';

class Socket extends EventEmitter {
  sent:any[]=[];
  send(s:string){this.sent.push(JSON.parse(s));}
  close=vi.fn();
  server(type:string,data:any={}){this.emit('message',Buffer.from(JSON.stringify({type,data})));}
}
describe('production streaming speech output',()=>{
 it('forwards first audio before finish and forwards more than twenty seconds without a whole-answer gate',()=>{
  const socket=new Socket(),audio=vi.fn(),end=vi.fn(),error=vi.fn();
  const tts=new StepTtsStream('test',STEP_VOICE,{audio,end,error},()=>socket as any);
  tts.push('第一句话。');socket.server('tts.connection.done',{session_id:'s'});socket.server('tts.response.created');
  expect(socket.sent.some(e=>e.type==='tts.text.delta')).toBe(true);
  expect(socket.sent.some(e=>e.type==='tts.text.done')).toBe(false);
  socket.server('tts.response.audio.delta',{audio:Buffer.alloc(1000000).toString('base64')});
  expect(audio.mock.calls.reduce((n,c)=>n+Buffer.from(c[0],'base64').length,0)).toBe(1000000);
  tts.push('后面才形成的回答。');tts.finish();socket.server('tts.response.audio.done');
  expect(end).toHaveBeenCalledOnce();expect(error).not.toHaveBeenCalled();
 });
 it('drops late audio and clears queued text after cancellation',()=>{
  const socket=new Socket(),audio=vi.fn();const tts=new StepTtsStream('test',STEP_VOICE,{audio,end:vi.fn(),error:vi.fn()},()=>socket as any);
  tts.push('不要播出。');tts.cancel();socket.server('tts.response.created');socket.server('tts.response.audio.delta',{audio:'AQABAA=='});
  expect(audio).not.toHaveBeenCalled();expect(socket.sent).toEqual([]);expect(socket.close).toHaveBeenCalledOnce();
 });
 it('reports a provider failure once without replaying any input',()=>{
  const socket=new Socket(),error=vi.fn();const tts=new StepTtsStream('test',STEP_VOICE,{audio:vi.fn(),end:vi.fn(),error},()=>socket as any);
  socket.server('tts.response.error');socket.emit('error',Error('late'));expect(error).toHaveBeenCalledOnce();tts.cancel();
 });
 it('speaks short sentences but not URLs, code or Markdown syntax',()=>{
  const b=new SpeechTextBuffer();expect(b.append('结论是')).toBe('');expect(b.append('**可以**。')).toBe('结论是可以。');
  expect(b.append('详见[资料](https://example.com/a)。')).toBe('详见资料。');
  expect(b.append('```js\nsecret()\n```\n')).toBe('');
  expect(b.append('地址：https://example.com/path。',true)).toBe('地址：。');
 });
 it('stops the active TTS on speech interruption, rejects its late audio, and never invokes page control',()=>{
  const events:any[]=[],route=vi.fn();let output:SpeechCallbacks;const cancel=vi.fn(),push=vi.fn(),finish=vi.fn();const socket=new Socket();
  const s=new StepVoiceSession({getSnapshot:()=>null,emit:e=>events.push(e),route,connect:()=>socket as any,createSpeech:(_key,cb)=>{output=cb;return{push,finish,cancel};}});
  s.start('test');s.streamDelivery({id:'d',runId:'r',kind:'finding',phase:'streaming',text:'这是第一句。'});
  output!.audio('AQABAA==');expect(push).toHaveBeenCalledWith('这是第一句。');expect(finish).not.toHaveBeenCalled();
  s.command({kind:'interrupt',turn:1});const count=events.filter(e=>e.kind==='audio').length;
  output!.audio('AQABAA==');s.completeDelivery({id:'d',runId:'r',kind:'finding',text:'这是第一句。旧的第二句。'});
  expect(events.filter(e=>e.kind==='audio')).toHaveLength(count);expect(cancel).toHaveBeenCalledOnce();expect(route).not.toHaveBeenCalled();s.close();
 });
 it('streams only the explicit answer tool, never ordinary text or tool output',()=>{
  let subscriber:(e:any)=>void=()=>{};const emit=vi.fn();
  const s:any=new (BrowserAgentSession as any)({subscribe:(f:any)=>subscriber=f},null,{emit,setStatus:vi.fn()},null,null);
  s.explicitDelivery=true;s.bindDeliveryRun(()=>'run');s.subscribeEvents();
  subscriber({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'我要执行内部工具'}});
  subscriber({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'内部思考'}});
  subscriber({type:'message_update',assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,partial:{content:[{type:'toolCall',id:'c',name:'click',arguments:{content:'不要读'}}]}}});
  expect(emit.mock.calls.filter(c=>c[0].kind==='user_delivery_stream')).toHaveLength(0);
  subscriber({type:'message_update',assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,partial:{content:[{type:'toolCall',id:'d',name:'send_user_message',arguments:{kind:'finding',content:'已找到结果。'}}]}}});
  expect(emit).toHaveBeenCalledWith({kind:'user_delivery_stream',stream:{id:toolDeliveryId('d'),runId:'run',kind:'finding',phase:'streaming',text:'已找到结果。'}});
 });
});
