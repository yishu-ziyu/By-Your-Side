import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';

export interface RepeatedToolFailure {toolName:string;error:string;attempts:number}

/** Stop an unchanged failing operation; observations alone cannot make it retryable. */
export class RepeatedToolFailurePolicy {
  private failures=new Map<string,{error:string;attempts:number}>();
  private stopped=false;
  constructor(private readonly onStop:(failure:RepeatedToolFailure)=>void) {}
  reset():void {this.failures.clear();this.stopped=false;}
  extension():ExtensionFactory {
    return pi=>{
      pi.on('tool_result',(event,ctx)=>{
        if(this.stopped)return;
        if(!event.isError){this.failures.delete(event.toolName);return;}
        const error=event.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
        const previous=this.failures.get(event.toolName);
        const attempts=previous?.error===error?previous.attempts+1:1;
        this.failures.set(event.toolName,{error,attempts});
        if(attempts<3)return;
        this.stopped=true;
        this.onStop({toolName:event.toolName,error,attempts});
        ctx.abort();
      });
    };
  }
}
