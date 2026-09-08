import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, findServiceWorker, evaluateInWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { normalizeServiceWorkerInspector, installExecuteToolCallHook } from './sw-hook.mjs';

export async function connectParentAcceptance() {
  const { cdp } = await connectBrowser(discoverChromeMain().port);
  const sw = findServiceWorker((await cdp.send('Target.getTargets')).targetInfos, sideagentExtensionId());
  if (!sw) throw Error('Extension worker missing');
  const sid = await cdp.attachSession(sw.targetId);
  await normalizeServiceWorkerInspector(cdp, sid);
  const server = createServer((_req,res) => { res.setHeader('Content-Type','text/html; charset=utf-8'); res.end('<!doctype html><title>父 Agent 页面移交验收</title><h1>父 Agent 页面移交验收</h1><p id="result">保留的 worker 结果</p>'); });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await installExecuteToolCallHook(cdp,sid,sideagentExtensionId(),url);
  let seq=0;
  return { cdp, sid, url,
    tool: (cid, worker, name, params) => evaluateInWorker(cdp,sid,`globalThis.__saCall(${JSON.stringify('parent-test-'+Date.now()+'-'+ ++seq)},${JSON.stringify(name)},${JSON.stringify(params)},${JSON.stringify(worker)},undefined,${JSON.stringify(cid)})`,40000),
    close: async () => {server.closeAllConnections();await new Promise(r=>server.close(r));await cdp.close();}
  };
}
async function main() {
  const output='/tmp/sideagent-parent-tab-evidence'; await mkdir(output,{recursive:true});
  const connection=await connectParentAcceptance();
  const {tool,cdp,sid,url}=connection;
  const cid='parent-tab-'+Date.now(), worker='writer', opened=[];
  const evidence={checks:[],calls:[]};
  const check=(name,ok)=>{evidence.checks.push({name,ok});if(!ok)throw Error(name);console.log('PASS '+name);};
  async function call(name,params={},who=worker,conv=cid) { const r=await tool(conv,who,name,params);evidence.calls.push({name,who,conv,...r});return r; }
  try {
    for(let n=0;n<2;n++){const r=await call('open_tab',{url});if(!r.ok)throw Error(r.error);opened.push(r.data.tabId);}
    check('父 Agent 收回前得到明确提示',(await call('switch_tab',{tabId:opened[0]},'main')).error?.includes('take_tab'));
    check('其他会话不能管理',(await call('worker_tabs',{action:'inspect',tabId:opened[0]},'main',cid+'-other')).error?.includes('其他会话'));
    check('worker 不能自行提权',(await call('worker_tabs',{action:'release',workerId:worker})).error?.includes('只有父'));
    const pending=call('js',{code:'new Promise(r=>{document.querySelector("#result").textContent="正在完成旧操作";setTimeout(()=>{document.querySelector("#result").textContent="旧操作已完成";r("done")},1000)})'});
    // Read-only observation establishes that the old operation has actually started.
    for(let n=0;n<50;n++){const r=await call('read_element',{tabId:opened[1],target:'#result'});if(JSON.stringify(r).includes('正在完成旧操作'))break;if(n===49)throw Error('old operation never started');await new Promise(r=>setTimeout(r,30));}
    const release=call('worker_tabs',{action:'release',workerId:worker},'main');
    const late=await call('js',{code:'document.querySelector("#result").textContent="不应写入"'});
    check('停止后的晚到操作被拒绝',!late.ok&&late.error.includes('worker 已停止'));
    await pending; const moved=await release;
    check('两个历史页面全部交回',moved.ok&&moved.data.tabIds.length===2);
    const read=await call('read_element',{tabId:opened[1],target:'#result'},'main');
    check('父 Agent 读到完整旧操作结果',read.ok&&JSON.stringify(read).includes('旧操作已完成'));
    check('父 Agent 可以切换',(await call('switch_tab',{tabId:opened[0]},'main')).ok);
    for(const tabId of opened) check('父 Agent 关闭 '+tabId,(await call('close_tab',{tabId},'main')).ok);
    const remaining=await evaluateInWorker(cdp,sid,`chrome.tabs.query({}).then(ts=>ts.filter(t=>${JSON.stringify(opened)}.includes(t.id)).map(t=>t.id))`);
    check('Chrome 中页面确实消失',remaining.length===0);
    evidence.ok=true;
  } catch(error) {evidence.ok=false;evidence.error=String(error);process.exitCode=1;}
  finally {await writeFile(output+'/result.json',JSON.stringify(evidence,null,2));for(const id of opened)await evaluateInWorker(cdp,sid,`chrome.tabs.remove(${id}).catch(()=>{})`).catch(()=>{});await connection.close();}
}
if(process.argv[1]?.endsWith('parent-tab-control-run.mjs')) await main();
