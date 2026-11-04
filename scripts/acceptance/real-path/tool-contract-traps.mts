import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-tool-contract-traps`);
await mkdir(out, { recursive: true });
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>工具合同练习</title><h1>隔离页面</h1>'));
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${siteAddress(site).port}/wanted`;
const other = `http://localhost:${siteAddress(site).port}/unrelated`;
const goal = '检查标签过滤和截图参数';
type Payload = { tools?: Array<{ function?: { name?: string; parameters?: { properties?: { clip?: { properties?: Record<string, unknown> } } } } }>; messages?: Array<{ role: string; content?: unknown }> };
const payloads: Payload[] = [];
const model = await startScriptedModel([
  { match: '"lastReply"', steps: [{ text: JSON.stringify({ items: [{ text: goal, done: true }], status: 'done', remaining: '' }) }] },
  { match: goal, steps: [
    { tool: { name: 'tabs', args: { action: 'list', url } } },
    { tool: { name: 'tabs', args: { action: 'active', url } } },
    { tool: { name: 'screenshot', args: { clip: { x: 0, y: 0, width: 100, height: 100, scale: 'raw' } } } },
    { tool: { name: 'screenshot', args: { clip: { x: 0, y: 0, width: 100, height: 100 }, scale: 'raw' } } },
    { tool: { name: 'screenshot', args: { clip: { x: 0, y: 0, width: 100, height: 100, scale: 'css' } } } },
    { tool: { name: 'screenshot', args: { clip: { x: 0, y: 0, width: 100, height: 100, scale: 'raw' }, scale: 'css' } } },
    { text: '参数检查结束。' },
  ] },
], undefined, payload => payloads.push(payload as Payload));
const rp = await launchRealPath();
let panel = '', error: string | null = null;
const evidence: Record<string, unknown> = {};
const text = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part && typeof part === 'object' && 'text' in part ? String(part.text) : '').join('') : '';
try {
  const initial = await until(async () => (await rp.targets()).find(t => t.type === 'page' && t.url === 'about:blank'), 10_000, '工作页');
  await rp.cdp.send('Page.navigate', { url }, await rp.attach(initial.targetId));
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(() => true)`);
  await rp.evaluate(panel, `chrome.tabs.create({url:${JSON.stringify(other)},active:false})`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, '侧栏就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("参数检查结束") && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, '脚本任务完成');
  await sleep(500);
  const last = payloads.findLast(p => p.tools?.length && p.messages?.some(m => m.role === 'user' && text(m.content).includes(goal)));
  const messages = last?.messages ?? [];
  const at = messages.findLastIndex(m => m.role === 'user' && text(m.content).includes(goal));
  const receipts = messages.slice(at + 1).filter(m => m.role === 'tool').map(m => text(m.content));
  const screenshot = last?.tools?.find(t => t.function?.name === 'screenshot')?.function?.parameters;
  evidence.receipts = receipts; evidence.screenshotParameters = screenshot;
  await rp.screenshot(panel, join(out, 'panel.png'));
  assert.equal(receipts.length, 6, 'six model-visible tool results');
  assert.ok(receipts[0]?.includes('/wanted') && !receipts[0]?.includes('/unrelated'), 'list+url filters the actual browser tabs');
  assert.ok(receipts[1]?.includes('不接受 url'), 'active still rejects url');
  assert.ok(!Object.hasOwn(screenshot?.properties?.clip?.properties ?? {}, 'scale'), 'model-visible clip has no scale');
  assert.ok(receipts[2]?.includes('Image pixels') && receipts[2].includes('actual scale=raw'), 'legacy nested raw scale produces a real screenshot');
  assert.ok(receipts[3]?.includes('Image pixels'), 'outer raw scale produces a real screenshot');
  assert.ok(receipts[4]?.includes('Image pixels') && receipts[4].includes('actual scale=css'), 'legacy nested css scale produces a real screenshot');
  assert.ok(receipts[5]?.includes('Image pixels') && receipts[5].includes('actual scale=css'), 'explicit outer scale takes precedence');
} catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e); }
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', error, evidence }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve()));
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', out, error, receipts: evidence.receipts }));
if (error) process.exitCode = 1;
