import type {ExtensionFactory, ToolResultEvent} from '@earendil-works/pi-coding-agent';

interface RepeatedToolFailure {toolName:string;error:string;attempts:number}

function operationKey(event:Pick<ToolResultEvent,'toolName'|'input'>):string {
  return `${event.toolName}\u0000${stableJson(event.input)}`;
}

function stableJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}

function requiresChangedInput(details:unknown):boolean {
  if(!details||typeof details!=='object'||!('failure' in details))return false;
  const failure=details.failure;
  return !!failure&&typeof failure==='object'&&'kind' in failure&&failure.kind==='invalid_arguments'&&'retry' in failure&&failure.retry==='change_input';
}

function comparableError(error:string):string {
  const ends=['\n[After this program','\n\nFresh snapshot of'].map(mark=>error.indexOf(mark)).filter(at=>at>=0);

  return ends.length>0?error.slice(0,Math.min(...ends)):error;
}

export class RepeatedToolFailurePolicy {
  private failures=new Map<string,{toolName:string;error:string;attempts:number;parameterAttempts:number}>();
  private blocked=new Set<string>();
  constructor(private readonly onRepeat:(failure:RepeatedToolFailure)=>void,private readonly skip?:(toolCallId:string)=>boolean) {}
  reset():void {this.failures.clear();this.blocked.clear();}
  extension():ExtensionFactory {
    return pi=>{
      pi.on('tool_call',event=>{
        const previous=this.failures.get(operationKey(event));
        if(!previous||previous.parameterAttempts<2)return;
        this.blocked.add(event.toolCallId);
        return {block:true,reason:`${previous.error}\n[框架说明] 相同参数已两次得到上面的明确错误，本次没有执行。请按错误说明修改参数或换一种操作；需要页面信息时先重新观察。任务仍可继续。`,details:{repeatedParameterFailure:previous.error}};
      });
      pi.on('tool_result',event=>{
        if(this.blocked.delete(event.toolCallId))return;
        if(event.isError&&this.skip?.(event.toolCallId))return;

        if(!event.isError){this.failures.delete(operationKey(event));

return;}

        const error=event.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
        const key=operationKey(event);
        const previous=this.failures.get(key);
        const same=previous&&comparableError(previous.error)===comparableError(error);
        const attempts=same?previous.attempts+1:1;
        const parameterAttempts=requiresChangedInput(event.details)?same?previous.parameterAttempts+1:1:0;
        this.failures.set(key,{toolName:event.toolName,error,attempts,parameterAttempts});

        if(attempts===2)this.onRepeat({toolName:event.toolName,error,attempts});
      });
    };
  }
}
