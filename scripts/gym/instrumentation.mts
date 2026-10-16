import { until, type launchRealPath } from "../acceptance/real-path/harness.mts";
import { snapshotExpression } from "./evaluator.mjs";
type RP = Awaited<ReturnType<typeof launchRealPath>>;
type Row = Record<string, any>;

export async function installAudit(rp: RP, work: string) {
  const { frameTree } = await rp.cdp.send('Page.getFrameTree', {}, work);
  const { executionContextId } = await rp.cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'gym-observer' }, work);
  await rp.cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: `globalThis.audit=[];for(const type of ['input','change','keydown','click','submit'])document.addEventListener(type,e=>{const el=e.target;audit.push({at:Date.now(),type,trusted:e.isTrusted,key:e.key,name:el.name||'',value:el.type==='checkbox'?el.checked:el.value,text:el.textContent?.slice(0,100),label:el.closest?.('label')?.textContent?.trim()})},true)` }, work);
  return async () => {
    const r = await rp.cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: `({at:Date.now(),state:${snapshotExpression},audit})`, returnByValue: true }, work);
    if(r.exceptionDetails || !r.result?.value) throw new Error('Independent observer unavailable');
    return r.result.value as {at:number;state:Row;audit:Row[]};
  };
}

export async function installBudget(rp: RP, deadline: number, commands: number, fault = 'none') {
  const worker = await until(async () => (await rp.targets()).find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${rp.extensionId}/`)), 10_000, 'worker');
  const sw = await rp.attach(worker.targetId);
  await rp.evaluate(sw, `(()=>{globalThis.gymBudget={used:0,blocked:0,deadline:${deadline},log:[]};const wrap=(object,key)=>{const original=object[key].bind(object);object[key]=async function(...args){const b=gymBudget,method=key==='sendCommand'?args[1]:key;const entry={at:Date.now(),method,status:'not_executed'};const declaration=args[2]?.functionDeclaration;if(method==='Runtime.callFunctionOn'&&typeof declaration==='string'&&declaration.includes('const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;')&&declaration.includes('desc.set.call(el, v)')&&declaration.includes('return { filled: true, range:')){entry.inputAdapter='fill';entry.value=args[2]?.arguments?.[0]?.value}if(Date.now()>=b.deadline||b.used>=${commands}){b.blocked++;b.log.push(entry);throw new Error('Experiment command budget exhausted; action not executed')}b.used++;b.log.push(entry);try{if(entry.inputAdapter){try{const described=await original(args[0],'DOM.describeNode',{objectId:args[2].objectId});const attrs=described.node?.attributes??[],index=attrs.indexOf('name');entry.name=index<0?null:attrs[index+1];entry.backendNodeId=described.node?.backendNodeId}catch{entry.name=null}}const result=await original(...args);entry.status='executed';entry.completedAt=Date.now();if(${JSON.stringify(fault)}==='unknown'&&!b.injected&&method==='Input.dispatchKeyEvent'&&args[2]?.key==='Enter'&&['keyDown','rawKeyDown'].includes(args[2]?.type)){b.injected=true;entry.injected='ack-lost-after-dispatch';throw new Error('Injected lost acknowledgement after dispatch; execution unknown; observe before retrying')}return result}catch(e){entry.status='unknown';throw e}}};wrap(chrome.debugger,'sendCommand');wrap(chrome.scripting,'executeScript');for(const k of ['update','create','remove','reload'])wrap(chrome.tabs,k);return true})()`);
  return { sw, read: () => rp.evaluate(sw, 'gymBudget') };
}

export async function networkUsage(rp: RP) {
  const target = await until(async () => (await rp.targets()).find(t => t.url === `chrome-extension://${rp.extensionId}/inproc.html`), 30_000, 'agent offscreen');
  const session = await rp.attach(target.targetId);
  await rp.evaluate(session, String.raw`(()=>{
    const original=globalThis.fetch.bind(globalThis);globalThis.gymNetwork=[];
    globalThis.fetch=async function(input,init){
      const url=typeof input==='string'?input:input.url;
      if(!/\/(responses|completions)(\?|$)/.test(url))return original(input,init);
      const row={at:Date.now(),status:null,usage:null,parameters:null};gymNetwork.push(row);
      try {const body=JSON.parse(init?.body||'{}');row.parameters={model:body.model,temperature:body.temperature,reasoning:body.reasoning,max_output_tokens:body.max_output_tokens,max_tokens:body.max_tokens};}catch{}
      try {
        const response=await original(input,init);row.status=response.status;
        const reader=response.clone().body?.getReader();
        if(reader)void(async()=>{let buffer='';const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const item=JSON.parse(line.replace(/^data:\s*/,''));const usage=item.response?.usage??item.usage;if(usage)row.usage={input_tokens:usage.input_tokens,prompt_tokens:usage.prompt_tokens,output_tokens:usage.output_tokens,completion_tokens:usage.completion_tokens,total_tokens:usage.total_tokens,cached_tokens:usage.input_tokens_details?.cached_tokens??usage.prompt_tokens_details?.cached_tokens}}catch{}}}}catch{row.streamEndedEarly=true}finally{reader.releaseLock()}})();
        return response;
      }catch(e){row.error=String(e);throw e}
    };return true
  })()`);
  return () => rp.evaluate(session,'gymNetwork') as Promise<Row[]>;
}

