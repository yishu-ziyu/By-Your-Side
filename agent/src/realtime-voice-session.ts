import {randomUUID} from 'node:crypto';
import {RealtimeVoiceConnection} from './realtime-voice-connection.js';
import type {StepVoiceSession} from './voice-session.js';
import type {VoiceCommand,VoiceEvent,VoiceInputContext,TaskProgressSnapshot,UserDelivery,UserDeliveryStream} from '../../shared/voice.js';

export type RealtimeVoiceDependencies=ConstructorParameters<typeof StepVoiceSession>[0]&{
  readPage?:(input:VoiceInputContext)=>Promise<unknown>;
  createConnection?:(options:ConstructorParameters<typeof RealtimeVoiceConnection>[0])=>RealtimeVoiceConnection;
};
type Input={turn:number;snapshot:TaskProgressSnapshot|null;input?:VoiceInputContext;error?:string;ready:boolean};
/** Adapts native sidepanel protocol to the same continuous Realtime 3 connection used in the trial. */
export class RealtimeVoiceSession {
  private connection:RealtimeVoiceConnection|null=null;
  private closed=false;
  private ready=false;
  private turn=1;
  private input:Input={turn:1,snapshot:null,ready:false};
  private mutedEmit=false;
  private seq=0;
  private readonly responses=new Map<string,string>();
  private readonly spoken=new Set<string>();
  private readonly notices=new Set<string>();
  private readonly cancelled=new Set<string>();
  constructor(private readonly deps:RealtimeVoiceDependencies){}
  start(key:string):void{
    if(this.closed||this.connection)return;
    this.emit({kind:'state',state:'connecting',detail:'正在连接 Realtime 3'});
    const create=this.deps.createConnection??(o=>new RealtimeVoiceConnection(o));
    this.connection=create({key,connect:this.deps.connect,diagnostic:this.deps.diagnosticMode,
      send:e=>this.receive(e),
      log:e=>this.deps.diagnostic?.(String(e.type),{detail:JSON.stringify(e)}),
      tools:{
        browser_request:async text=>{
          if(this.deps.diagnosticMode||!this.deps.route)throw new Error('此语音连接不能执行任务。');
          const origin=this.input;
          await this.waitForInput(origin);
          if(this.closed||this.input!==origin)throw new Error('这句话的页面资料已过期，未执行操作。');
          const snapshot=origin.snapshot;
          return this.deps.route(text,snapshot?.startedAt??null,()=>!this.closed,{
            requestId:randomUUID(),runId:snapshot?.runId??null,controlVersion:snapshot?.controlVersion,
            voiceId:this.deps.voiceId??'realtime3',turn:origin.turn,input:origin.input,targets:this.deps.getTargets?.(),
          });
        },
        read_page:async()=>{
          if(this.deps.diagnosticMode||!this.deps.readPage)throw new Error('当前没有可读取的页面资料。');
          const origin=this.input;await this.waitForInput(origin);
          if(this.closed||this.input!==origin||!origin.input)throw new Error('页面资料已过期，未读取。');
          return this.deps.readPage(origin.input);
        },
        task_status:async()=>({snapshot:this.deps.getSnapshot(),targets:this.deps.getTargets?.()??[]}),
      }});
    this.connection.start();
  }
  private async waitForInput(origin:Input):Promise<void>{
    const end=Date.now()+5000;
    while(!origin.ready&&!this.closed&&this.input===origin&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
    if(this.closed||this.input!==origin||!origin.ready||origin.error)throw new Error(origin.error??'页面资料没有及时到达，未执行这句话。');
  }
  command(command:VoiceCommand):void{
    if(this.closed)return;
    switch(command.kind){
      case 'stop':this.close();return;
      case 'audio':
        this.connection?.handle({type:'audio',data:command.data});
        if(this.deps.diagnosticMode)this.emit({kind:'diag',record:{type:'append',seq:++this.seq,eventId:`pcm-${this.seq}`,turn:command.turn,frame:command.frame??null,samples:Math.floor(Buffer.from(command.data,'base64').length/2),audio:command.data}});
        return;
      case 'interrupt':
        if(this.deps.diagnosticMode){this.turn=command.turn;this.input={turn:this.turn,snapshot:null,ready:true};}
        this.connection?.handle({type:'stop_speech'});return;
      case 'commit':
        if(this.deps.diagnosticMode){this.emit({kind:'diag',record:{type:'commit',seq:++this.seq,eventId:`commit-${this.seq}`,turn:command.turn}});this.connection?.handle({type:'commit_audio'});return;}
        if(command.turn!==this.input.turn)return;
        this.input.input=command.input;this.input.ready=!command.contextPending;return;
      case 'input_context':
        if(command.turn!==this.input.turn)return;
        this.input.input=command.input;this.input.error=command.error;this.input.ready=true;return;
      case 'playback_done':{
        const delivery=this.responses.get(command.responseId);
        if(delivery){this.deps.onPlayback?.(delivery,'played');this.responses.delete(command.responseId);}
        this.connection?.handle({type:'playback_done',responseId:command.responseId});return;
      }
      default:return;
    }
  }
  private receive(event:Record<string,unknown>):void{
    if(this.closed)return;
    switch(event.type){
      case 'ready':
        this.ready=true;
        this.emit({kind:'state',state:'ready',detail:'Realtime 3 已连接',...(!this.deps.diagnosticMode?{inputMode:'server_vad' as const}:{})});
        if(this.deps.diagnosticMode)this.emit({kind:'diag',record:{type:'ready',sampleRate:24000,maxSeconds:60}});
        return;
      case 'status':
        if(this.ready)this.emit({kind:'state',state:event.phase==='idle'?'ready':'answering',detail:String(event.text??'')});
        return;
      case 'input_start':
        if(this.deps.diagnosticMode)return;
        this.turn++;this.input={turn:this.turn,snapshot:this.deps.getSnapshot(),ready:false};
        this.emit({kind:'input_turn',turn:this.turn});return;
      case 'transcript':{
        const role=event.role==='user'?'user':'assistant';
        if(this.deps.diagnosticMode&&role==='assistant')return;
        if(role==='user'){
          const itemId=typeof event.itemId==='string'?event.itemId:`asr-${this.turn}`;
          this.emit({kind:'diag',record:{type:'asr',turn:this.turn,itemId,outcome:'current',text:String(event.text??'')}});
          this.emit({kind:'diag',record:{type:'forward',turn:this.turn,itemId,text:String(event.text??'')}});
        }
        this.emit({kind:'text',turn:this.turn,role,text:String(event.text??'')});return;
      }
      case 'audio':{
        if(this.deps.diagnosticMode)return;
        const responseId=String(event.responseId);const delivery=this.responses.get(responseId);
        if(delivery&&!this.spoken.has(responseId)){this.spoken.add(responseId);this.deps.onPlayback?.(delivery,'speaking');}
        this.emit({kind:'audio',turn:this.turn,data:String(event.data),responseId,itemId:responseId});return;
      }
      case 'delivery_response':this.responses.set(String(event.responseId),String(event.deliveryId));return;
      case 'response_done':
        if(this.deps.diagnosticMode){this.connection?.handle({type:'playback_done',responseId:event.responseId});return;}
        this.emit({kind:'response_end',turn:this.turn,responseId:String(event.responseId)});return;
      case 'clear_audio':this.emit({kind:'reset_output',turn:this.turn});return;
      case 'error':this.emit({kind:'state',state:'error',detail:String(event.message),recoverable:event.recoverable===true});return;
      case 'closed':this.closed=true;this.ready=false;this.emit({kind:'state',state:'closed'});return;
      default:return;
    }
  }
  private emit(event:VoiceEvent):void{if(!this.mutedEmit)this.deps.emit(event);}
  notify(snapshot:TaskProgressSnapshot):void{
    const delivery=snapshot.conversationContext?.latestDelivery;
    if(delivery&&delivery.runId===snapshot.runId)this.completeDelivery(delivery);
    else this.connection?.notifyTask(`当前任务状态：${JSON.stringify({state:snapshot.state,goal:snapshot.goal,successVerified:snapshot.successVerified})}`);
  }
  streamDelivery(stream:UserDeliveryStream):void{
    // Final, verified delivery is the authority; partial prose never manufactures completion.
    if(stream.phase==='cancelled')this.cancelled.add(stream.id);
  }
  completeDelivery(delivery:Pick<UserDelivery,'id'|'runId'|'kind'|'text'>&{voiceTurn?:number}):void{
    if(this.closed||this.deps.diagnosticMode||this.notices.has(delivery.id)||this.cancelled.has(delivery.id))return;
    this.notices.add(delivery.id);
    this.connection?.notifyTask(delivery.text,delivery.id,()=>{
      const current=this.deps.getDeliverySnapshot?.({...delivery,phase:'streaming'})??this.deps.getSnapshot();
      return !this.closed&&!this.cancelled.has(delivery.id)&&current?.runId===delivery.runId&&!['aborted','error'].includes(current.state);
    });
  }
  close(emit=true):void{
    if(this.closed)return;
    this.closed=true;this.ready=false;this.mutedEmit=!emit;
    this.connection?.close();
    if(emit)this.deps.emit({kind:'state',state:'closed'});
  }
}
