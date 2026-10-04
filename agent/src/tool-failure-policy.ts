import type {ExtensionFactory, ToolResultEvent} from '@earendil-works/pi-coding-agent';
import {TOOL_FAILURE_LIMIT} from '../../shared/task-next-step.js';

export interface RepeatedToolFailure {toolName:string;error:string;attempts:number}

/** Same tool + same input: a different target (e.g. three pages fetched in parallel) is not a retry. */
function operationKey(event:Pick<ToolResultEvent,'toolName'|'input'>):string {
  const args=Object.keys(event.input).sort().map(key=>[key,event.input[key]]);

  return `${event.toolName}\u0000${JSON.stringify(args)}`;
}

/** Stop an unchanged failing operation; observations alone cannot make it retryable. */
export class RepeatedToolFailurePolicy {
  private failures=new Map<string,{toolName:string;error:string;attempts:number}>();
  private stopped=false;
  /** onRepeat: the same operation just failed a second time in a row (not yet stopped) — the host raises the main thinking level. */
  /** skip：这次出错不是失败（重复一步已成功的写入被闸门拦下），既不计数也不清零。 */
  constructor(private readonly onStop:(failure:RepeatedToolFailure)=>void,private readonly onRepeat?:(failure:RepeatedToolFailure)=>void,private readonly skip?:(toolCallId:string)=>boolean) {}
  reset():void {this.failures.clear();this.stopped=false;}
  extension():ExtensionFactory {
    return pi=>{
      pi.on('tool_result',(event,ctx)=>{
        if(this.stopped||(event.isError&&this.skip?.(event.toolCallId)))return;

        if(!event.isError){for(const [key,failure] of this.failures)if(failure.toolName===event.toolName)this.failures.delete(key);

return;}

        const error=event.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
        const key=operationKey(event);
        const previous=this.failures.get(key);
        const attempts=previous?.error===error?previous.attempts+1:1;
        this.failures.set(key,{toolName:event.toolName,error,attempts});

        if(attempts<TOOL_FAILURE_LIMIT){if(attempts===2)this.onRepeat?.({toolName:event.toolName,error,attempts});

return;}

        this.stopped=true;
        this.onStop({toolName:event.toolName,error,attempts});
        ctx.abort();
      });
    };
  }
}
