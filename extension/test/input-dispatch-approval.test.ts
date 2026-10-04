import {afterEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({send:vi.fn(),resolve:vi.fn(async()=>({id:12,windowId:1})),activate:vi.fn(async()=>{})}));

vi.mock('../src/background/debugger.js',()=>({sendCommand:mocks.send,holdAttach:vi.fn(),releaseAttachHold:vi.fn()}));

vi.mock('../src/background/state.js',()=>({resolveWorkingTab:mocks.resolve,maybeActivateTab:mocks.activate,getWorkingTabId:vi.fn()}));

vi.mock('../src/background/observation-document.js',()=>({assertObservedDocument:vi.fn(async()=> 'doc'),assertSameDocument:vi.fn()}));

vi.mock('../src/background/axstate.js',()=>({axBackendNodeFor:vi.fn(()=>17),isAxRef:vi.fn(()=>true)}));

vi.mock('../src/background/mark-motion.js',()=>({getMarkMotion:vi.fn(async()=> 'grow')}));

vi.mock('../src/background/page-events.js',()=>({watchDialog:vi.fn()}));

vi.mock('../src/background/exec/effect.js',()=>({beginEffect:vi.fn(),collectEffect:vi.fn()}));

import {hover,scroll,mark,clearMarks,callOnBackendNode,callDom} from '../src/background/exec/input.js';

afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});

const stop=Object.assign(async()=>{throw Object.assign(new Error('revoked'),{executionFact:'not_executed'});},{checkNow:()=>{throw new Error('revoked');}});

describe('remaining input dispatch approval',()=>{
 it.each(['hover','scroll','mark','clear'])('revoked %s causes no native write',async kind=>{
  const executeScript=vi.fn();vi.stubGlobal('chrome',{scripting:{executeScript}});
  mocks.send.mockResolvedValue({object:{objectId:'node'},result:{value:{x:1,y:1,width:2,height:2}}});
  const pending=kind==='hover'?hover({point:[1,2]},'main',stop):kind==='scroll'?scroll({dy:2},'main',stop):kind==='mark'?mark({target:'@17'},'main',stop):clearMarks('main',12,stop);
  await expect(pending).rejects.toThrow('revoked');
  expect(executeScript).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
 });
 it('callDom checks synchronously before scripting dispatch',async()=>{
  const executeScript=vi.fn();vi.stubGlobal('chrome',{scripting:{executeScript}});
  const guard=Object.assign(async()=>{},{checkNow:()=>{throw new Error('revoked');}});
  await expect(callDom(12,()=>true,[],undefined,guard)).rejects.toThrow('revoked');expect(executeScript).not.toHaveBeenCalled();
 });
 it('completed scroll preparation marks effects before later cancellation',async()=>{
  let revoked=false;const noted=vi.fn();
  const guard=Object.assign(async()=>{if(revoked)throw new Error('revoked');},{noteEffect:noted});
  mocks.send.mockImplementation(async(_tab,method,_args,dispatch)=>{await dispatch?.();

if(method==='Runtime.callFunctionOn')revoked=true;

return{object:{objectId:'node'},result:{value:true}};});
  await expect(callOnBackendNode(12,17,'function(){this.scrollIntoView()}',[],undefined,undefined,guard)).resolves.toBe(true);
  expect(noted).toHaveBeenCalledOnce();await expect(guard()).rejects.toThrow('revoked');
 });
 it('backend scroll preparation obeys the dispatch guard after node resolution',async()=>{
  const writes:string[]=[];mocks.send.mockImplementation(async(_tab,method,args,guard)=>{await guard?.();guard?.checkNow?.();writes.push(method);

return{object:{objectId:'node'},result:{value:true}};});
  await expect(callOnBackendNode(12,17,'function(){this.scrollIntoView()}',[],undefined,undefined,stop)).rejects.toThrow('revoked');
  expect(writes).not.toContain('Runtime.callFunctionOn');
 });
});
