import {BrowserAgentSession} from "../src/session.js";
import {ToolRpc} from "../src/rpc.js";
import {createBrowserTools} from "../src/tools.js";
import {describe, expect, it, vi} from 'vitest';
import {parseTranslations, runPageTranslation, translationModelBlocks, restoreTranslationWhitespace} from '../src/page-translation.js';
import {validateTranslationCommand, type TranslationReceipt} from '../../shared/page-translation.js';
const blocks = [{id: '1', segments: [{id: '1:0', text: 'Read '}, {id: '1:1', text: 'the source'}]}];
const receipt: TranslationReceipt = {tabId: 12, document: 'doc-1', language: '简体中文', mode: 'bilingual', fontSize: null, translated: 0, remaining: 1, unsupported: 0, blocks: []};
describe('document-bound page translation', () => {
  it('rejects missing, duplicate, empty or HTML-shaped model records', () => {
    for (const value of [[], [{id:'1:0',text:'阅读'}], [{id:'1:0',text:'阅读'},{id:'1:0',text:'来源'}], [{id:'1:0',text:''},{id:'1:1',text:'来源'}], '<p>译文</p>']) {
      expect(() => parseTranslations(typeof value === 'string' ? value : JSON.stringify(value), blocks)).toThrow();
    }
    expect(parseTranslations('```json\n[{"id":"1:0","text":"阅读 "},{"id":"1:1","text":"来源"}]\n```', blocks)).toEqual([{id:'1:0',text:'阅读 '},{id:'1:1',text:'来源'}]);
  });
  it('maps translated segments by identity even if the JSON array is reordered', () => {
    expect(parseTranslations('[{"id":"1:1","text":"来源"},{"id":"1:0","text":"阅读"}]',blocks)).toEqual([{id:'1:0',text:'阅读'},{id:'1:1',text:'来源'}]);
  });
  it('preserves whitespace-only inline separators as text', () => {
    const spaced=[{id:'2',segments:[{id:'2:0',text:' '}]}];
    expect(parseTranslations('[{"id":"2:0","text":" "}]',spaced)).toEqual([{id:'2:0',text:' '}]);
  });
  it('keeps layout whitespace local and restores it around translated content', () => {
    const input=[{id:'1',segments:[{id:'1:0',text:'\n  '},{id:'1:1',text:' Read '},{id:'1:2',text:'\t'},{id:'1:3',text:'.'}]}];
    expect(translationModelBlocks(input)).toEqual([{id:'1',segments:[{id:'1:1',text:'Read'}]}]);
    expect(restoreTranslationWhitespace([{id:'1:1',text:'阅读'}],input)).toEqual([{id:'1:0',text:'\n  '},{id:'1:1',text:' 阅读 '},{id:'1:2',text:'\t'},{id:'1:3',text:'.'}]);
  });
  it('does not request optional reasoning for paragraph translation', async () => {
    const completeSimple=vi.fn().mockResolvedValue({stopReason:'stop',content:[{type:'text',text:'[{"id":"1:0","text":"阅读"},{"id":"1:1","text":"来源"}]'}]});
    const host={session:{model:{provider:'fixture',id:'model'},sessionId:'s'},modelRuntime:{completeSimple}};
    const result=await BrowserAgentSession.prototype.translatePageBatch.call(host as never,blocks,'简体中文',new AbortController().signal);
    expect(result[0]?.text).toBe('阅读 ');
    expect(completeSimple.mock.calls[0]?.[2].reasoning).toBeUndefined();
  });
  it('regenerates malformed model output once before any page write', async () => {
    const completeSimple=vi.fn()
      .mockResolvedValueOnce({stopReason:'stop',content:[{type:'text',text:'[] extra text'}]})
      .mockResolvedValueOnce({stopReason:'stop',content:[{type:'text',text:'[{"id":"1:0","text":"阅读"},{"id":"1:1","text":"来源"}]'}]});
    const host={session:{model:{provider:'fixture',id:'model'},sessionId:'s'},modelRuntime:{completeSimple}};
    const result=await BrowserAgentSession.prototype.translatePageBatch.call(host as never,blocks,'简体中文',new AbortController().signal);
    expect(result).toHaveLength(2);expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(completeSimple.mock.calls[1]?.[1].systemPrompt).toContain('previous answer was malformed');
  });
  it('keeps the regeneration bounded when both model outputs are invalid', async () => {
    const completeSimple=vi.fn().mockResolvedValue({stopReason:'stop',content:[{type:'text',text:'[] extra text'}]});
    const host={session:{model:{provider:'fixture',id:'model'},sessionId:'s'},modelRuntime:{completeSimple}};
    await expect(BrowserAgentSession.prototype.translatePageBatch.call(host as never,blocks,'简体中文',new AbortController().signal)).rejects.toThrow('本批未写入');
    expect(completeSimple).toHaveBeenCalledTimes(2);
  });
  it('pins all subsequent batches to the original document and tab', async () => {
    const call = vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,blocks}).mockResolvedValueOnce({...receipt,translated:1,remaining:0}).mockResolvedValueOnce({...receipt,translated:1,remaining:0});
    const translate = vi.fn().mockResolvedValue([{id:'1:0',text:'阅读 '},{id:'1:1',text:'来源'}]);
    await runPageTranslation({action:'translate',mode:'translated'},call,translate,new AbortController().signal);
    expect(call.mock.calls[0]![0]).toEqual({action:'begin',mode:'translated'});
    for (const [command] of call.mock.calls.slice(1)) expect(command).toMatchObject({tabId:12,document:'doc-1'});
    expect(translate).toHaveBeenCalledTimes(1);
  });
  it('display and restore never invoke the model', async () => {
    const call=vi.fn().mockResolvedValue(receipt), translate=vi.fn();
    await runPageTranslation({action:'display',mode:'translated'},call,translate,new AbortController().signal);
    await runPageTranslation({action:'restore'},call,translate,new AbortController().signal);
    expect(translate).not.toHaveBeenCalled();
  });
  it('cancellation during model generation prevents the late batch from writing', async () => {
    const abort=new AbortController();
    const call=vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,blocks});
    const translate=vi.fn().mockImplementation(async()=>{abort.abort();return [{id:'1:0',text:'旧译文'}];});
    await expect(runPageTranslation({action:'translate'},call,translate,abort.signal)).rejects.toThrow();
    expect(call.mock.calls.map(([c])=>c.action)).toEqual(['begin','collect']);
  });
  it('a correction arriving during translation blocks the old batch at the real tool gate', async () => {
    let epoch=1;
    const rpc={call:vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,blocks}),ensureToolCall:vi.fn(),markCallRejected:vi.fn()};
    const tools=createBrowserTools(rpc as never,undefined,undefined,undefined,{epoch:()=>epoch,canWrite:()=>true},async()=>{epoch++;return [{id:'1:0',text:'旧的'},{id:'1:1',text:'译文'}];});
    const tool=tools.find(t=>t.name==='page_translation')!;
    await expect(tool.execute('translation-1',{action:'translate'},new AbortController().signal,undefined,{} as never)).rejects.toThrow('旧步骤未执行');
    expect(rpc.call).toHaveBeenCalledTimes(2);
  });
  it.each([0, 2])('records known generation failure after %s acknowledged paragraphs', async (translated) => {
    const rpc = new ToolRpc(frame => queueMicrotask(() => rpc.handleResult(frame.id, true, {...receipt, translated, blocks:frame.params.action==='collect'?blocks:[]}, undefined, 'executed')));
    const tools=createBrowserTools(rpc,undefined,undefined,undefined,{epoch:()=>1,canWrite:()=>true},async()=>{throw Error('provider output limit');});
    const tool=tools.find(t=>t.name==='page_translation')!;
    await expect(tool.execute('known-failure',{action:'translate'},new AbortController().signal,undefined,{} as never)).rejects.toThrow('provider output limit');
    expect(rpc.getExecutionFact('known-failure')).toBe(translated?'executed':'not_executed');
  });
  it('does not reclassify a missing apply receipt as a safe model failure', async () => {
    const call=vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,blocks}).mockRejectedValueOnce(Object.assign(new Error('RPC timeout'),{executionFact:'unknown'}));
    await expect(runPageTranslation({action:'translate'},call,async()=>[{id:'1:0',text:'阅读'},{id:'1:1',text:'来源'}],new AbortController().signal)).rejects.toMatchObject({executionFact:'unknown'});
  });
  it('model failure leaves already applied batches intact, without restoring or retrying', async () => {
    const call=vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,blocks}).mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,blocks});
    const translate=vi.fn().mockResolvedValueOnce([{id:'1:0',text:'阅读 '},{id:'1:1',text:'来源'}]).mockRejectedValueOnce(new Error('provider failed'));
    await expect(runPageTranslation({action:'translate'},call,translate,new AbortController().signal)).rejects.toThrow('provider failed');
    expect(call.mock.calls.map(([c])=>c.action)).toEqual(['begin','collect','apply','collect']);
  });
  it('validates mode, size and apply identity at the extension boundary', () => {
    expect(()=>validateTranslationCommand({action:'display',fontSize:0})).toThrow();
    expect(()=>validateTranslationCommand({action:'apply',translations:[]})).toThrow();
    expect(()=>validateTranslationCommand({action:'display',mode:'translated',fontSize:20})).not.toThrow();
  });
});
