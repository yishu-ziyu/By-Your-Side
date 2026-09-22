import {expect,it} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';

const path=new URL('../src/product-context.ts',import.meta.url).href;

it('手工登记指引只随实际可用入口出现，自动执行 ID 仍进入后续上下文',async()=>{
 const {ProductContext}=await import(path),bridge=new ProductContext();
 const progress=new TaskProgress('default');progress.request('填写星河，不提交');
 progress.observe({type:'agent_event',event:{kind:'tool_start',name:'fill',toolCallId:'write',params:{target:'@4',value:'星河'}}});
 progress.observe({type:'agent_event',event:{kind:'tool_end',name:'fill',toolCallId:'write',isError:true,executionFact:'unknown',resultText:'timeout'}});
 bridge.bind(()=>progress.snapshot());
 const handlers:Record<string,Function>={};let active=['task_goals','resolve_unknown_result'];
 bridge.extension()({on:(name:string,fn:Function)=>{handlers[name]=fn;},getActiveTools:()=>active,getAllTools:()=>active.map(name=>({name}))});
 const modern=await handlers.before_agent_start!({systemPrompt:'base'});
 expect(modern.systemPrompt).not.toContain('record_task_results');
 const id=progress.snapshot().results![0]!.id;
 const projected=await handlers.context!({messages:[]});
 expect(projected.messages[0].content).toContain(id);
 expect(projected.messages[0].content).toContain('unknown');
 active=[...active,'record_task_results'];
 expect((await handlers.before_agent_start!({systemPrompt:'base'})).systemPrompt).toContain('record_task_results');
});

it('registered active capabilities are authoritative; an earlier assistant refusal stays transcript',async()=>{
 const {ProductContext}=await import(path);const bridge=new ProductContext();let handler:any;
 bridge.bind(()=>({conversationId:'A',state:'none',runId:null,goal:null,observedAt:1,startedAt:null,active:[],lastAction:null,successVerified:false,conversationContext:{recentTurns:[{role:'user',text:'圈出X'},{role:'assistant',text:'我不能圈画'}],latestResult:null,latestDelivery:null}}));
 bridge.extension()({on:(name:string,fn:any)=>{if(name==='before_agent_start')handler=fn;},getActiveTools:()=>['mark','new_fixture_capability'],getAllTools:()=>[{name:'mark',description:'Mark a target'},{name:'new_fixture_capability',description:'New capability',promptGuidelines:['Use this tool for the requested test operation']},{name:'disabled_capability',description:'Unavailable'}]});
 const result=await handler({systemPrompt:'base'});expect(result.systemPrompt).toContain('new_fixture_capability');expect(result.systemPrompt).toContain('Use this tool for the requested test operation');expect(result.systemPrompt).not.toContain('disabled_capability');expect(result.systemPrompt).toContain('我不能圈画');expect(result.systemPrompt).toContain('conversationHistory');expect(result.systemPrompt).not.toContain('"facts":"我不能圈画"');expect(result.systemPrompt).toContain('不是能力事实');
});

it('ledger projection keeps delivery exactly-once and independent of resultState',async()=>{
 const {ProductContext}=await import(path);const bridge=new ProductContext();let ctx:any;bridge.bind(()=>({conversationId:'A',state:'running',runId:'r',goal:'暂停视频',observedAt:1,startedAt:1,active:[],lastAction:null,successVerified:false,results:[{id:'auto-1',description:'点击「暂停按钮」',tool:'click',target:'@18',status:'satisfied',evidence:null}],resultState:'satisfied',conversationContext:{recentTurns:[],latestResult:null,latestDelivery:null}}));bridge.extension()({on:(name:string,fn:any)=>{if(name==='context')ctx=fn;},getActiveTools:()=>[],getAllTools:()=>[]});const out=await ctx({messages:[]});const text=out.messages[0].content as string;expect(text).toContain('与resultState无关');expect(text).toContain('不重复交付');expect(text).toContain('不代表已经向用户交付');});

it('task reports are identified as assistant reports rather than environment verification',async()=>{
 const {ProductContext}=await import(path);const bridge=new ProductContext();let handler:any;bridge.bind(()=>({conversationId:'A',state:'idle',runId:'r',goal:'圈X',observedAt:1,startedAt:1,active:[],lastAction:null,successVerified:false,conversationContext:{recentTurns:[],latestResult:{runId:'r',text:'我找到了X',observedAt:1,source:'assistant_output'},latestDelivery:null}}));bridge.extension()({on:(_n:string,fn:any)=>handler=fn,getActiveTools:()=>[],getAllTools:()=>[]});const result=await handler({systemPrompt:'base'});expect(result.systemPrompt).toContain('assistant_output');expect(result.systemPrompt).toContain('successVerified');expect(result.systemPrompt).not.toContain('"successVerified":true');
});
