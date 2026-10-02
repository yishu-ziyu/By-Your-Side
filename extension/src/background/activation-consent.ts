import type {ServerMessage} from '../../../shared/protocol.js';
import type {WriteConsentRequest} from '../../../shared/consent.js';

type Input = {conversationId:string; runId:string; controlVersion:number; goal:string; tool:string; target:string; value:string; context?:string; cancellationVersion?:number};
type Entry = {request:WriteConsentRequest; expected:string; read:()=>Promise<string>; finish:(allow:boolean)=>void; timer:ReturnType<typeof setTimeout>; deciding?:boolean};

/** Authority lives only in background memory; runtime page messages cannot decide it. */
export class ActivationConsent {
  private readonly pending = new Map<string,Entry>();
  private cancellationVersion=0;
  get version():number {return this.cancellationVersion;}
  constructor(private readonly emit:(message:ServerMessage)=>void, private readonly ttlMs=20_000) {}

  list():WriteConsentRequest[] { return [...this.pending.values()].map(entry=>({...entry.request})); }

  request(input:Input, read:()=>Promise<string>):Promise<boolean> {
    if (input.cancellationVersion !== undefined && input.cancellationVersion !== this.cancellationVersion) return Promise.resolve(false);
    if (this.pending.size >= 32) return Promise.resolve(false);
    const {context, cancellationVersion:_version, ...display} = input;
    const request:WriteConsentRequest = {...display, kind:'write', purpose:'activation', description:'执行下面完整列出的这一组参数；可能触发网站提交或自动保存。', id:'activation-'+crypto.randomUUID(), expiresAt:Date.now()+this.ttlMs};
    return new Promise(resolve=>{
      const finish=(allow:boolean)=>{
        if(!this.pending.delete(request.id))return;
        clearTimeout(entry.timer);
        this.emit({type:'consent_result',conversationId:request.conversationId,requestId:request.id,status:allow?'allowed':'cancelled',message:allow?'仅批准这一次，执行结果请看任务回执。':'本次未获准或已作废，操作未执行。'});
        resolve(allow);
      };
      const entry:Entry={request,expected:context??'same',read,finish,timer:setTimeout(()=>finish(false),this.ttlMs)};
      this.pending.set(request.id,entry);
      this.emit({type:'consent_request',conversationId:request.conversationId,request:{...request}});
    });
  }

  decide(id:string, allow:boolean):boolean {
    const entry=this.pending.get(id);
    if(!entry)return false;
    if(!allow || Date.now()>=entry.request.expiresAt){entry.finish(false);return true;}
    if(entry.deciding)return false;
    // Denial wins even while approval validation is waiting for page state.
    // Reserve only repeated approvals; a removed request can never be revived.
    const decidingVersion=this.cancellationVersion;
    entry.deciding=true;
    void entry.read().then(current=>{
      if(this.pending.get(id)!==entry || this.cancellationVersion!==decidingVersion)return;
      entry.finish(Date.now()<entry.request.expiresAt && current===entry.expected);
    },()=>{
      if(this.pending.get(id)===entry)entry.finish(false);
    });
    return true;
  }

  cancel():void { this.cancellationVersion++; for(const entry of [...this.pending.values()])entry.finish(false); }
}
