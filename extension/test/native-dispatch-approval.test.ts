import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/background/state.js',()=>({resolveWorkingTab:vi.fn(async()=>({id:12})),getWorkingTabId:vi.fn(async()=>12),setWorkingTab:vi.fn(),shouldActivateForKey:vi.fn(()=>false),getTabResource:vi.fn(),maybeActivateTab:vi.fn()}));
vi.mock('../src/background/debugger.js',()=>({ensureAttached:vi.fn(async()=>{}),sendCommand:vi.fn()}));
vi.mock('../src/background/exec/page-readiness.js',()=>({readCurrentDocument:vi.fn(async()=>({documentId:'old'})),waitForInteractive:vi.fn(async()=>({readiness:'interactive'}))}));
vi.mock('../src/background/page-events.js',()=>({cancelDownloadRecord:vi.fn(),deleteDownloadRecord:vi.fn(),getDownloadRecord:vi.fn()}));
import {navigate} from '../src/background/exec/navigate.js';
import {closeTab,openTab} from '../src/background/exec/tabs.js';
import {downloadUrl,downloadCancel} from '../src/background/exec/download.js';
import {pageTranslation} from '../src/background/exec/page-translation.js';
import {fetchUrl} from '../src/background/exec/fetch-url.js';
import {ensureAttached} from '../src/background/debugger.js';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
const refused=()=>Object.assign(new Error('approval revoked'),{executionFact:'not_executed'});
const stopped=Object.assign(async()=>{throw refused();},{checkNow:()=>{throw refused();}});
describe('approval at native dispatch boundary',()=>{
  it('revocation during navigation attach does not navigate',async()=>{
    const update=vi.fn();vi.stubGlobal('chrome',{tabs:{update}});
    let active=true;vi.mocked(ensureAttached).mockImplementationOnce(async()=>{active=false;});
    const guard=Object.assign(async()=>{if(!active)throw refused();},{checkNow:()=>{if(!active)throw refused();}});
    await expect(navigate({url:'https://example.com'},'main',guard)).rejects.toMatchObject({executionFact:'not_executed'});
    expect(update).not.toHaveBeenCalled();
  });
  it.each(['close','open','download','translation','fetch'])('revoked approval prevents %s native call',async kind=>{
    const remove=vi.fn(),create=vi.fn(),download=vi.fn(),executeScript=vi.fn(),fetch=vi.fn();
    vi.stubGlobal('chrome',{tabs:{remove,create},downloads:{download},scripting:{executeScript}});vi.stubGlobal('fetch',fetch);
    const pending=kind==='close'?closeTab({},'main',stopped):kind==='open'?openTab({},'main',stopped):kind==='download'?downloadUrl({url:'https://example.com/x'},'main',stopped):kind==='translation'?pageTranslation({action:'begin'},'main',stopped):fetchUrl({url:'https://example.com/x'},{beforeDispatch:stopped});
    await expect(pending).rejects.toMatchObject({executionFact:'not_executed'});
    for(const native of [remove,create,download,executeScript,fetch])expect(native).not.toHaveBeenCalled();
  });
  it('checks synchronously after an async approval check',async()=>{
    const remove=vi.fn();vi.stubGlobal('chrome',{tabs:{remove}});
    const guard=Object.assign(async()=>{},{checkNow:()=>{throw refused();}});
    await expect(closeTab({},'main',guard)).rejects.toThrow('approval revoked');expect(remove).not.toHaveBeenCalled();
  });
  it('revocation during download lookup does not cancel',async()=>{
    let revoked=false;let cancelling=false;const cancel=vi.fn();
    vi.stubGlobal('crypto',{randomUUID:()=> 'test'});
    vi.stubGlobal('chrome',{downloads:{download:vi.fn(async()=>1),search:vi.fn(async()=>{if(cancelling)revoked=true;return[{filename:'x',state:'in_progress',danger:'uncommon'}];}),cancel}});
    await downloadUrl({url:'https://example.com/x',timeoutMs:1000},'main');
    cancelling=true;
    const guard=Object.assign(async()=>{if(revoked)throw refused();},{checkNow:()=>{if(revoked)throw refused();}});
    await expect(downloadCancel({downloadId:'url-download-test'},'main',guard)).rejects.toThrow('approval revoked');expect(cancel).not.toHaveBeenCalled();
  });
  it('a request already sent before a redirected dispatch is revoked has unknown effect',async()=>{
    const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://example.com/next'}}));vi.stubGlobal('fetch',fetch);
    let checks=0;const guard=Object.assign(async()=>{if(++checks>1)throw refused();},{checkNow:()=>{}});
    await expect(fetchUrl({url:'https://example.com/x'},{beforeDispatch:guard})).rejects.toMatchObject({executionFact:'unknown'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
