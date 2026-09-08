/** Production ConversationManager/Fleet/RPC and Chrome handlers, with controlled local pages. No model-planning test. */
import { mkdir, writeFile } from 'node:fs/promises';
import { ConversationManager } from '../../agent/src/conversation-manager.js';
import { createConversationRuntime } from '../../agent/src/conversation-runtime.js';
import { createBrowserTools } from '../../agent/src/tools.js';
import { connectParentAcceptance } from './parent-tab-control-run.mjs';
import { evaluateInWorker } from './cdp.mjs';
const output='/tmp/sideagent-lead-global-evidence';await mkdir(output,{recursive:true});
const connection=await connectParentAcceptance();const {cdp,sid,url}=connection;
const tabs:number[]=[],checks:any[]=[];
let manager:ConversationManager;
manager=new ConversationManager((id,emit)=>createConversationRuntime(id,emit,'minimax-cn/MiniMax-M3'),msg=>{
  if(msg.type==='tool_call') void connection.tool(msg.conversationId,msg.sessionId??'main',msg.name,msg.params).then((r:any)=>manager.get(msg.conversationId!)!.runtime.handleMessage({...r,id:msg.id}));
});
const check=(name:string,ok:boolean)=>{checks.push({name,ok});if(!ok)throw Error(name);console.log('PASS '+name);};
try {
  await manager.handleMessage({type:'conversation_create',requestId:'source'});
  await manager.handleMessage({type:'conversation_create',requestId:'requester'});
  const [a,b]=manager.list().map(c=>manager.get(c.id)!);
  const source=a.runtime,lead=b.runtime;
  const own=await source.rpc.call('open_tab',{url}) as any;tabs.push(own.tabId);
  const worker=await source.rpc.call('open_tab',{url},undefined,'unrelated-worker') as any;tabs.push(worker.tabId);
  const free=await evaluateInWorker(cdp,sid,`chrome.tabs.create({url:${JSON.stringify(url)},active:false}).then(t=>t.id)`);tabs.push(free);
  const list=await lead.rpc.call('list_tabs',{}) as any;
  check('主 Agent 看见用户页和其他会话页',tabs.every(id=>list.tabs.some((t:any)=>t.id===id)));
  const limited=await source.rpc.call('list_tabs',{},undefined,'unrelated-worker') as any;
  check('worker 仅列出自己分配的页面',limited.tabs.length===1&&limited.tabs[0].id===worker.tabId);
  const read=await lead.rpc.call('read_element',{tabId:own.tabId,target:'body'}) as any;
  check('主 Agent 跨会话直接读取',read.textContent.includes('保留的 worker 结果'));
  const snap=await lead.rpc.call('snapshot',{tabId:own.tabId}) as any;
  check('主 Agent 按 tabId 获取页面结构',snap.text.includes('页面移交验收'));
  const resources=()=>evaluateInWorker(cdp,sid,`chrome.storage.session.get('tabResources').then(s=>s.tabResources)`);
  check('读取保留原页面归属',(await resources())[String(own.tabId)].conversationId===a.summary.id);
  const old=source.rpc.call('js',{code:'new Promise(r=>{document.querySelector("#result").textContent="进行中";setTimeout(()=>{document.querySelector("#result").textContent="已完成";r(true)},1000)})'});
  for(let n=0;n<50;n++){const v=await lead.rpc.call('read_element',{tabId:own.tabId,target:'#result'}) as any;if(v.textContent==='进行中')break;if(n===49)throw Error('old operation not started');await new Promise(r=>setTimeout(r,20));}
  await lead.fleet.takeTab(own.tabId);await old;
  check('生产协调链完成跨会话移交',(await resources())[String(own.tabId)].conversationId===b.summary.id);
  const after=await lead.rpc.call('read_element',{tabId:own.tabId,target:'#result'}) as any;
  check('接手等待旧操作完成',after.textContent==='已完成');
  check('未接手的 worker 页面保持原归属',(await resources())[String(worker.tabId)].conversationId===a.summary.id);
  const unaffected=await source.rpc.call('read_element',{target:'body'},undefined,'unrelated-worker') as any;
  check('无关 worker 继续读取自己的页',unaffected.textContent.includes('保留的 worker 结果'));
  const close=createBrowserTools(lead.rpc,undefined,id=>lead.fleet.takeTab(id)).find(t=>t.name==='close_tab')!;
  await close.execute('close-test',{tabId:own.tabId},undefined,undefined,undefined as never);
  const exists=await evaluateInWorker(cdp,sid,`chrome.tabs.get(${own.tabId}).then(()=>true,()=>false)`);
  check('主 Agent 实际关闭接手的页面',!exists);
  await writeFile(output+'/result.json',JSON.stringify({ok:true,checks},null,2));
}catch(error){await writeFile(output+'/result.json',JSON.stringify({ok:false,error:String(error),checks},null,2));console.error(error);process.exitCode=1;}
finally{for(const c of manager.list())manager.get(c.id)?.runtime.dispose();for(const id of tabs)await evaluateInWorker(cdp,sid,`chrome.tabs.remove(${id}).catch(()=>{})`).catch(()=>{});await connection.close();}
