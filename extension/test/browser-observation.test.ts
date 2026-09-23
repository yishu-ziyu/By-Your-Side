import {afterEach,describe,expect,it,vi} from 'vitest';

vi.mock('../src/background/debugger.js',()=>({sendCommand:vi.fn()}));

vi.mock('../src/background/exec/page-readiness.js',()=>({readCurrentDocument:vi.fn()}));

import {BrowserObservationRegistry,decisionControls,browserObservations,assertBrowserDecision} from '../src/background/browser-observation.js';
import {sendCommand} from '../src/background/debugger.js';
import {readCurrentDocument} from '../src/background/exec/page-readiness.js';

const page=()=>({tabId:7,documentId:'d1',url:'https://test.invalid',source:'accessibility' as const,text:'page',truncated:false,controls:[{ref:'@4',role:'textbox',name:'Field',value:'original',disabled:false}]});

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('immutable browser observation guards',()=>{
 it('binds a browser-tab candidate to the source observation, member and observed target',()=>{
  const r=new BrowserObservationRegistry(),p=r.issue('m',{...page(),tabs:[{id:9,title:'资料页',url:'https://reference.test/',active:false,windowId:1,working:false}]});
  const params={tabId:9,decisionGuard:{observationId:p.id,operation:'switch_tab',sourceTabId:7}};
  expect(()=>r.consume('other',9,'switch_tab',params)).toThrow('DECISION_STALE');
  expect(r.consume('m',9,'switch_tab',params).tabs?.[0]?.id).toBe(9);
  expect(()=>r.consume('m',9,'switch_tab',params)).toThrow('DECISION_STALE');
  const next=r.issue('m',{...page(),tabs:[]});
  expect(()=>r.consume('m',9,'switch_tab',{...params,decisionGuard:{...params.decisionGuard,observationId:next.id}})).toThrow('DECISION_INVALID');
 });
 it.each(['url','title'])('refuses a browser tab whose observed %s changed before execution',async(field)=>{
  const target={id:9,title:'资料页',url:'https://reference.test/',active:false,windowId:1,working:false};
  const p=browserObservations.issue('m',{...page(),tabs:[target]});
  vi.mocked(readCurrentDocument).mockResolvedValue({documentId:'d1'} as any);
  vi.stubGlobal('chrome',{tabs:{get:async(id:number)=>id===7?{url:p.url}:{...target,[field]:'changed'}}});
  await expect(assertBrowserDecision('m','switch_tab',{tabId:9,decisionGuard:{observationId:p.id,operation:'switch_tab',sourceTabId:7}})).rejects.toThrow('DECISION_STALE');
 });
 it('preserves full names/states, excludes ignored nodes and unsupported roles',()=>{
  expect(decisionControls([{nodeId:'1',backendDOMNodeId:4,role:{value:'textbox'},name:{value:'Complete field name'},value:{value:'x'},properties:[{name:'focused',value:{value:true}}]}, {nodeId:'2',backendDOMNodeId:5,ignored:true,role:{value:'button'}},{nodeId:'3',backendDOMNodeId:6,role:{value:'StaticText'},name:{value:'Save'}}])).toEqual([{ref:'@4',role:'textbox',name:'Complete field name',value:'x',disabled:false,focused:true}]);
 });
 it('preserves semantic group ownership, readonly state and observed option labels',()=>{
  const controls=decisionControls([
   {nodeId:'form',backendDOMNodeId:10,role:{value:'form'},name:{value:'Settings'}},
   {nodeId:'select',parentId:'form',backendDOMNodeId:1,role:{value:'combobox'},name:{value:'Tier'},value:{value:'Copper'}},
   {nodeId:'option',parentId:'select',backendDOMNodeId:2,role:{value:'option'},name:{value:'Gold'}},
   {nodeId:'field',parentId:'form',backendDOMNodeId:3,role:{value:'textbox'},name:{value:'Read only'},properties:[{name:'readonly',value:{value:true}}]},
  ]);

  expect(controls.find(c=>c.ref==='@1')).toMatchObject({scopeId:'page:10',scopeLabel:'form Settings',options:[{ref:'@2',label:'Gold',disabled:false}]});
  expect(controls.find(c=>c.ref==='@3')?.readOnly).toBe(true);
 });
 it('binds a decision to member, tab, original observed target, operation and one execution',()=>{
  const r=new BrowserObservationRegistry(),p=r.issue('member',page());
  const params={target:'@4',value:'new',decisionGuard:{observationId:p.id,operation:'fill',target:'@4'}};
  expect(()=>r.consume('other',7,'fill',params)).toThrow('DECISION_STALE');
  expect(()=>r.consume('member',8,'fill',params)).toThrow('DECISION_STALE');
  expect(r.consume('member',7,'fill',params).controls[0]!.value).toBe('original');
  expect(()=>r.consume('member',7,'fill',params)).toThrow('DECISION_STALE');
 });
 it('new observations invalidate the old menu and returned objects cannot change stored candidates',()=>{
  const r=new BrowserObservationRegistry(),p=r.issue('m',page());p.controls[0]!.name='tampered';
  const original=r.consume('m',7,'fill',{target:'@4',value:'x',decisionGuard:{observationId:p.id,operation:'fill',target:'@4'}});
  expect(original.controls[0]!.name).toBe('Field');
  const old=r.issue('m',page());r.issue('m',page());expect(()=>r.consume('m',7,'scroll',{dy:600,decisionGuard:{observationId:old.id,operation:'scroll'}})).toThrow('DECISION_STALE');
 });
 it.each(['different-target','coordinate','unfocused-key','expiry'])('rejects %s without execution',mode=>{
  const r=new BrowserObservationRegistry(),p=r.issue('m',page());

  if(mode==='expiry')vi.spyOn(Date,'now').mockReturnValue(p.observedAt+15001);
  const operation=mode==='unfocused-key'?'press_key':'fill';
  expect(()=>r.consume('m',7,operation,{target:mode==='different-target'?'@99':'@4',value:'new',...(mode==='coordinate'?{point:[1,2]}:{}),key:'Enter',decisionGuard:{observationId:p.id,operation,target:'@4'}})).toThrow();
 });
 it.each(['document','url','field','focus'])('rechecks %s at the extension execution boundary',async(mode)=>{
  const p=browserObservations.issue('m',page());
  vi.mocked(readCurrentDocument).mockResolvedValue({documentId:mode==='document'?'d2':'d1'} as any);
  vi.stubGlobal('chrome',{tabs:{get:async()=>({url:mode==='url'?'https://other.invalid':p.url})}});
  vi.mocked(sendCommand).mockImplementation(async(_tab,method)=>({...(method==='DOM.getDocument'?{root:{nodeId:1}}:method==='DOM.querySelectorAll'?{nodeIds:[]}:{nodes:[{nodeId:'n',backendDOMNodeId:4,role:{value:'textbox'},name:{value:'Field'},value:{value:mode==='field'?'user edit':'original'},properties:mode==='focus'?[{name:'focused',value:{value:true}}]:[]}]})}) as any);
  await expect(assertBrowserDecision('m','fill',{tabId:7,target:'@4',value:'new',decisionGuard:{observationId:p.id,operation:'fill',target:'@4'}})).rejects.toThrow('DECISION_STALE');
 });
 it('ignores changing static text but keeps semantic control checks',async()=>{
  const p=browserObservations.issue('m',page());
  vi.mocked(readCurrentDocument).mockResolvedValue({documentId:'d1'} as any);vi.stubGlobal('chrome',{tabs:{get:async()=>({url:p.url})}});
  vi.mocked(sendCommand).mockImplementation(async(_tab,method)=>({...(method==='DOM.getDocument'?{root:{nodeId:1}}:method==='DOM.querySelectorAll'?{nodeIds:[]}:{nodes:[{nodeId:'n',backendDOMNodeId:4,role:{value:'textbox'},name:{value:'Field'},value:{value:'original'}},{nodeId:'clock',role:{value:'StaticText'},name:{value:String(Date.now())}}]})}) as any);
  await expect(assertBrowserDecision('m','fill',{tabId:7,target:'@4',value:'new',decisionGuard:{observationId:p.id,operation:'fill',target:'@4'}})).resolves.toBeUndefined();
 });
 it('allows guarded hover on an observed clickable control and keeps one-shot identity limits',()=>{
  const r=new BrowserObservationRegistry();
  const p=r.issue('m',{...page(),controls:[{ref:'@9',role:'button',name:'Account',disabled:false}]});
  const params={tabId:7,target:'@9',decisionGuard:{observationId:p.id,operation:'hover',target:'@9'}};
  expect(()=>r.consume('other',7,'hover',params)).toThrow('DECISION_STALE');
  expect(r.consume('m',7,'hover',params).controls.some(c=>c.ref==='@9')).toBe(true);
  expect(()=>r.consume('m',7,'hover',params)).toThrow('DECISION_STALE');
 });
 it('rejects guarded hover on unsupported roles without execution',()=>{
  const r=new BrowserObservationRegistry(),p=r.issue('m',page());
  expect(()=>r.consume('m',7,'hover',{tabId:7,target:'@4',decisionGuard:{observationId:p.id,operation:'hover',target:'@4'}})).toThrow('DECISION_INVALID');
 });
});
