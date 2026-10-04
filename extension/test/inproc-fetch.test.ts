/** Extension runtime regression: successful browser reads must not need Node files. */
// Module mocks stand in for the extension build, which swaps node:fs for the shim and leaves dataDir empty;
// recorded in the anti-slop baseline on 2026-10-01 until fetch storage becomes injectable.
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

  it.each(['tiny', 'SyntheticSecretAbC1234567890'])('redacts URL credentials and body secrets before showing large inline evidence (%s)', token => {
    const response = reply('public data '.repeat(600) + '\nrecovery: BodySecretAbC1234567890');
    response.url = `https://reader:shortpass@fixture.test/data?access_token=${token}&api%5Fkey=k&q=AbortSignal&page=2`;
    const out = formatFetchReply(response);
    expect(out).toContain('https://[redacted]@fixture.test/data?access_token=[redacted]&api%5Fkey=[redacted]&q=AbortSignal&page=2');
    expect(out).not.toContain(token);
    expect(out).not.toContain('shortpass');
    expect(out).not.toContain('reader:');
    expect(out).not.toContain('BodySecretAbC1234567890');
    expect(out).toContain('recovery: [redacted]');
  });

  it('keeps ordinary source query parameters and a safe fragment useful', () => {
    const response = reply('public data '.repeat(600));
    response.url = 'https://fixture.test/docs?q=AbortSignal&page=2#examples';
    expect(formatFetchReply(response)).toContain('url="https://fixture.test/docs?q=AbortSignal&page=2#examples"');
  });

  it('shows only the media type, not arbitrary content-type parameters', () => {
    const response = reply('public data '.repeat(600));
    response.contentType = 'text/html; charset=utf-8; token=header-secret';
    const out = formatFetchReply(response);
    expect(out).toContain('HTTP 200 text/html;');
    expect(out).not.toContain('header-secret');
    expect(out).not.toContain('charset');
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
    // SAFETY: fetch 工具不读取执行上下文，空对象满足它实际用到的部分。
    const result = await tool.execute('read-mdn', {url:reply('').url}, undefined, undefined, {} as any);
    progress.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'read-mdn',name:'fetch',isError:false,resultText:JSON.stringify(result.content),executionFact:rpc.getExecutionFact('read-mdn')}});
    expect(JSON.stringify(result.content)).toContain('MDN');
    expect(sent).toHaveBeenCalledOnce();
    expect(rpc.getExecutionFact('read-mdn')).toBe('executed');
    expect(progress.snapshot().results?.some(item=>item.status==='unknown')).toBe(false);
    expect(progress.snapshot().nextStep?.allowWrites).toBe(true);
  });
});
