import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/background/state.js',()=>({resolveReadableTab:async()=>({id:7,url:'https://fixture.test/form'})}));
vi.mock('../src/background/observation-document.js',()=>({withObservedDocumentIdentity:async(_tab:number,_session:string,run:()=>Promise<unknown>)=>({value:await run(),documentId:'fixture-document'})}));
vi.mock('../src/background/debugger.js',()=>({sendCommand:async()=>({nodes:[{}]})}));
vi.mock('../src/background/axtree.js',()=>({axTreeToText:()=>({text:'Current form',backendIds:[]})}));
vi.mock('../src/background/axstate.js',()=>({recordAxSnapshot:vi.fn(),clearAxSnapshot:vi.fn()}));
import {snapshot} from '../src/background/exec/snapshot.js';
afterEach(()=>vi.unstubAllGlobals());
it('binds a page snapshot to a freshly checked URL',async()=>{
  vi.stubGlobal('chrome',{tabs:{get:async()=>({id:7,url:'https://fixture.test/form'})}});
  expect(await snapshot({tabId:7})).toMatchObject({tabId:7,url:'https://fixture.test/form',text:'Current form'});
});
it('rejects an SPA URL change during the read even when the document did not change',async()=>{
  vi.stubGlobal('chrome',{tabs:{get:async()=>({id:7,url:'https://fixture.test/other'})}});
  await expect(snapshot({tabId:7})).rejects.toThrow('地址已变化');
});
