/** Actual production Pi sessions/Fleet plus real extension tool execution; no simulated model replies. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createConversationRuntime } from '../../agent/src/conversation-runtime.js';
import { connectParentAcceptance } from './parent-tab-control-run.mjs';
import type { ServerMessage } from '../../shared/protocol.js';

const output='/tmp/sideagent-parent-model-evidence';
await mkdir(output,{recursive:true});
const connection=await connectParentAcceptance();
const cid='parent-model-'+Date.now();
const events: ServerMessage[]=[];
const checks: {name:string;ok:boolean}[]=[];
let runtime: Awaited<ReturnType<typeof createConversationRuntime>>;
let started=false;
const bridge=new Set<Promise<unknown>>();
const emit=(msg:ServerMessage)=>{
  events.push(msg);
  if(msg.type==='status' && !msg.sessionId && msg.state==='running') started=true;
  if(msg.type==='tool_call') {
    console.log(`TOOL ${msg.sessionId??'main'} ${msg.name}`);
    const job=connection.tool(cid,msg.sessionId??'main',msg.name,msg.params).then((result:any)=>runtime.handleMessage({...result,id:msg.id}));
    bridge.add(job);void job.finally(()=>bridge.delete(job)).catch(()=>{});
  }
};
async function task(text:string) {
  started=false;
  runtime.handleMessage({type:'user_message',text});
  const until=Date.now()+600000;
  while(Date.now()<until){
    if(started&&!runtime.session.isStreaming()&&runtime.fleet.size===0&&bridge.size===0)return;
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('Real model task timed out');
}
function check(name:string,ok:boolean){checks.push({name,ok});if(!ok)throw Error(name);console.log('PASS '+name);}
try {
  runtime=await createConversationRuntime(cid,emit,'minimax-cn/MiniMax-M3');
  check('生产模型会话可用',runtime.session.available);
  if (process.argv.includes('--seed-worker')) {
    await runtime.fleet.spawn({ id: 'reader', url: connection.url, goal: `读取当前页面正文，再用 open_tab 新开一个 ${connection.url} 页面并读取正文，然后结束任务。必须保留这两个页面，不要关闭。` });
    const until=Date.now()+600000;
    while(runtime.fleet.size||bridge.size){if(Date.now()>until)throw Error('worker timeout');await new Promise(r=>setTimeout(r,100));}
  } else await task(`这是浏览器功能验收，请派一名 worker，spawn_worker 的 url 参数设为 ${connection.url}，这样初始页直接打开目标地址，不产生额外空白页。让它读取这个初始页面正文，再用 open_tab 新开第二个相同网址页面，读取正文后 post done 给你并结束。两个页面都保留，暂时不要关闭。你等待 worker 真正结束后汇报。必须实际派 worker，不要自己代做。`);
  const before=await connection.tool(cid,'main','list_tabs',{});
  console.log("BEFORE",JSON.stringify(before));
  check('真实 worker 留下两个页面',before.ok&&before.data.tabs.length===2);
  const spawned=events.some(msg=>msg.type==='agent_event'&&msg.event.kind==='tool_start'&&msg.event.name==='spawn_worker');
  if (!process.argv.includes('--seed-worker')) check('模型实际调用 spawn_worker',spawned);
  else check('真实 worker 执行了页面操作',events.some(msg=>msg.type==='tool_call'&&!!msg.sessionId&&['snapshot','read_element'].includes(msg.name)));
  await task('现在请关闭本会话 worker 打开的全部测试页面。用 list_tabs 看一下，然后直接关闭，不需要我手动关闭。');
  const after=await connection.tool(cid,'main','list_tabs',{});
  check('父 Agent 清理后 Chrome 页面全部关闭',after.ok&&after.data.tabs.length===0);
  await writeFile(output+'/result.json',JSON.stringify({ok:true,cid,model:runtime.session.modelName(),checks,events},null,2));
} catch(error) {
  await writeFile(output+'/result.json',JSON.stringify({ok:false,cid,checks,error:String(error),events},null,2));
  console.error(error);process.exitCode=1;
} finally {
  runtime?.dispose();await Promise.allSettled([...bridge]);
  const remaining=await connection.tool(cid,'main','list_tabs',{}).catch(()=>null);
  for(const tab of remaining?.data?.tabs??[])await connection.tool(cid,'main','close_tab',{tabId:tab.id}).catch(()=>{});
  await connection.close();
}
