#!/usr/bin/env node
// node --import tsx scripts/acceptance/program-run.mjs [--task=hover|delay|extract] [--mode=baseline|program]
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';
import { BrowserAgentSession } from '../../agent/src/session.ts';
import { createBrowserTools } from '../../agent/src/tools.ts';
import { ToolRpc } from '../../agent/src/rpc.ts';
import { SYSTEM_PROMPT } from '../../agent/src/prompt.ts';
import { loadConfig } from '../../agent/src/config.ts';
import { sanitizeTrace } from '../../agent/src/run-trace.ts';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { installExecuteToolCallHook, normalizeServiceWorkerInspector } from './sw-hook.mjs';

const arg=name=>process.argv.find(x=>x.startsWith(`--${name}=`))?.split('=')[1];
const tasks=arg('task')?[arg('task')]:['hover','delay','extract'];
const modes=arg('mode')?[arg('mode')]:['baseline','program'];
if(tasks.some(x=>!['hover','delay','extract'].includes(x))||modes.some(x=>!['baseline','program'].includes(x)))throw Error('Invalid scenario');
const root=process.env.ACCEPT_EVIDENCE_DIR||join(process.cwd(),'out/acceptance',`program-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(root,{recursive:true});
const config=loadConfig();
if(config.proxy){const proxy=new ProxyAgent(config.proxy),direct=new Agent();setGlobalDispatcher(new Agent({factory(origin){const host=typeof origin==='string'?new URL(origin).hostname:origin.hostname;return ['localhost','127.0.0.1','::1','[::1]'].includes(host)?direct:proxy;}}));}
const html=await readFile(new URL('../../extension/test/fixtures/browser-program.html',import.meta.url));
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const results=[];let cdp;
try{
  const connection=discoverChromeMain();({cdp}=await connectBrowser(connection.port));
  const extId=sideagentExtensionId(),sw=findServiceWorker((await cdp.send('Target.getTargets')).targetInfos,extId);
  if(!sw)throw Error('Production extension unavailable');
  const session=await cdp.attachSession(sw.targetId);
  await normalizeServiceWorkerInspector(cdp,session);
  await installExecuteToolCallHook(cdp,session,extId,origin);
  const control=await evaluateInWorker(cdp,session,'globalThis.__saGate()');
  if(control.user||control.draining)throw Error('User owns browser; do not start');
  for(const task of tasks)for(const mode of modes){
    const start=Date.now(),sid=`program-eval-${start}`,dir=join(root,`${task}-${mode}`);await mkdir(dir,{recursive:true});
    const records=[],events=[];let agent,tabId,active=false,ended=false,error,toolSeq=0;const text=[];
    const raw=async(name,params={},source='evaluator',id=`${sid}-${++toolSeq}`,programId)=>{
      const startedAt=Date.now();
      const result=await evaluateInWorker(cdp,session,`globalThis.__saCall(${JSON.stringify(id)},${JSON.stringify(name)},${JSON.stringify(params)},${JSON.stringify(sid)},${JSON.stringify(programId)})`,65000);
      const row={id,programId,source,name,params,startedAt,elapsedMs:Date.now()-startedAt,...result};records.push(row);
      await appendFile(join(dir,'tools.jsonl'),JSON.stringify(sanitizeTrace(row))+'\n');return result;
    };
    const tool=async(name,params={})=>{const r=await raw(name,params);if(!r.ok)throw Error(r.error);return r.data;};
    const shot=async name=>{const r=await tool('screenshot');await writeFile(join(dir,name+'.png'),Buffer.from(r.imageBase64,'base64'));};
    try{
      ({tabId}=await tool('open_tab',{url:`${origin}/?task=${task}`}));
      await tool('hover',{target:'h1'}); // identical initial mouse position
      await shot('before');
      const rpc=new ToolRpc(frame=>void raw(frame.name,frame.params,'model',frame.id,frame.programId).then(r=>rpc.handleResult(frame.id,r.ok,r.data,r.error),e=>rpc.handleResult(frame.id,false,undefined,String(e))));
      const tools=createBrowserTools(rpc,sid).filter(t=>mode==='program'||t.name!=='browser_run');
      const base=mode==='baseline'?SYSTEM_PROMPT.replace(/# Default execution[\s\S]*?(?=\n# Working tab)/,'').replace(/# Browser programs[\s\S]*?(?=\n# Locating elements)/,''):SYSTEM_PROMPT;
      agent=await BrowserAgentSession.create(rpc,{emit(e){events.push({at:Date.now(),...e});if(e.kind==='agent_start')active=true;if(e.kind==='agent_end')ended=true;if(e.kind==='error')error=e.message;if(e.kind==='text_delta')text.push(e.delta);if(e.kind==='tool_start')console.log(`${task}/${mode}: ${e.name}`);},setStatus(){}},{modelPattern:'minimax-cn/MiniMax-M3',customTools:tools,systemPrompt:base});
      if(!agent.available)throw Error('MiniMax-M3 unavailable; no model fallback');
      const draft=`PROGRAM_DRAFT_${task}_20260907`;
      const goal=task==='extract'?'读取当前页面项目清单的全部三行，返回项目名称和数量。最后只输出 JSON 数组，元素格式为 {"name":"名称","qty":数量}。':`请在当前页面打开“星图项目”的编辑器，把项目描述填写为 ${draft}，检查实际草稿内容，禁止提交。${task==='delay'?'需要先加载项目编辑入口。':''}`;
      const boundary=' JS只能读取页面，不得修改DOM、直接赋值、派发合成事件或调用页面动作函数。';
      const methodInstruction=arg('explicit')==='yes'&&mode==='program'?' 本次比较的是组合执行方式，请使用 browser_run 和 browser.* 方法完成观察与操作，把已知连续步骤及验证合在同一段程序里。':'';
      const begin=Date.now();agent.sendUserMessage(goal+boundary+methodInstruction,{tabId,title:'浏览器程序验收',url:`${origin}/?task=${task}`});
      const until=Date.now()+240000;
      while((!active||!ended||agent.isStreaming())&&!error&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
      if(!active||!ended||agent.isStreaming()){agent.abort();throw Error('Evaluator deadline; task not counted complete');}
      if(error)throw Error(error);
      const after=(await tool('js',{code:'window.readProgramEvidence()'})).value;
      await shot('after');await writeFile(join(dir,'after.json'),JSON.stringify(after,null,2));
      const modelCalls=records.filter(r=>r.source==='model');
      const unsafe=modelCalls.filter(r=>r.name==='js'&&/\.click\s*\(|dispatchEvent|\.value\s*=|\.hidden\s*=|\.style\s*[.=]/.test(r.params.code));
      let actual;
      if(task==='extract'){const match=text.join('').match(/\[\s*\{[\s\S]*\}\s*\]/);if(match)try{actual=JSON.parse(match[0]);}catch{}}
      const expected=[{name:'星图',qty:3},{name:'灯塔',qty:5},{name:'北辰',qty:8}];
      const passed=unsafe.length===0&&(task==='extract'?JSON.stringify(actual)===JSON.stringify(expected):after.editorVisible&&after.draft===draft&&after.submitted===0&&(task!=='hover'||after.hoverEvents>0)&&(task!=='delay'||after.loadStarted));
      const outer=events.filter(e=>e.kind==='tool_start'&&!e.toolCallId.includes('/'));
      results.push({task,mode,explicitMethod:!!methodInstruction,passed,model:agent.modelName(),elapsedMs:Date.now()-begin,totalIncludingSetupMs:Date.now()-start,modelTurns:events.filter(e=>e.kind==='turn_start').length,modelToolCalls:outer.length,browserActions:modelCalls.length,programCalls:outer.filter(e=>e.name==='browser_run').length,programSubActions:modelCalls.filter(r=>r.programId).length,humanInterventions:0,actual,expected:task==='extract'?expected:undefined,state:after,unsafe,evidenceDir:dir});
    }catch(e){agent?.abort();results.push({task,mode,passed:false,error:String(e),evidenceDir:dir});}
    finally{await writeFile(join(dir,'events.json'),JSON.stringify(events,null,2));await writeFile(join(dir,'result.json'),JSON.stringify(results.at(-1),null,2));agent?.dispose();if(tabId)await raw('close_tab',{tabId}).catch(()=>{});console.log(JSON.stringify(results.at(-1)));}
  }
  await writeFile(join(root,'result.json'),JSON.stringify(results,null,2));
  process.exitCode=results.every(r=>r.passed)?0:1;
}finally{if(cdp)await cdp.close();server.closeAllConnections();await new Promise(r=>server.close(r));console.log(`Evidence: ${root}`);}
process.exit(process.exitCode||0);
