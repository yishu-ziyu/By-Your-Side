import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/background/state.js',()=>({resolveWorkingTab:vi.fn(async()=>({id:12}))}));
import {resolveWorkingTab} from '../src/background/state.js';
import {pageTranslation} from '../src/background/exec/page-translation.js';
afterEach(()=>vi.unstubAllGlobals());
describe('page translation injection receipts',()=>{
  it('rejects invalid typography before injection without an unknown write',async()=>{
    const executeScript=vi.fn();
    vi.stubGlobal('chrome',{scripting:{executeScript}});
    await expect(pageTranslation({action:'display',fontFamily:'invalid' as never},'main')).rejects.toMatchObject({executionFact:'not_executed'});
    expect(executeScript).not.toHaveBeenCalled();
  });
  it.each(['No tab with id: 12.', '没有可用的活动标签页'])('marks tab resolution failure as not executed: %s',async message=>{
    const executeScript=vi.fn();
    vi.stubGlobal('chrome',{scripting:{executeScript}});
    vi.mocked(resolveWorkingTab).mockRejectedValueOnce(new Error(message));
    await expect(pageTranslation({action:'begin',tabId:12},'main')).rejects.toMatchObject({message,executionFact:'not_executed'});
    expect(executeScript).not.toHaveBeenCalled();
  });
  it('does not call a rejected injection safe to retry',async()=>{
    vi.stubGlobal('chrome',{scripting:{executeScript:vi.fn().mockRejectedValue(new Error('Injection failed'))}});
    const error=await pageTranslation({action:'begin'},'main').catch(error=>error);
    expect(error.message).toBe('Injection failed');
    expect(error.executionFact).not.toBe('not_executed');
  });
  it.each(['not_executed','unknown'] as const)('preserves the page exception and %s fact',async executionFact=>{
    vi.stubGlobal('chrome',{scripting:{executeScript:vi.fn(async()=>[{result:{error:'原文已变化',executionFact}}])}});
    await expect(pageTranslation({action:'collect'},'main')).rejects.toMatchObject({message:'原文已变化',executionFact});
  });
  it('never labels missing injection receipt as safe to retry or unsupported',async()=>{
    vi.stubGlobal('chrome',{scripting:{executeScript:vi.fn(async()=>[{frameId:0}])}});
    await expect(pageTranslation({action:'begin'},'main')).rejects.toThrow('结果未知');
  });
  it('passes typography through and keeps tab identity',async()=>{
    const executeScript=vi.fn(async(_params:unknown)=>[{result:{document:'doc',blocks:[]}}]);
    vi.stubGlobal('chrome',{scripting:{executeScript}});
    expect(await pageTranslation({action:'display',fontFamily:'songti'},'main')).toMatchObject({tabId:12,document:'doc'});
    expect(executeScript.mock.calls[0]?.[0]).toMatchObject({args:[{action:'display',fontFamily:'songti'}]});
  });
});
