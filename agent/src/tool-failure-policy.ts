import type {ExtensionFactory, ToolResultEvent} from '@earendil-works/pi-coding-agent';

export interface RepeatedToolFailure {toolName:string;error:string;attempts:number}

/** Same tool + same input: a different target (e.g. three pages fetched in parallel) is not a retry. */
function operationKey(event:Pick<ToolResultEvent,'toolName'|'input'>):string {
  const args=Object.keys(event.input).sort().map(key=>[key,event.input[key]]);

  return `${event.toolName}\u0000${JSON.stringify(args)}`;
}

/** browser_run 的错误文字后面接着「程序停在哪一页」和那一页的快照，每次都可能不同；只比前面的错误本身。 */
function comparableError(error:string):string {
  const ends=['\n[After this program','\n\nFresh snapshot of'].map(mark=>error.indexOf(mark)).filter(at=>at>=0);

  return ends.length>0?error.slice(0,Math.min(...ends)):error;
}

/**
 * 同一操作第二次出同样的错：宿主调高主模型的思考档位。
 * 不停下本轮：连续出错三次就停的规则已于 10-10 按用户裁决去掉。
 */
export class RepeatedToolFailurePolicy {
  private failures=new Map<string,{toolName:string;error:string;attempts:number}>();
  /** skip：这次出错不是失败（用户在网页上没让发送），既不计数也不清零。 */
  constructor(private readonly onRepeat:(failure:RepeatedToolFailure)=>void,private readonly skip?:(toolCallId:string)=>boolean) {}
  reset():void {this.failures.clear();}
  extension():ExtensionFactory {
    return pi=>{
      pi.on('tool_result',event=>{
        if(event.isError&&this.skip?.(event.toolCallId))return;

        if(!event.isError){for(const [key,failure] of this.failures)if(failure.toolName===event.toolName)this.failures.delete(key);

return;}

        const error=event.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
        const key=operationKey(event);
        const previous=this.failures.get(key);
        const attempts=previous&&comparableError(previous.error)===comparableError(error)?previous.attempts+1:1;
        this.failures.set(key,{toolName:event.toolName,error,attempts});

        if(attempts===2)this.onRepeat({toolName:event.toolName,error,attempts});
      });
    };
  }
}
