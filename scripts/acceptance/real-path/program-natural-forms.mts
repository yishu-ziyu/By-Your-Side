import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-program-natural-forms`);
await mkdir(out, { recursive: true });
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Natural Forms</title><main style="height:9000px">page</main>'));
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${siteAddress(site).port}/`;
const goal = '检查脚本的自然写法';
const FINAL = '自然写法检查结束。';
const WRITES = 70;
type Payload = { tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown }> };
const payloads: Payload[] = [];
const text = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('') : '';
const program = (code: string) => ({ tool: { name: 'browser_run', args: { code, label: '检查写法' } } });
const model = await startScriptedModel([
  { match: '"lastReply"', steps: [{ text: JSON.stringify({ items: [{ text: goal, done: true }], status: 'done', remaining: '' }) }] },
  { match: goal, steps: [
    program(`const r = await browser.tabs({action: "list"}); return {listed: r.tabs.some(tab => tab.url === ${JSON.stringify(url)})};`),
    program(`const r = await browser.tabs({action: "active"}); return {active: r.tab.url === ${JSON.stringify(url)}};`),
    program(`console.log("reading", {a: 1}); console.error("oops"); return "after-console";`),
    ...Array.from({ length: WRITES }, (_, i) => ({ tool: { name: 'navigate', args: { url: `${url}?n=${i}` } } })),
    program(`await browser.navigate({url: ${JSON.stringify(url)}}); return "after-${WRITES}-writes";`),
    program(`return window.location.href;`),
    program(`return await browser.tabs({action: "nope"});`),
    program(`return await browser.fetch({url: "https://nonexistent.invalid/"});`),
    { text: FINAL },
  ] },
], undefined, payload => payloads.push(payload as Payload));
const rp = await launchRealPath();
let error: string | null = null;
let receipts: string[] = [];
try {
  const initial = await until(async () => (await rp.targets()).find(t => t.type === 'page' && t.url === 'about:blank'), 10_000, '工作页');
  await rp.cdp.send('Page.navigate', { url }, await rp.attach(initial.targetId));
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })})`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, '侧栏就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  try {
    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(FINAL)})`) || undefined, 240_000, '脚本跑完');
  } finally {
    const last = payloads.findLast(p => p.tools?.length && p.messages?.some(m => m.role === 'user' && text(m.content).includes(goal)));
    const messages = last?.messages ?? [];
    const at = messages.findLastIndex(m => m.role === 'user' && text(m.content).includes(goal));
    receipts = messages.slice(at + 1).filter(m => m.role === 'tool').map(m => text(m.content));
  }
  assert.equal(receipts.length, 7 + WRITES, 'every call reached the model');
  assert.match(receipts[0]!, /"listed":\s*true/, 'browser.tabs list returns real tabs');
  assert.match(receipts[1]!, /"active":\s*true/, 'browser.tabs active returns the real tab');
  assert.match(receipts[2]!, /after-console/, 'console does not stop the program');
  assert.match(receipts.at(-4)!, new RegExp(`after-${WRITES}-writes`), 'long tasks are not stopped by the result ledger');
  assert.doesNotMatch(receipts.slice(0, -3).join('\n'), /结果账本已满|is not a browser method|no page globals/, 'no shape refusal');
  assert.match(receipts.at(-3)!, /no page globals such as window/, 'page globals are still refused with guidance');
  assert.match(receipts.at(-2)!, /browser\.tabs takes action/, 'an unknown tabs action is still refused');
  assert.match(receipts.at(-1)!, /fetch 请求已发出，结果未知|fetch 请求失败|HTTP/, 'a real network failure is still reported');
} catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e); }
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', error, receipts: [...receipts.slice(0, 3), ...receipts.slice(-4)].map(r => r.slice(0, 400)) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve()));
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', out, error: error?.split('\n')[0] ?? null, count: receipts.length, last: receipts.slice(-3).map(r => r.slice(0, 120)) }));
if (error) process.exitCode = 1;
