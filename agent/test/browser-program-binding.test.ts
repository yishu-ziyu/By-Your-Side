import {describe,it,expect,vi} from 'vitest';
import {BrowserAgentSession} from '../src/session.js';
import {TaskProgress} from '../src/task-progress.js';
import {ToolRpc} from '../src/rpc.js';
import {createBrowserTools} from '../src/tools.js';

describe('browser program production result binding',()=>{
 it('binds a declared substep before its preflight, independently of asynchronous SDK progress delivery',async()=>{
  const progress=new TaskProgress('default');progress.request('点击当前按钮');
  progress.registerResults([{id:'click',description:'点击当前按钮',tool:'click',target:'#button'}]);
  const frames:any[]=[];
  const rpc=new ToolRpc(frame=>{frames.push(frame);queueMicrotask(()=>rpc.handleResult(frame.id,true,{clicked:true}));});
  const session:any=new (BrowserAgentSession as any)(null,null,{emit:(event:any)=>progress.observe({type:'agent_event',conversationId:'default',event}),setStatus:()=>{}},null,null,30000,null,rpc);
  session.bindConversationContext(()=>progress.snapshot());
  const execution:any={epoch:()=>0,canWrite:()=>true,assertCall:(name:string,params:Record<string,unknown>,id?:string)=>session.assertTaskResultExecution(name,params,id),onStep:(step:import("../src/browser-program.js").ProgramStep)=>session.observeProgramStep(step)};
  const program=createBrowserTools(rpc,undefined,undefined,()=>true,execution).find(t=>t.name==='browser_run')!;
  const sdkProgress=vi.fn(); // Pi may deliver progress after execute has returned control.
  await program.execute('program',{code:'await browser.click({target:"#button"}); return "done";'},undefined,sdkProgress,{} as any);
  expect(frames).toHaveLength(1);
  expect(progress.snapshot().results?.[0]).toMatchObject({status:'satisfied',evidence:{toolCallId:'program/1'}});
  expect(sdkProgress).not.toHaveBeenCalled(); // Direct production observation is the sole event source.
 });
});
