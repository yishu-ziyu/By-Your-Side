/** Extension runtime regression: successful browser reads must not need Node files. */
import {describe, expect, it, vi} from 'vitest';

vi.mock('../../agent/src/config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../agent/src/config.js')>(),
  dataDir: () => '',
}));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: (await import('../src/inproc/shims/node-fs.js')).mkdirSync,
  writeFileSync: (await import('../src/inproc/shims/node-fs.js')).writeFileSync,
}));

import {ToolRpc} from '../../agent/src/rpc.js';
import {TaskProgress} from '../../agent/src/task-progress.js';
import {createBrowserTools} from '../../agent/src/tools.js';
import {formatFetchReply, type FetchReply} from '../../agent/src/fetch-result.js';

const reply = (text: string): FetchReply => ({url:'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal',status:200,ok:true,contentType:'text/html',bytes:text.length,truncated:false,text});

describe('extension fetch without local storage', () => {
  it('returns a bounded, untrusted read receipt for a large successful response', () => {
    const out = formatFetchReply(reply('MDN AbortSignal '+ 'x'.repeat(30000)));
    expect(out).toContain('HTTP 200');
    expect(out).toContain('MDN AbortSignal');
    expect(out).toContain('<page-content untrusted');
    expect(out).toContain('not saved');
    expect(out).toContain('truncated');
    expect(out).not.toContain('Saved to');
    expect(out.length).toBeLessThan(17000);
  });

  it('completes the production fetch tool after receiving a large response', async () => {
    const rpc = new ToolRpc();
    const sent = vi.fn(frame => {queueMicrotask(() => rpc.handleResult(frame.id,true,reply('MDN '+ 'x'.repeat(6000)),undefined,'executed'));});
    rpc.setSend(sent);
    const progress = new TaskProgress('default');
    progress.request('读取 MDN，不执行示例');
    progress.observe({type:'agent_event',event:{kind:'agent_start'}});
    progress.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'read-mdn',name:'fetch',params:{url:reply('').url}}});
    const tool = createBrowserTools(rpc, undefined, undefined, undefined, {epoch:()=>1,canWrite:()=>true}).find(tool => tool.name === 'fetch')!;
    const result = await tool.execute('read-mdn', {url:reply('').url}, undefined, undefined, {} as any);
    progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'read-mdn',name:'fetch',isError:false,resultText:JSON.stringify(result.content),executionFact:rpc.getExecutionFact('read-mdn')}});
    expect(JSON.stringify(result.content)).toContain('MDN');
    expect(sent).toHaveBeenCalledOnce();
    expect(rpc.getExecutionFact('read-mdn')).toBe('executed');
    expect(progress.snapshot().results?.some(item=>item.status==='unknown')).toBe(false);
    expect(progress.snapshot().nextStep?.allowWrites).toBe(true);
  });

  it.each([{savePath:'doc.html'}, {pages:{from:1,to:2}}])('rejects file-only options before making a request: %j', async options => {
    const rpc = {call:vi.fn(async () => reply('MDN'))};
    const tool = createBrowserTools(rpc as any).find(tool => tool.name === 'fetch')!;
    await expect(tool.execute('unsupported', {url:reply('').url+'?page={page}',...options}, undefined, undefined, {} as any)).rejects.toThrow();
    expect(rpc.call).not.toHaveBeenCalled();
  });
});
