import {afterEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({send:vi.fn(),activate:vi.fn(async()=>{}),resolve:vi.fn(async()=>({id:12,windowId:1}))}));
vi.mock('../src/background/debugger.js',()=>({sendCommand:mocks.send,holdAttach:vi.fn(),releaseAttachHold:vi.fn()}));
vi.mock('../src/background/state.js',()=>({resolveWorkingTab:mocks.resolve,maybeActivateTab:mocks.activate}));
vi.mock('../src/background/exec/page-readiness.js',()=>({readCurrentDocument:vi.fn(async()=>({documentId:'doc',url:'https://example.com/'}))}));
import {screenshot} from '../src/background/exec/screenshot.js';
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
const refusal=()=>Object.assign(new Error('approval revoked'),{executionFact:'not_executed'});
const native=(executeScript:unknown)=>vi.stubGlobal('chrome',{scripting:{executeScript},tabs:{get:vi.fn(async()=>({id:12,url:'https://example.com/',title:'fixture'})),query:vi.fn(async()=>[{id:12}]),captureVisibleTab:vi.fn(async()=>{throw new Error('capture failed');})}});
describe('screenshot overlay curtain approval',()=>{
 it('Stop during viewport preparation prevents hide and capture',async()=>{
  let revoked=false;const curtains:boolean[]=[];
  native(vi.fn(async params=>{if(params.args){curtains.push(params.args[2]);return [];}revoked=true;return[{result:{w:3,h:3,dpr:1,x:0,y:0}}];}));
  const guard=Object.assign(async()=>{if(revoked)throw refusal();},{checkNow:()=>{if(revoked)throw refusal();}});
  await expect(screenshot({scale:'raw'},'main',guard)).rejects.toMatchObject({executionFact:'not_executed'});
  expect(curtains).not.toContain(true);expect(mocks.send).not.toHaveBeenCalled();
 });
 it('sync revocation immediately before hide is not swallowed by curtain',async()=>{
  const curtains:boolean[]=[];native(vi.fn(async params=>{if(params.args){curtains.push(params.args[2]);return [];}return[{result:{w:3,h:3,dpr:1,x:0,y:0}}];}));
  const guard=Object.assign(async()=>{},{checkNow:()=>{throw refusal();}});
  await expect(screenshot({scale:'raw'},'main',guard)).rejects.toThrow('approval revoked');
  expect(curtains).not.toContain(true);expect(mocks.send).not.toHaveBeenCalled();
 });
 it('already dispatched hide records effect and restores even after cancellation',async()=>{
  let revoked=false;const curtains:boolean[]=[];const noteEffect=vi.fn();
  native(vi.fn(async params=>{if(params.args){curtains.push(params.args[2]);if(params.args[2])revoked=true;return [];}return[{result:{w:3,h:3,dpr:1,x:0,y:0}}];}));
  mocks.send.mockRejectedValueOnce(refusal());
  const guard=Object.assign(async()=>{if(revoked)throw refusal();},{checkNow:()=>{if(revoked)throw refusal();},noteEffect});
  await expect(screenshot({scale:'raw'},'main',guard)).rejects.toMatchObject({executionFact:'unknown'});
  expect(curtains).toEqual([true,false]);expect(noteEffect).toHaveBeenCalled();
 });
});
