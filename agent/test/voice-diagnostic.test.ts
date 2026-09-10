import {EventEmitter} from 'node:events';
import {describe,it,expect,vi} from 'vitest';
import {StepVoiceSession,STEP_VOICE} from '../src/voice-session.js';
import type {TaskProgressSnapshot,VoiceDiagRecord,VoiceEvent} from '../../shared/voice.js';

class FakeSocket extends EventEmitter {
  readyState=1;bufferedAmount=0;sent:Array<Record<string,any>>=[];
  close=vi.fn();
  constructor(private readonly throwOn:(type:string)=>boolean=()=>false){super();}
  send(raw:string){
    const event=JSON.parse(raw) as Record<string,any>;
    if(this.throwOn(String(event.type)))throw new Error('socket send failed');
    this.sent.push(event);
  }
  server(type:string,payload:Record<string,unknown>={}):void{this.emit('message',Buffer.from(JSON.stringify({type,...payload})));}
}
const pcm=(samples:number,value:number):string=>Buffer.from(new Int16Array(samples).fill(value).buffer).toString('base64');
const snapshot=():TaskProgressSnapshot=>({conversationId:'conv-1',observedAt:1,state:'none',goal:null,startedAt:null,active:[],lastAction:null,successVerified:false});

function build(options:{diagnostic?:boolean;capture?:boolean;throwOn?:(type:string)=>boolean}={}){
  const socket=new FakeSocket(options.throwOn);
  const events:VoiceEvent[]=[],records:VoiceDiagRecord[]=[];
  const route=vi.fn(async()=>({kind:'none' as const}));
  const steer=vi.fn(async()=>{});
  const session=new StepVoiceSession({
    ...(options.diagnostic?{diagnosticMode:true}:{}),
    ...(options.capture?{captureMode:true}:{}),
    getSnapshot:snapshot,
    emit:event=>{events.push(event);if(event.kind==='diag')records.push(event.record)},
    route,steer,
    connect:()=>socket as never,
  });
  session.start('test-key');
  socket.server('session.created',{session:{model:'stepaudio-2.5-realtime'}});
  socket.server('session.updated',{session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:{type:'none'}}});
  return {socket,events,records,route,steer,session};
}
const take=(session:StepVoiceSession,turn=1,frames=2):void=>{
  session.command({kind:'interrupt',turn});
  for(let i=0;i<frames;i++)session.command({kind:'audio',turn,data:pcm(480,i+1),frame:i});
  session.command({kind:'commit',turn});
};
const of=(records:VoiceDiagRecord[],type:VoiceDiagRecord['type'])=>records.filter(record=>record.type===type);

describe('diagnostic capture evidence from the real send path',()=>{
  it('confirms the mode once and records appends/commit/item/ASR only from accepted sends',()=>{
    const {socket,records,events,session}=build({diagnostic:true});
    expect(records).toEqual([{type:'ready',sampleRate:24000,maxSeconds:60}]);
    take(session);
    const appends=of(records,'append');
    expect(appends).toHaveLength(2);
    const sentAppends=socket.sent.filter(event=>event.type==='input_audio_buffer.append');
    expect(sentAppends.map(event=>event.audio)).toEqual([pcm(480,1),pcm(480,2)]);
    expect(appends.map(record=>record.type==='append'&&[record.eventId,record.frame,record.samples,record.audio]))
      .toEqual(sentAppends.map((event,index)=>[event.event_id,index,480,event.audio]));
    const commits=of(records,'commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.type==='commit'&&commits[0]!.eventId).toBe(socket.sent.at(-1)!.event_id);
    expect(commits[0]!.type==='commit'&&commits[0]!.turn).toBe(1);
    socket.server('input_audio_buffer.committed',{item_id:'item-1'});
    expect(of(records,'item')).toEqual([{type:'item',turn:1,itemId:'item-1'}]);
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-1',transcript:'你好世界'});
    expect(of(records,'asr')).toEqual([{type:'asr',turn:1,itemId:'item-1',outcome:'current',text:'你好世界'}]);
    expect(of(records,'forward')).toEqual([{type:'forward',turn:1,itemId:'item-1',text:'你好世界'}]);
    expect(events.some(event=>event.kind==='text'&&event.role==='user'&&event.text==='你好世界')).toBe(true);
  });
  it('locks out routing, steering and answers during a diagnostic take',()=>{
    const {socket,route,steer,session}=build({diagnostic:true});
    take(session);
    socket.server('input_audio_buffer.committed',{item_id:'item-1'});
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-1',transcript:'帮我打开网页'});
    expect(route).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(socket.sent.some(event=>event.type==='response.create')).toBe(false);
    expect(socket.sent.some(event=>event.type==='function_call_output')).toBe(false);
  });
  it('keeps a late transcript attributed to its original turn and filtered out',()=>{
    const {socket,records,events,session}=build({diagnostic:true});
    take(session);
    socket.server('input_audio_buffer.committed',{item_id:'item-1'});
    session.command({kind:'interrupt',turn:2});
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-1',transcript:'迟到的旧转写'});
    expect(of(records,'asr')).toEqual([{type:'asr',turn:1,itemId:'item-1',outcome:'filtered',text:'迟到的旧转写'}]);
    expect(of(records,'forward')).toHaveLength(0);
    expect(events.some(event=>event.kind==='text')).toBe(false);
  });
  it('records no append when the socket rejects the send',()=>{
    const {socket,records,events,session}=build({diagnostic:true,throwOn:type=>type==='input_audio_buffer.append'});
    take(session);
    expect(of(records,'append')).toHaveLength(0);
    expect(of(records,'commit')).toHaveLength(0);
    expect(of(records,'gap').some(record=>record.type==='gap'&&record.code==='reconnect')).toBe(true);
    expect(events.some(event=>event.kind==='state'&&event.state==='error')).toBe(true);
    expect(socket.sent.some(event=>event.type==='input_audio_buffer.append')).toBe(false);
  });
  it('marks an over-length take as truncated instead of complete',()=>{
    const {records,events,session}=build({diagnostic:true});
    session.command({kind:'interrupt',turn:1});
    const frame=pcm(24576,500);
    for(let i=0;i<70;i++)session.command({kind:'audio',turn:1,data:frame,frame:i});
    expect(of(records,'append')).toHaveLength(58);
    expect(of(records,'gap').some(record=>record.type==='gap'&&record.code==='truncated')).toBe(true);
    expect(events.some(event=>event.kind==='state'&&event.state==='error')).toBe(true);
  });
  it('records normal-use capture while routing, answering and steering as usual',async()=>{
    const {socket,records,events,route,steer,session}=build({capture:true});
    expect(records).toEqual([{type:'ready',sampleRate:24000,maxSeconds:60}]);
    take(session);
    expect(of(records,'append')).toHaveLength(2);
    socket.server('input_audio_buffer.committed',{item_id:'item-1'});
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-1',transcript:'帮我看下进度'});
    expect(of(records,'commit')).toHaveLength(1);
    expect(of(records,'item')).toEqual([{type:'item',turn:1,itemId:'item-1'}]);
    expect(of(records,'asr')).toEqual([{type:'asr',turn:1,itemId:'item-1',outcome:'current',text:'帮我看下进度'}]);
    expect(of(records,'forward')).toEqual([{type:'forward',turn:1,itemId:'item-1',text:'帮我看下进度'}]);
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(route).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(events.some(event=>event.kind==='text'&&event.role==='user'&&event.text==='帮我看下进度')).toBe(true);
    expect(socket.sent.some(event=>event.type==='response.create')).toBe(true);
    expect(socket.sent.some(event=>event.type==='conversation.item.create')).toBe(true);
  });
  it('merges the late half-sentence of the interrupted turn into the current turn',()=>{
    const {socket,records,events,session}=build({capture:true});
    take(session,1);
    socket.server('input_audio_buffer.committed',{item_id:'item-1'});
    // 用户没等回答就接着说：第 2 轮开始，第 1 轮的回答在这里被取消。
    take(session,2);
    socket.server('input_audio_buffer.committed',{item_id:'item-2'});
    // 第 1 轮的转写这时才回来——以前它会被当成旧内容丢掉。
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-1',transcript:'这个go界面，它的消耗量'});
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-2',transcript:'汇报一下。'});
    expect(events.filter(event=>event.kind==='text'&&event.role==='user')).toEqual([
      {kind:'text',role:'user',turn:2,text:'这个go界面，它的消耗量 汇报一下。'},
    ]);
    expect(records.some(record=>record.type==='asr'&&record.turn===1&&record.outcome==='filtered')).toBe(true);
  });
  it('does not merge a late transcript into a turn that already produced its own text',()=>{
    const {socket,events,session}=build({capture:true});
    take(session,1);
    socket.server('input_audio_buffer.committed',{item_id:'item-1'});
    take(session,2);
    socket.server('input_audio_buffer.committed',{item_id:'item-2'});
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-2',transcript:'汇报一下。'});
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-1',transcript:'这个go界面，它的消耗量'});
    expect(events.filter(event=>event.kind==='text'&&event.role==='user')).toEqual([
      {kind:'text',role:'user',turn:2,text:'汇报一下。'},
    ]);
  });
  it('keeps the ordinary 90-second bound instead of the 60-second diagnostic take bound',()=>{
    const {records,events,session}=build({capture:true});
    session.command({kind:'interrupt',turn:1});
    const frame=pcm(24576,500);
    for(let i=0;i<70;i++)session.command({kind:'audio',turn:1,data:frame,frame:i});
    // 70 frames = 71.7s: past the diagnostic take bound, still inside the ordinary one.
    expect(of(records,'append')).toHaveLength(70);
    expect(of(records,'gap')).toHaveLength(0);
    expect(events.some(event=>event.kind==='state'&&event.state==='error')).toBe(false);
  });
  it('reconnects a capture-only session instead of failing closed on transport loss',()=>{
    const {socket,events,records,session}=build({capture:true});
    take(session);
    socket.emit('error');
    expect(events.some(event=>event.kind==='state'&&event.state==='error')).toBe(false);
    expect(events.some(event=>event.kind==='state'&&event.state==='closed')).toBe(false);
    expect(events.some(event=>event.kind==='state'&&event.state==='connecting'&&event.detail==='正在恢复语音连接，任务不会重复执行。')).toBe(true);
    expect(of(records,'gap')).toHaveLength(0);
    session.close(false);
  });
  it('leaves ordinary voice sessions without diagnostic records',()=>{
    const {socket,records,events,route,session}=build();
    expect(records).toHaveLength(0);
    take(session);
    socket.server('input_audio_buffer.committed',{item_id:'item-1'});
    socket.server('conversation.item.input_audio_transcription.completed',{item_id:'item-1',transcript:'普通语音'});
    expect(records).toHaveLength(0);
    expect(events.some(event=>event.kind==='text'&&event.role==='user')).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
  });
});
