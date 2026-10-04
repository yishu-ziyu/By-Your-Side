import {afterEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({sendCommand:vi.fn()}));
vi.mock('../src/background/isolated-read-context.js',()=>({isolatedReadContext:async()=>71}));
vi.mock('../src/background/debugger.js',()=>({sendCommand:mocks.sendCommand}));
vi.mock('../src/background/observation-document.js',()=>({assertObservedDocument:vi.fn(),withObservedDocumentIdentity:vi.fn()}));
vi.mock('../src/background/axstate.js',()=>({isAxRef:vi.fn()}));
vi.mock('../src/background/state.js',()=>({resolveWorkingTab:vi.fn()}));
vi.mock('../src/background/exec/effect.js',()=>({beginEffect:vi.fn(),collectEffect:vi.fn()}));
vi.mock('../src/background/exec/input.js',()=>({notExecuted:(error:Error)=>Object.assign(error,{executionFact:'not_executed'})}));
import {setFilesOnObjectId,setFilesOnBackendNodeId} from '../src/background/exec/upload.js';
afterEach(()=>vi.clearAllMocks());
describe('file upload dispatch guard',()=>{
  it.each([false,true])('cancellation after setup blocks files/events and cleans listeners (clear=%s)',async clear=>{
    let revoked=false;const writes:string[]=[];
    const guard=Object.assign(async()=>{if(revoked)throw Object.assign(new Error('revoked'),{executionFact:'not_executed'});},{checkNow:()=>{}});
    mocks.sendCommand.mockImplementation(async(_tab:number,method:string,args:Record<string,unknown>,dispatch?:typeof guard)=>{
      await dispatch?.();dispatch?.checkNow?.();
      if(method==='Runtime.callFunctionOn'){
        const source=String(args.functionDeclaration);writes.push(source);
        if(source.includes('addEventListener'))revoked=true;
        return {result:{value:true}};
      }
      writes.push(method);return {};
    });
    await expect(setFilesOnObjectId(12,'node',clear?[]:['/tmp/allowed.txt'],guard)).rejects.toMatchObject({executionFact:'unknown'});
    expect(writes.some(write=>write==='DOM.setFileInputFiles'||write.includes('el.files =')||write.includes('dispatchEvent'))).toBe(false);
    expect(writes.some(write=>write.includes('removeEventListener')&&!write.includes('dispatchEvent'))).toBe(true);
  });
  it('releases the resolved chooser object even when the dispatch is revoked',async()=>{
    const methods:string[]=[];
    const guard=Object.assign(async()=>{throw Object.assign(new Error('revoked'),{executionFact:'not_executed'});},{checkNow:()=>{}});
    mocks.sendCommand.mockImplementation(async(_tab:number,method:string,args:unknown,dispatch?:typeof guard)=>{
      methods.push(method);await dispatch?.();return {object:{objectId:'node'}};
    });
    await expect(setFilesOnBackendNodeId(12,1,['/tmp/allowed.txt'],guard)).rejects.toThrow('revoked');
    expect(methods).toContain('Runtime.releaseObject');
  });
});
