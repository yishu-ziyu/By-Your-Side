import type {ServerMessage,ClientMessage} from '../../shared/protocol.js';
export type TaskControlAction='pause'|'resume'|'abort';
type Result=Extract<ClientMessage,{type:'task_control_result'}>;
/** Final acknowledgement comes from the extension after local page ownership is applied. */
export class TaskControlBroker {
  private readonly pending=new Map<string,{conversationId:string;requestId:string;action:TaskControlAction;runId:string;resolve:(r:Result)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private readonly emit:(m:ServerMessage)=>void,private readonly timeoutMs=45000){}
  request(conversationId:string,requestId:string,action:TaskControlAction,runId:string,scope?:'task'|'page',tabId?:number):Promise<Result>{
    const key=`${conversationId}:${requestId}`;
    if(this.pending.has(key))return Promise.reject(new Error('Control request already pending'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(key);reject(new Error('Page control confirmation timeout'));},this.timeoutMs);timer.unref?.();
      this.pending.set(key,{conversationId,requestId,action,runId,resolve,reject,timer});
      try{this.emit({type:'task_control',conversationId,requestId,action,runId,...(scope?{scope}:{}),...(tabId?{tabId}:{})});}
      catch(error){clearTimeout(timer);this.pending.delete(key);reject(error instanceof Error?error:new Error('Control unavailable'));}
    });
  }
  permits(conversationId:string,requestId:string,action:TaskControlAction,runId:string|null):boolean{
    const p=this.pending.get(`${conversationId}:${requestId}`);return !!p&&p.action===action&&p.runId===runId;
  }
  receive(message:Result):boolean{
    const key=`${message.conversationId}:${message.requestId}`,p=this.pending.get(key);
    if(!p||p.action!==message.action||p.runId!==message.runId)return false;
    clearTimeout(p.timer);this.pending.delete(key);p.resolve(message);return true;
  }
  disconnect():void{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Extension disconnected during control'));}this.pending.clear();}
}
