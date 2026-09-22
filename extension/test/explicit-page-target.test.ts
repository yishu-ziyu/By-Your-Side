import {beforeEach,expect,it,vi} from 'vitest';

beforeEach(()=>{
  vi.restoreAllMocks();vi.resetModules();
  vi.stubGlobal('chrome',{
    debugger:{onDetach:{addListener:vi.fn()}},
    tabs:{onRemoved:{addListener:vi.fn()},onUpdated:{addListener:vi.fn()}},
  });
});

it('所有缺省页面动作都把任务目标传给原有归属检查，不能退到活动页',async()=>{
  const state=await import('../src/background/state.js');
  const resolve=vi.spyOn(state,'resolveWorkingTab').mockRejectedValue(new Error('指定页已关闭'));
  const input=await import('../src/background/exec/input.js');
  const {navigate}=await import('../src/background/exec/navigate.js');
  const {evaluateJs}=await import('../src/background/exec/evaluate.js');
  const {screenshot}=await import('../src/background/exec/screenshot.js');

  const actions=[
    ()=>input.click({target:'#start',tabId:91},'main'),
    ()=>input.hover({target:'#start',tabId:91},'main'),
    ()=>input.fill({target:'#city',value:'苏州',tabId:91},'main'),
    ()=>input.typeText({text:'苏州',tabId:91},'main'),
    ()=>input.pressKey({key:'Enter',tabId:91},'main'),
    ()=>input.scroll({dy:10,tabId:91},'main'),
    ()=>input.mark({target:'#city',tabId:91},'main'),
    ()=>input.clearMarks('main',91),
    ()=>navigate({url:'https://example.invalid',tabId:91},'main'),
    ()=>evaluateJs({code:'1+1',tabId:91},'main'),
    ()=>screenshot({tabId:91},'main'),
  ];

  for(const action of actions){
    resolve.mockClear();
    await expect(action()).rejects.toThrow('指定页已关闭');
    expect(resolve).toHaveBeenCalledExactlyOnceWith(91,'main');
  }
});

it('fill checks the document captured before dispatch, even at the same URL',async()=>{
  let documentId='original-document';
  const executeScript=vi.fn(async(_details:Record<string,unknown>)=>[{documentId,result:{url:'https://same-url.test/',readyState:'complete'}}]);
  vi.stubGlobal('chrome',{...chrome,scripting:{executeScript}});
  const state=await import('../src/background/state.js');
  vi.spyOn(state,'resolveWorkingTab').mockResolvedValue({id:91,url:'https://same-url.test/'} as chrome.tabs.Tab);
  const activate=vi.spyOn(state,'maybeActivateTab');
  const {withObservedDocumentIdentity}=await import('../src/background/observation-document.js');
  const observed=await withObservedDocumentIdentity(91,'main',async()=>({target:'#code'}));
  documentId='replacement-document';
  const {fill}=await import('../src/background/exec/input.js');
  await expect(fill({tabId:91,target:observed.value.target,value:'星河',expectedDocumentId:observed.documentId!},'main')).rejects.toMatchObject({executionFact:'not_executed'});
  expect(activate).not.toHaveBeenCalled();
  expect(executeScript.mock.calls.every(([call])=>!('files' in (call??{})))).toBe(true);
});

// A host-bound AX fill must never become a DOM-ref fill with the same printed @number.
it.each(['dom-rebind','debugger-unavailable'] as const)('bound fill refuses %s before DOM fallback',async mode=>{
  const executeScript=vi.fn(async(_details:Record<string,unknown>)=>[{documentId:'original',result:{url:'https://same-url.test/',readyState:'complete'}}]);
  vi.stubGlobal('chrome',{...chrome,scripting:{executeScript}});
  const state=await import('../src/background/state.js');
  vi.spyOn(state,'resolveWorkingTab').mockResolvedValue({id:91,url:'https://same-url.test/'} as chrome.tabs.Tab);
  vi.spyOn(state,'maybeActivateTab').mockResolvedValue(undefined);
  const ax=await import('../src/background/axstate.js');
  ax.recordAxSnapshot(91,[4]);

  if(mode==='dom-rebind')ax.clearAxSnapshot(91);
  const debuggerApi=await import('../src/background/debugger.js');
  const send=vi.spyOn(debuggerApi,'sendCommand').mockRejectedValue(new Error('debugger detached'));
  const {fill}=await import('../src/background/exec/input.js');
  await expect(fill({tabId:91,target:'@4',value:'星河',expectedDocumentId:'original',expectedBackendNodeId:4},'main')).rejects.toThrow();
  expect(executeScript.mock.calls.every(([call])=>!('files' in call)&&!('documentIds' in (call.target as object)))).toBe(true);
  expect(send).toHaveBeenCalledTimes(mode==='dom-rebind'?0:1);
});
