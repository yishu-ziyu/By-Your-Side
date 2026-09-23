import {expect,it,vi} from 'vitest';
import {judgeRealtimeBrowserAction} from '../src/realtime-browser-judge.js';
import {REALTIME_BROWSER_TOOLS,validateRealtimeBrowserTool} from '../src/realtime-browser-tools.js';
import {createBrowserTools} from '../src/tools.js';
import type {ToolRpc} from '../src/rpc.js';
import type {BrowserDecisionInput} from '../src/browser-decision-model.js';

it('host observes candidates; Jev returns a guarded suggestion; only the later existing tool executes',async()=>{
  const page={id:'observation-1',observedAt:1,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'Choose language',truncated:false,
    controls:[{ref:'@8',role:'button',name:'中文',disabled:false},{ref:'@9',role:'button',name:'English',disabled:false}]};

  const calls:Array<{name:string;params:Record<string,unknown>}>=[];

  const rpc={getPageTarget:()=>7,call:vi.fn(async(name:string,params:Record<string,unknown>)=>{
    calls.push({name,params});

    if(name==='snapshot')return {observation:page};

    return {clicked:true};
  })} as unknown as ToolRpc;

  const decide=vi.fn(async(input:BrowserDecisionInput)=>({observationId:input.page.id,candidateId:input.candidates.find(c=>c.target==='@8')!.id,confidence:.98,model:'fixture'}));
  const result=await judgeRealtimeBrowserAction(rpc,{request:'找中文按钮',userTask:'点击中文，不保存',history:[]},new AbortController().signal,decide);
  expect(calls.map(c=>c.name)).toEqual(['snapshot']);
  expect(decide.mock.calls[0]![0].goal).toContain('不保存');
  expect(REALTIME_BROWSER_TOOLS.some(t=>t.function.name==='judge_browser_action')).toBe(true);
  expect(result.status).toBe('suggestion');

  if (!('suggestion' in result)) throw new Error('Expected suggestion');
  const suggestion=result.suggestion;
  validateRealtimeBrowserTool(suggestion.tool,suggestion.arguments);
  const click=createBrowserTools(rpc).find(t=>t.name===suggestion.tool)!;
  await click.execute('execute-after-judgment',suggestion.arguments as never,undefined,undefined,{} as never);
  expect(calls.map(c=>c.name)).toEqual(['snapshot','click']);
  expect(calls[1]!.params).toMatchObject({tabId:7,target:'@8',decisionGuard:{observationId:page.id,operation:'click',target:'@8'}});
});

it('uncertainty or cancellation returns no executable suggestion and never writes',async()=>{
  const page={id:'p1',tabId:7,documentId:'d1',url:'https://example.test',observedAt:1,source:'accessibility',text:'page',truncated:false,controls:[]};
  const rpc={getPageTarget:()=>7,call:vi.fn(async()=>({observation:page}))} as unknown as ToolRpc;
  const input={request:'找按钮',userTask:'找按钮',history:[]};
  const decide=vi.fn(async()=>({observationId:'p1',candidateId:'missing',confidence:.5,model:'fixture'}));
  const result=await judgeRealtimeBrowserAction(rpc,input,new AbortController().signal,decide);
  expect(result.status).toBe('uncertain');expect(result).not.toHaveProperty('suggestion');
  const cancelled=new AbortController();cancelled.abort();
  await expect(judgeRealtimeBrowserAction(rpc,input,cancelled.signal,decide)).rejects.toThrow();
  expect(rpc.call).toHaveBeenCalledTimes(1);expect(decide).toHaveBeenCalledTimes(1);
});

it('returns a guarded hover suggestion without executing; caller must reobserve before click',async()=>{
  const page={id:'observation-hover',observedAt:1,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'menu',truncated:false,
    controls:[{ref:'@3',role:'button',name:'Account',disabled:false}]};

  const rpc={getPageTarget:()=>7,call:vi.fn(async(name:string)=>{
    if(name==='snapshot')return {observation:page};
    throw new Error(`unexpected ${name}`);
  })} as unknown as ToolRpc;

  const decide=vi.fn(async(input:BrowserDecisionInput)=>{
    const hover=input.candidates.find(c=>c.operation==='hover'&&c.target==='@3');
    expect(hover).toBeTruthy();

    return {observationId:input.page.id,candidateId:hover!.id,confidence:.97,model:'fixture'};
  });

  const result=await judgeRealtimeBrowserAction(rpc,{request:'展开账户菜单',userTask:'悬停账户再点设置',history:[]},new AbortController().signal,decide);
  expect(rpc.call).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('suggestion');

  if (!('suggestion' in result)) throw new Error('Expected suggestion');
  validateRealtimeBrowserTool(result.suggestion.tool,result.suggestion.arguments);
  expect(result.suggestion.tool).toBe('hover');
  expect(result.suggestion.arguments).toMatchObject({
    tabId:7,target:'@3',decisionGuard:{observationId:'observation-hover',operation:'hover',target:'@3'},
  });
});

it('disabled click tool yields no click suggestion on the realtime judge path',async()=>{
  const page={id:'p-disable',observedAt:1,tabId:7,documentId:'d1',url:'https://example.test',source:'accessibility',text:'x',truncated:false,
    controls:[{ref:'@8',role:'button',name:'中文',disabled:false}]};

  const rpc={getPageTarget:()=>7,call:vi.fn(async()=>({observation:page}))} as unknown as ToolRpc;

  const decide=vi.fn(async(input:BrowserDecisionInput)=>{
    expect(input.candidates.some(c=>c.operation==='click')).toBe(false);
    expect(input.candidates.some(c=>c.operation==='hover')).toBe(false);

    return {observationId:input.page.id,candidateId:'done',confidence:.99,model:'fixture'};
  });

  const result=await judgeRealtimeBrowserAction(
    rpc,
    {request:'点中文',userTask:'点中文',history:[],canExecute:name=>name!=='click'&&name!=='hover'},
    new AbortController().signal,
    decide,
  );

  expect(result.status).toBe('needs_verification');
  expect(result).not.toHaveProperty('suggestion');
});
