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
  it('stops chasing a continuously changing page after three batches without progress', async () => {
    const call = vi.fn(async () => ({...receipt,blocks}));
    const translate = vi.fn(async () => [{id:'1:0',text:'阅读'},{id:'1:1',text:'原文'}]);
    const result = await runPageTranslation({action:'translate'},call,translate,new AbortController().signal);
    expect(result).toMatchObject({translated:0,remaining:1,incompleteReason:'page-changing',blocks:[]});
    expect(translate).toHaveBeenCalledTimes(3);
  });
  it('display and restore never invoke the model', async () => {
    const call=vi.fn().mockResolvedValue(receipt), translate=vi.fn();
    await runPageTranslation({action:'display',mode:'translated',fontFamily:'songti'},call,translate,new AbortController().signal);
    await runPageTranslation({action:'restore'},call,translate,new AbortController().signal);
    expect(translate).not.toHaveBeenCalled();
    expect(call.mock.calls[0]?.[0]).toMatchObject({fontFamily:'songti'});
  });
  it('cancellation during model generation prevents the late batch from writing', async () => {
    const abort=new AbortController();
    const call=vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,blocks});

    const translate=vi.fn().mockImplementation(async()=>{abort.abort();

return [{id:'1:0',text:'旧译文'}];});

    await expect(runPageTranslation({action:'translate'},call,translate,abort.signal)).rejects.toThrow();
    expect(call.mock.calls.map(([c])=>c.action)).toEqual(['begin','collect']);
  });
  it('a correction arriving during translation blocks the old batch at the real tool gate', async () => {
    let epoch=1;
    const rpc={call:vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,blocks}),ensureToolCall:vi.fn(),markCallRejected:vi.fn()};

    const tools=createBrowserTools(rpc as never,undefined,undefined,undefined,{epoch:()=>epoch,canWrite:()=>true},async()=>{epoch++;

return [{id:'1:0',text:'旧的'},{id:'1:1',text:'译文'}];});

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
  it('keeps an explicit pre-write page failure recoverable through the composed tool', async () => {
    let fail = true;

    const rpc = new ToolRpc(frame => queueMicrotask(() => {
      if (fail) rpc.handleResult(frame.id, false, undefined, '当前页面还没有译文，请先翻译页面。', 'not_executed');
      else rpc.handleResult(frame.id, true, receipt, undefined, 'executed');
    }));

    const tool = createBrowserTools(rpc,undefined,undefined,undefined,{epoch:()=>1,canWrite:()=>true}).find(t => t.name === 'page_translation')!;
    await expect(tool.execute('missing-translation', {action:'display',fontFamily:'songti'}, new AbortController().signal, undefined, {} as never)).rejects.toThrow('还没有译文');
    expect(rpc.getExecutionFact('missing-translation')).toBe('not_executed');
    fail = false;
    await expect(tool.execute('retry-translation', {action:'translate'}, new AbortController().signal, undefined, {} as never)).resolves.toBeDefined();
  });
  it('retains acknowledged writes when the live page later removes their paragraphs', async () => {
    const call = vi.fn().mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce({...receipt,blocks})
      .mockResolvedValueOnce({...receipt,applied:1,translated:0})
      .mockResolvedValueOnce({...receipt,blocks,translated:0});

    const translate = vi.fn().mockResolvedValueOnce([{id:'1:0',text:'阅读'},{id:'1:1',text:'原文'}]).mockRejectedValueOnce(Error('provider failed'));
    await expect(runPageTranslation({action:'translate'},call,translate,new AbortController().signal)).rejects.toMatchObject({executionFact:'executed'});
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
    expect(()=>validateTranslationCommand({action:'display',fontFamily:'invalid' as never})).toThrow();
    expect(()=>validateTranslationCommand({action:'apply',translations:[]})).toThrow();
    expect(()=>validateTranslationCommand({action:'display',mode:'translated',fontSize:20})).not.toThrow();
  });
});

describe('瞬时生成中断与用户主动停止（试用问题 3 反例）', () => {
  const marker = '这批翻译未完成（aborted），已保留之前的译文。可以继续翻译。';
  const segments = [{id:'1:0',text:'阅读 '},{id:'1:1',text:'来源'}];

  const collectThenFinish = () => vi.fn(async (command: Record<string, unknown>) => {
    if (command.action === 'begin') return receipt;

    if (command.action === 'collect') {
      return (collectThenFinish as {n?: number}).n
        ? {...receipt, blocks: [], translated: 1, remaining: 0}
        : ((collectThenFinish as {n?: number}).n = 1, {...receipt, blocks});
    }

    return {...receipt, blocks: [], translated: 1, remaining: 0};
  });

  it('同批瞬时生成中断只重试一次并可完成，不再整批报故障', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce({...receipt, blocks})
      .mockResolvedValueOnce({...receipt, translated: 1, remaining: 0, blocks: []})
      .mockResolvedValueOnce({...receipt, translated: 1, remaining: 0, blocks: []});

    const translate = vi.fn().mockRejectedValueOnce(new Error(marker)).mockResolvedValueOnce(segments);
    const result = await runPageTranslation({action:'translate'}, call as never, translate, new AbortController().signal);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({translated: 1, remaining: 0});
  });

  it('连续两次中断如实报整批故障（重试有界）', async () => {
    const call = vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt, blocks});
    const translate = vi.fn().mockRejectedValue(new Error(marker));
    await expect(runPageTranslation({action:'translate'}, call as never, translate, new AbortController().signal))
      .rejects.toThrow('翻译生成失败');
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('用户主动停止：如实报告已停止与进度，不算生成故障，也不再重试', async () => {
    const abort = new AbortController();
    const call = vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt, blocks});
    const translate = vi.fn().mockImplementation(async () => { abort.abort(); throw new Error(marker); });
    await expect(runPageTranslation({action:'translate'}, call as never, translate, abort.signal))
      .rejects.toThrow('已停止翻译请求');
    expect(translate).toHaveBeenCalledTimes(1);
  });
});

/** 最小页面替身：按 collect 协议返回未译且未被排除的段落，apply 记录写入顺序。 */
function fakePage(total: number, perBatch = 8) {
  const done = new Set<string>();
  const applied: string[][] = [];
  const ids = Array.from({length: total}, (_, i) => String(i + 1));
  const counts = () => ({translated: done.size, remaining: total - done.size});

  const call = vi.fn(async (command: {action: string; exclude?: string[]; translations?: {id: string}[]}): Promise<TranslationReceipt> => {
    if (command.action === 'apply') {
      const blockIds = [...new Set(command.translations!.map(t => t.id.split(':')[0]!))];
      blockIds.forEach(id => done.add(id)); applied.push(blockIds);

      return {...receipt, ...counts(), applied: blockIds.length, blocks: []};
    }

    const skip = new Set(command.exclude ?? []);
    const next = command.action === 'collect' ? ids.filter(id => !done.has(id) && !skip.has(id)).slice(0, perBatch) : [];

    return {...receipt, ...counts(), blocks: next.map(id => ({id, segments: [{id: `${id}:0`, text: `Paragraph ${id}`}]}))};
  });

  return {call, applied, done};
}

const echo = (blocks: {segments: {id: string}[]}[]) => blocks.flatMap(b => b.segments.map(s => ({id: s.id, text: '译文'})));

describe('并发请求池、按进度判断时限、length 拆批', () => {
  it('同时在途的批次不超过池宽，且同一段不会同时翻两份', async () => {
    const page = fakePage(40, 4);
    const inFlight = new Set<string>(); let peak = 0;

    const translate = vi.fn(async (blocks: {id: string; segments: {id: string}[]}[]) => {
      for (const b of blocks) { expect(inFlight.has(b.id)).toBe(false); inFlight.add(b.id); }
      peak = Math.max(peak, translate.mock.calls.length - page.applied.length);
      await new Promise(r => setTimeout(r, 5));
      for (const b of blocks) inFlight.delete(b.id);

      return echo(blocks);
    });

    const result = await runPageTranslation({action: 'translate'}, page.call as never, translate, new AbortController().signal, {concurrency: 3});
    expect(result).toMatchObject({translated: 40, remaining: 0});
    expect(peak).toBe(3);
    expect(translate).toHaveBeenCalledTimes(10);
  });

  it('先写完的批次立刻落页，不等最慢的一批', async () => {
    const page = fakePage(16, 8);
    let releaseSlow!: () => void;
    const slow = new Promise<void>(r => { releaseSlow = r; });

    const translate = vi.fn(async (blocks: {id: string; segments: {id: string}[]}[]) => {
      if (blocks[0]!.id === '1') await slow;

      return echo(blocks);
    });

    const running = runPageTranslation({action: 'translate'}, page.call as never, translate, new AbortController().signal, {concurrency: 2});
    await vi.waitFor(() => expect(page.applied).toEqual([['9', '10', '11', '12', '13', '14', '15', '16']]));
    releaseSlow();
    await expect(running).resolves.toMatchObject({translated: 16, remaining: 0});
  });

  it('length 时对半拆小重试，不原样重发；拆两层后仍失败就如实报错', async () => {
    const page = fakePage(8, 8);
    const sizes: number[] = [];

    const translate = vi.fn(async (blocks: {id: string; segments: {id: string}[]}[]) => {
      sizes.push(blocks.length);

      if (blocks.length > 2) throw Object.assign(new Error('这批翻译未完成（length），已保留之前的译文。可以继续翻译。'), {stopReason: 'length'});

      return echo(blocks);
    });

    await expect(runPageTranslation({action: 'translate'}, page.call as never, translate, new AbortController().signal)).resolves.toMatchObject({translated: 8, remaining: 0});
    expect(sizes).toEqual([8, 4, 2, 2, 4, 2, 2]);

    const always = vi.fn(async (blocks: unknown[]) => { sizes.push(blocks.length); throw Object.assign(new Error('这批翻译未完成（length）'), {stopReason: 'length'}); });
    sizes.length = 0;
    await expect(runPageTranslation({action: 'translate'}, fakePage(8, 8).call as never, always, new AbortController().signal)).rejects.toThrow('翻译生成失败');
    // 8 → 4 → 2；到 2 段只允许原样重试一次，随后停止启动新批次。
    expect(sizes.slice(0, 4)).toEqual([8, 4, 2, 2]);
    expect(always.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('持续有进展就不因总时长被截断；卡住不动时按空闲时限停止并报告进度', async () => {
    const page = fakePage(12, 1);
    const slowButSteady = vi.fn(async (blocks: {segments: {id: string}[]}[]) => { await new Promise(r => setTimeout(r, 30)); return echo(blocks); });
    // 12 批串行约 360 ms，远超 100 ms 的空闲时限，但每批都在时限内落页。
    await expect(runPageTranslation({action: 'translate'}, page.call as never, slowButSteady, new AbortController().signal, {concurrency: 1, idleMs: 100}))
      .resolves.toMatchObject({translated: 12, remaining: 0});

    const stuckPage = fakePage(12, 4);
    let first = true;

    const stuck = vi.fn(async (blocks: {segments: {id: string}[]}[], _l: string, signal: AbortSignal) => {
      if (first) { first = false; return echo(blocks); }

      return await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('这批翻译未完成（aborted）'), {stopReason: 'aborted'}))));
    });

    await expect(runPageTranslation({action: 'translate'}, stuckPage.call as never, stuck, new AbortController().signal, {concurrency: 1, idleMs: 60}))
      .rejects.toMatchObject({message: expect.stringContaining('长时间没有进展'), executionFact: 'executed'});
    expect(stuckPage.done.size).toBe(4);
  });

  it('每次请求带上批次序号、拆分层数和是否重试，供诊断记录使用', async () => {
    const page = fakePage(2, 2);
    const translate = vi.fn().mockRejectedValueOnce(Object.assign(new Error('这批翻译未完成（aborted）'), {stopReason: 'aborted'})).mockImplementation(async (blocks: {segments: {id: string}[]}[]) => echo(blocks));
    await runPageTranslation({action: 'translate'}, page.call as never, translate, new AbortController().signal);
    expect(translate.mock.calls.map(c => c[3])).toEqual([{batch: 1, depth: 0, retry: false}, {batch: 1, depth: 0, retry: true}]);
  });

  it('collect 的排除列表只允许用于 collect', () => {
    expect(() => validateTranslationCommand({action: 'collect', document: 'd', exclude: ['1', '2']})).not.toThrow();
    expect(() => validateTranslationCommand({action: 'apply', document: 'd', translations: [], exclude: ['1']})).toThrow();
    expect(() => validateTranslationCommand({action: 'collect', exclude: [1 as never]})).toThrow();
  });
});
