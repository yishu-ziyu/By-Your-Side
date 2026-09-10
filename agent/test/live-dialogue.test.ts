import {EventEmitter} from 'node:events';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {StepVoiceSession,STEP_VOICE} from '../src/voice-session.js';
import {parseVoiceDecision} from '../src/voice-intent.js';
import type {SpeechCallbacks} from '../src/streaming-tts.js';
import type {TaskProgressSnapshot,VoiceRouteResult,UserDeliveryStream} from '../../shared/voice.js';

class Socket extends EventEmitter {
  readyState=1;bufferedAmount=0;sent:any[]=[];
  send(s:string){this.sent.push(JSON.parse(s));}
  close(){}
  server(e:object){this.emit('message',Buffer.from(JSON.stringify(e)));}
}
const sessions:StepVoiceSession[]=[];
afterEach(()=>sessions.splice(0).forEach(s=>s.close()));
const tick=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
function harness(result:VoiceRouteResult={kind:'none'},earlyReplies=false) {
  const socket=new Socket(),events:any[]=[],outputs:Array<{cb:SpeechCallbacks;push:ReturnType<typeof vi.fn>;finish:ReturnType<typeof vi.fn>;cancel:ReturnType<typeof vi.fn>}>=[];
  let snapshot:TaskProgressSnapshot={conversationId:'default',runId:'run',controlVersion:0,state:'running',observedAt:1,goal:'列出标签页',startedAt:1,active:[],lastAction:null,successVerified:false};
  const route=vi.fn(async()=>result);
  const s=new StepVoiceSession({earlyReplies,getSnapshot:()=>snapshot,connect:()=>socket as any,emit:e=>events.push(e),route,createSpeech:(_key,cb)=>{const o={cb,push:vi.fn(),finish:vi.fn(),cancel:vi.fn()};outputs.push(o);return o;}});
  sessions.push(s);s.start('test');socket.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});socket.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16'}});
  const input=async(turn:number,text:string)=>{s.command({kind:'interrupt',turn});s.command({kind:'audio',turn,data:'AQABAA=='});s.command({kind:'commit',turn});socket.server({type:'input_audio_buffer.committed',item_id:'u'+turn});socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u'+turn,transcript:text});await tick();};
  const reply=(id:string,text='好，我看看。')=>{socket.server({type:'response.created',response:{id}});socket.server({type:'response.audio.delta',response_id:id,item_id:'a'+id,delta:'AQABAA=='});socket.server({type:'response.audio_transcript.done',response_id:id,transcript:text});socket.server({type:'response.done',response:{id,status:'completed'}});};
  const finding=(id='result'):UserDeliveryStream=>({id,runId:'run',kind:'finding',phase:'streaming',text:'当前共有三个标签页。'});
  return {s,socket,events,outputs,route,input,reply,finding,setSnapshot:(next:Partial<TaskProgressSnapshot>)=>{snapshot={...snapshot,...next};}};
}

describe('live dialogue while a browser task runs',()=>{
  it.each([true,false])('keeps a pending delegation only if the interjection is conversational: %s',async readOnly=>{
    const h=harness({kind:'none'},true);const pending:any[]=[];
    h.route.mockImplementation(((...args:any[])=>new Promise(resolve=>pending.push({args,resolve}))) as any);
    await h.input(1,'读一下页面');h.reply('early');h.s.command({kind:'playback_done',responseId:'early'});
    await h.input(2,readOnly?'今天有点累':'取消刚才的任务');
    expect(pending[1].args[3].pendingDelegation).toBe(true);
    pending[0].args[3].onInputDecision(false);
    let released=false;const gate=pending[0].args[3].awaitInputDecision().then(()=>released=true);await tick();expect(released).toBe(false);
    pending[1].args[3].onInputDecision(readOnly);await gate;
    expect(pending[0].args[2]()).toBe(readOnly);
    pending[0].resolve({kind:'none'});pending[1].resolve({kind:'none'});await tick();
  });
  it('can speak while the task classifier is still pending and does not repeat the chat afterward',async()=>{
    const h=harness({kind:'none'},true);let resolve!:(r:VoiceRouteResult)=>void;h.route.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    await h.input(1,'今天脑子有点乱');expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
    h.reply('early','先说说最困扰你的那一件？');expect(h.events.some(e=>e.kind==='audio')).toBe(true);
    h.s.command({kind:'playback_done',responseId:'early'});expect(h.outputs).toHaveLength(0);
    resolve({kind:'none'});await tick();expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
  });
  it('keeps action confirmation behind the receipt even when early speech has already started',async()=>{
    const h=harness({kind:'none'},true);let resolve!:(r:VoiceRouteResult)=>void;h.route.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    await h.input(1,'修改一下');h.reply('early','我来处理这个修改。');
    resolve({kind:'clarify',message:'请说明要修改的内容。'});await tick();expect(h.outputs).toHaveLength(0);
    h.s.command({kind:'playback_done',responseId:'early'});expect(h.outputs).toHaveLength(1);expect(h.outputs[0]!.push).toHaveBeenCalledWith('请说明要修改的内容。');
  });
  it('does not start an early reply to an explicit request to stop speaking',async()=>{
    const h=harness({kind:'silent'},true);await h.input(1,'别说了');expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
  });
  it('does not guard early speech with an action receipt that arrived before response.created',async()=>{
    const h=harness({kind:'clarify',message:'需要确认。'},true);await h.input(1,'做一下');h.reply('early','我看看。');
    expect(h.events.some(e=>e.kind==='audio')).toBe(true);expect(h.events.some(e=>e.kind==='text'&&e.text==='我看看。')).toBe(true);
  });
  it('does not turn a queued voice answer into a background result when the final message omits voiceTurn',async()=>{
    const h=harness({kind:'none'},true);await h.input(1,'刚才那个呢');h.reply('early','我核对一下。');
    h.s.streamDelivery({...h.finding('reply'),kind:'reply',voiceTurn:1});h.s.completeDelivery({...h.finding('reply'),kind:'reply'});
    expect(h.outputs).toHaveLength(0);await h.input(2,'不用了，聊点别的');h.reply('new','好。');h.s.command({kind:'playback_done',responseId:'new'});
    expect(h.outputs).toHaveLength(0);
  });
  it('keeps a browser task with a reading step together, while rejecting mixed control/read plans',()=>{
    const text='帮我等测试资料准备好，再读一下当前页面，告诉我两种模型的有效期。';
    expect(parseVoiceDecision(JSON.stringify({steps:[{action:'start',through:1,target:null},{action:'observe',through:2,target:null}]}),text)).toEqual({steps:[{action:'start',target:null,text}]});
    expect(()=>parseVoiceDecision(JSON.stringify({steps:[{action:'pause',through:0,target:null},{action:'observe',target:null}]}),'暂停当前任务。再读页面。')).toThrow();
    expect(()=>parseVoiceDecision(JSON.stringify({steps:[{action:'start',through:0,target:'不存在'},{action:'observe',target:null}]}),'打开页面。看一下。')).toThrow();
  });
  it('speaks an accepted task acknowledgement even when final delivery is still pending',async()=>{
    const h=harness({kind:'action',ok:true,awaitDelivery:true,receipts:[{requestId:'req',conversationId:'default',targetTitle:'默认会话',source:'voice',action:'start',runId:'run',status:'accepted',text:'列出标签页',message:'已接收',updatedAt:1}],message:'已接收'});
    await h.input(1,'列出标签页');
    expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
    h.reply('ack','好，我看看你都开了些什么。');
    expect(h.events.some(e=>e.kind==='audio')).toBe(true);
    expect(h.outputs).toHaveLength(0); // no final result exists
  });
  it('waits for the current spoken reply to finish playback before taking over with a background result',async()=>{
    const h=harness();await h.input(1,'我是不是开太多了');h.reply('chat','先看看有哪些，再决定要不要整理。');
    h.s.completeDelivery(h.finding());
    expect(h.outputs).toHaveLength(0);
    h.s.command({kind:'playback_done',responseId:'chat'});
    expect(h.outputs).toHaveLength(1);expect(h.outputs[0]!.push).toHaveBeenCalledWith('当前共有三个标签页。');
    expect(h.outputs[0]!.finish).toHaveBeenCalledOnce();
  });
  it('does not speak a result over a user who has started talking',async()=>{
    const h=harness();h.s.command({kind:'interrupt',turn:1});h.s.completeDelivery(h.finding());
    expect(h.outputs).toHaveLength(0);
    // Continue the same input turn, then let its conversational reply finish.
    h.s.command({kind:'audio',turn:1,data:'AQABAA=='});h.s.command({kind:'commit',turn:1});
    h.socket.server({type:'input_audio_buffer.committed',item_id:'u1'});h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'先不要清理'});await tick();h.reply('chat');
    expect(h.outputs).toHaveLength(0);h.s.command({kind:'playback_done',responseId:'chat'});expect(h.outputs).toHaveLength(1);
  });
  it('keeps cumulative background text together and never repeats the completed result',async()=>{
    const h=harness();await h.input(1,'等一下');h.reply('chat');
    h.s.streamDelivery({...h.finding(),text:'当前共有'});h.s.streamDelivery(h.finding());h.s.completeDelivery(h.finding());
    h.s.command({kind:'playback_done',responseId:'chat'});
    const o=h.outputs[0]!;o.cb.audio('AQABAA==');o.cb.end();
    const id=h.events.find(e=>e.kind==='audio'&&e.responseId.startsWith('tts-')).responseId;
    h.s.command({kind:'playback_done',responseId:id});h.s.completeDelivery(h.finding());
    expect(h.outputs).toHaveLength(1);expect(o.push).toHaveBeenCalledOnce();
  });
  it.each([{runId:'new-run'},{state:'aborted' as const},{controlVersion:1}])('discards a queued result when its task identity/control changes: %j',async next=>{
    const h=harness();await h.input(1,'等一下');h.reply('chat');h.s.completeDelivery(h.finding());h.setSnapshot(next);
    h.s.command({kind:'playback_done',responseId:'chat'});h.s.completeDelivery(h.finding());expect(h.outputs).toHaveLength(0);
  });
  it('drops cancelled pending results and close clears every pending utterance',async()=>{
    const h=harness();await h.input(1,'等一下');h.reply('chat');h.s.completeDelivery(h.finding());h.s.streamDelivery({...h.finding(),phase:'cancelled',text:''});
    h.s.command({kind:'playback_done',responseId:'chat'});h.s.completeDelivery(h.finding());expect(h.outputs).toHaveLength(0);
    h.s.command({kind:'interrupt',turn:2});h.s.completeDelivery(h.finding('second'));h.s.close();h.s.command({kind:'playback_done',responseId:'chat'});expect(h.outputs).toHaveLength(0);
  });
  it('streams the current voice reply during routing and does not speak it twice when routing returns',async()=>{
    const h=harness();let resolve!:(r:VoiceRouteResult)=>void;h.route.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    await h.input(1,'刚才那个呢');
    h.s.streamDelivery({...h.finding('reply'),kind:'reply',voiceTurn:1});
    expect(h.outputs).toHaveLength(1);
    h.s.completeDelivery({...h.finding('reply'),kind:'reply'});
    resolve({kind:'none',spokenText:'当前共有三个标签页。',snapshot:{conversationId:'default',runId:'run',observedAt:1,state:'running',goal:null,startedAt:1,active:[],lastAction:null,successVerified:false,conversationContext:{recentTurns:[],latestResult:null,latestDelivery:{conversationId:'default',id:'reply',runId:'run',kind:'reply',text:'当前共有三个标签页。',status:'composed',composedAt:1}}}});
    await tick();expect(h.outputs).toHaveLength(1);expect(h.outputs[0]!.finish).toHaveBeenCalledOnce();
  });
  it('does not resurrect an old voice-turn stream when its final delivery arrives',async()=>{
    const h=harness();h.s.command({kind:'interrupt',turn:2});h.s.streamDelivery({...h.finding('old-reply'),voiceTurn:1});h.s.completeDelivery(h.finding('old-reply'));
    expect(h.outputs).toHaveLength(0);
  });
  it('speaks a routing failure instead of silently returning to listening, without retrying the task',async()=>{
    const h=harness();h.route.mockRejectedValueOnce(Error('unavailable'));await h.input(1,'读一下页面');
    expect(h.outputs).toHaveLength(1);expect(h.outputs[0]!.push.mock.calls.flat().join('')).toContain('没有取得确定结果');
    expect(h.route).toHaveBeenCalledOnce();
  });
  it('carries what the voice assistant just said into the next intent decision',async()=>{
    const h=harness();await h.input(1,'等的时候聊两句');h.reply('chat','先挑最容易的一件做。');h.s.command({kind:'playback_done',responseId:'chat'});
    await h.input(2,'按你刚才说的来');
    expect((h.route.mock.calls[1] as any)[3].recentTurns).toContainEqual({role:'assistant',text:'先挑最容易的一件做。'});
  });
});
