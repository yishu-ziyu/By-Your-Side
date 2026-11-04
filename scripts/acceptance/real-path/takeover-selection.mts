import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-takeover-selection`);
await mkdir(out, { recursive: true });
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>申请账号</title><button id="github" onclick="document.querySelector(\'#result\').textContent=\'clicked\'">Continue with GitHub</button><p id="result"></p>'));
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const goal = '帮我操作这个页面';
const model = await startScriptedModel([{ match: goal, steps: [{ tool: { name: 'click', args: { target: '#github' } }, delayMs: 8000 }, { text: '已选择。' }] }]);
const rp = await launchRealPath();
let panel = '';
const result: Record<string, unknown> = {};
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: origin }, work);
  panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(() => rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled === false`), 60_000, '侧栏就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, `!document.querySelector('#takeover-btn')?.hidden && document.querySelector('#takeover-btn')?.textContent === '接管'`), 30_000, '助手开始运行');
  await rp.click(panel, '#takeover-btn');
  await until(() => rp.evaluate(panel, `document.querySelector('#takeover-btn')?.textContent === '交还'`), 15_000, '用户主动接管');
  await rp.click(panel, '#input'); await rp.typeText(panel, '默认用 Google'); await rp.pressEnter(panel);
  await sleep(9000);
  result.control = await rp.evaluate(panel, `document.querySelector('#takeover-btn')?.textContent`);
  result.page = await rp.evaluate(work, `document.querySelector('#result').textContent`);
  assert.equal(result.control, '交还', '主动接管时补充文字不自动交还');
  assert.equal(result.page, '', '主动接管后待发点击没有执行');
  console.log('PASS 用户主动接管', JSON.stringify(result));
} catch (error) {
  if (panel) {
    result.panelState = await rp.evaluate(panel, `({text:document.body.innerText.slice(-1600), send:document.querySelector('#send-btn')?.className})`).catch(() => null);
    await rp.screenshot(panel, join(out, 'failure-panel.png')).catch(() => {});
  }
  console.error('FAIL 用户主动接管', JSON.stringify(result), String(error));
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}
