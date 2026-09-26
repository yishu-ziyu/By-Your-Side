import {expect,it,vi} from 'vitest';
import {judgeRealtimeBrowserAction} from '../src/realtime-browser-judge.js';
import {REALTIME_BROWSER_TOOLS,validateRealtimeBrowserTool} from '../src/realtime-browser-tools.js';
import {createBrowserTools} from '../src/tools.js';
import type {ToolRpc} from '../src/rpc.js';
import type {JevAnswers,JevRequest} from '../src/jev-client.js';

/** Scripted Jev by question name; a choice names a criteria key, resolved here by control name. */
function jev(policy:(q:string,state:Record<string,any>,id:(name:string)=>string)=>unknown){
  return vi.fn(async(request:JevRequest):Promise<JevAnswers>=>Object.fromEntries(Object.entries(request.questions).map(([name,question])=>{
    const criteria=((question as {criteria?:Record<string,string>}).criteria??{}) as Record<string,string>;
    const id=(n:string)=>Object.entries(criteria).find(([key,d])=>key!=='none'&&d.includes(`"${n}"`))?.[0]??'none';

    return [name,policy(name,request.state,id)];
  })) as JevAnswers);
}

const pick=(choice:string,confidence=.99)=>({choice,confidence});

const yes=(noul:number)=>({noul});

it('host observes controls; Jev picks one; the guarded suggestion runs only through the later existing tool',async()=>{
  const page={id:'observation-1',observedAt:1,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'Choose language',truncated:false,
    controls:[{ref:'@8',role:'button',name:'中文',disabled:false},{ref:'@9',role:'button',name:'English',disabled:false}]};

  const calls:Array<{name:string;params:Record<string,unknown>}>=[];

  const rpc={getPageTarget:()=>7,call:vi.fn(async(name:string,params:Record<string,unknown>)=>{
    calls.push({name,params});

    if(name==='snapshot')return {observation:page};

    return {clicked:true};
  })} as unknown as ToolRpc;

  const ask=jev((q,_state,id)=>({target:pick(id('中文'),.98),target_listed:yes(.99),opener:pick('none'),risky:yes(.02)} as Record<string,unknown>)[q]);
  const result=await judgeRealtimeBrowserAction(rpc,{request:'找中文按钮',userTask:'点击中文，不保存',history:[]},new AbortController().signal,ask);
  expect(calls.map(c=>c.name)).toEqual(['snapshot']);
  // The user's whole task travels with the step, so a later constraint ("不保存") is visible to Jev.
  expect(ask.mock.calls[0]![0].state.request).toEqual({task:'找中文按钮',whole_task:'点击中文，不保存'});
  expect(REALTIME_BROWSER_TOOLS.some(t=>t.function.name==='judge_browser_action')).toBe(true);
  expect(result.status).toBe('suggestion');

  if (!('suggestion' in result) || !result.suggestion) throw new Error('Expected suggestion');
  const suggestion=result.suggestion;
  validateRealtimeBrowserTool(suggestion.tool,suggestion.arguments);
  const click=createBrowserTools(rpc).find(t=>t.name===suggestion.tool)!;
  await click.execute('execute-after-judgment',suggestion.arguments as never,undefined,undefined,{} as never);
  expect(calls.map(c=>c.name)).toEqual(['snapshot','click']);
  expect(calls[1]!.params).toMatchObject({tabId:7,target:'@8',decisionGuard:{observationId:page.id,operation:'click',target:'@8'}});
});

it('uncertainty or cancellation returns no executable suggestion and never writes',async()=>{
  const page={id:'p1',tabId:7,documentId:'d1',url:'https://example.test',observedAt:1,source:'accessibility',text:'page',truncated:false,controls:[{ref:'@1',role:'button',name:'Maybe',disabled:false}]};
  const rpc={getPageTarget:()=>7,call:vi.fn(async()=>({observation:page}))} as unknown as ToolRpc;
  const input={request:'找按钮',userTask:'找按钮',history:[]};
  const ask=jev((q,_state,id)=>({target:pick(id('Maybe'),.5),target_listed:yes(.9),opener:pick('none')} as Record<string,unknown>)[q]);
  const result=await judgeRealtimeBrowserAction(rpc,input,new AbortController().signal,ask);
  expect(result).toMatchObject({status:'uncertain',reasonCode:'low_confidence'});expect(result).not.toHaveProperty('suggestion');
  const cancelled=new AbortController();cancelled.abort();
  await expect(judgeRealtimeBrowserAction(rpc,input,cancelled.signal,ask)).rejects.toThrow();
  expect(rpc.call).toHaveBeenCalledTimes(1);expect(ask).toHaveBeenCalledTimes(1);
});

it('returns a guarded hover suggestion without executing; the caller judges again before clicking',async()=>{
  const page={id:'observation-hover',observedAt:1,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'menu',truncated:false,
    controls:[{ref:'@3',role:'generic',name:'Account',disabled:false}]};

  const rpc={getPageTarget:()=>7,call:vi.fn(async(name:string)=>{
    if(name==='snapshot')return {observation:page};
    throw new Error(`unexpected ${name}`);
  })} as unknown as ToolRpc;

  const ask=jev((q,_state,id)=>({target:pick('none',.8),target_listed:yes(.2),opener:pick(id('Account'),.97)} as Record<string,unknown>)[q]);
  const result=await judgeRealtimeBrowserAction(rpc,{request:'展开账户菜单',userTask:'悬停账户再点设置',history:[]},new AbortController().signal,ask);
  expect(rpc.call).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('suggestion');

  if (!('suggestion' in result) || !result.suggestion) throw new Error('Expected suggestion');
  validateRealtimeBrowserTool(result.suggestion.tool,result.suggestion.arguments);
  expect(result.suggestion.tool).toBe('hover');
  expect(result.suggestion.arguments).toMatchObject({
    tabId:7,target:'@3',decisionGuard:{observationId:'observation-hover',operation:'hover',target:'@3'},
  });
});

it('a risky write is never suggested; it asks for the user instead',async()=>{
  const page={id:'o',observedAt:1,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'',truncated:false,controls:[{ref:'@4',role:'button',name:'Delete account',disabled:false}]};
  const rpc={getPageTarget:()=>7,call:vi.fn(async()=>({observation:page}))} as unknown as ToolRpc;
  const ask=jev((q,_state,id)=>({target:pick(id('Delete account')),target_listed:yes(.99),opener:pick('none'),risky:yes(.94)} as Record<string,unknown>)[q]);
  const result=await judgeRealtimeBrowserAction(rpc,{request:'删掉账号',userTask:'删掉账号',history:[]},new AbortController().signal,ask);
  expect(result).toMatchObject({status:'uncertain',reasonCode:'permission_required'});
  expect(result).not.toHaveProperty('suggestion');
});

it('reads unread partitions itself before saying the control is not there',async()=>{
  const scopes=[{id:'s1',label:'region A',count:1,complete:true},{id:'s2',label:'region B',count:1,complete:true}];

  const views:Record<string,unknown>={
    s1:{id:'o1',observedAt:1,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'',truncated:false,viewScopeId:'s1',viewScopeLabel:'region A',scopes,controls:[{ref:'@1',role:'button',name:'Early',disabled:false}]},
    s2:{id:'o2',observedAt:2,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'',truncated:false,viewScopeId:'s2',viewScopeLabel:'region B',scopes,controls:[{ref:'@2',role:'button',name:'Late',disabled:false}]},
  };

  const rpc={getPageTarget:()=>7,call:vi.fn(async(_name:string,params:Record<string,unknown>)=>({observation:views[(params.viewScopeId as string)??'s1']}))} as unknown as ToolRpc;
  const ask=jev((q,state,id)=>({target:pick(id('Late')),target_listed:yes(Object.values(state.controls??{}).some(d=>String(d).includes('"Late"'))?.99:.02),opener:pick('none'),risky:yes(.02)} as Record<string,unknown>)[q]);
  const result=await judgeRealtimeBrowserAction(rpc,{request:'点 Late',userTask:'点 Late',history:[]},new AbortController().signal,ask);
  expect(result).toMatchObject({status:'suggestion',suggestion:{tool:'click',arguments:{target:'@2',decisionGuard:{observationId:'o2'}}}});

  const none=jev((q)=>({target:pick('none'),target_listed:yes(.01),opener:pick('none')} as Record<string,unknown>)[q]);
  const missing=await judgeRealtimeBrowserAction(rpc,{request:'点 Missing',userTask:'点 Missing',history:[]},new AbortController().signal,none);
  expect(missing).toMatchObject({status:'uncertain',reasonCode:'no_match'});
  expect(none).toHaveBeenCalledTimes(2);
});

it('disabled click tool yields no click suggestion on the realtime judge path',async()=>{
  const page={id:'p-disable',observedAt:1,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'x',truncated:false,
    controls:[{ref:'@8',role:'button',name:'中文',disabled:false}]};

  const rpc={getPageTarget:()=>7,call:vi.fn(async()=>({observation:page}))} as unknown as ToolRpc;
  const ask=jev((q,_state,id)=>({target:pick(id('中文')),target_listed:yes(.99),opener:pick('none'),risky:yes(.02)} as Record<string,unknown>)[q]);

  const result=await judgeRealtimeBrowserAction(
    rpc,
    {request:'点中文',userTask:'点中文',history:[],canExecute:name=>name!=='click'&&name!=='hover',continueMount:{directBrowser:true,taskAction:true,browserRequest:true}},
    new AbortController().signal,
    ask,
  );

  expect(result).toMatchObject({status:'uncertain',reasonCode:'unsupported_action'});
  expect(result).not.toHaveProperty('suggestion');
  expect(result.continue?.tools).toContain('task_action');
  expect(result.continue?.tools ?? []).not.toContain('browser_loop');
});
