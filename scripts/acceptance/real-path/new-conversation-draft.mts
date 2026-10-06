/**
 * 记忆小考里发现的问题（docs/evals/20261006-memory-quiz.md）：点「新会话」后、会话建好前打的字，
 * 建好后仍在输入框里，不被清掉。只装扩展，本机脚本模型，无头。
 */
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();

const out = join(REPO, 'out/acceptance/new-conversation-draft');

await mkdir(out, { recursive: true });

const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>记忆验收</title><p>一页普通文字。</p>'));

await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));

const model = await startScriptedModel([]);

const rp = await launchRealPath();

const results: Array<[string, boolean, unknown]> = [];

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === 'about:blank')!.targetId);

  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());

  await rp.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, panel);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled === false') || undefined, 60_000, '侧栏就绪');

  // 配一个本机脚本模型，和用户在设置页里填自定义地址一样。
  await rp.click(panel, '#header-more');
  await rp.click(panel, '#model-settings-open');
  const settings = await rp.attach((await until(async () => (await rp.targets()).find((t) => t.url.endsWith('/settings.html')), 10_000, '设置页')).targetId);

  await until(async () => await rp.evaluate(settings, 'document.querySelectorAll(".provider-option").length>3') || undefined, 10_000, '服务商');
  await rp.evaluate(settings, 'document.querySelector("#provider-more").open=true');
  await rp.click(settings, '.provider-option[data-provider="custom"]');

  for (const [selector, value] of [['#base-url', model.baseUrl], ['#api-key', 'local-fixture'], ['#model-id', 'fixture']]) {
    await rp.evaluate(settings, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView();e.focus();e.select()})()`);
    await rp.typeText(settings, value);
  }

  await rp.evaluate(settings, 'document.querySelector("#model-save").scrollIntoView()');
  await rp.click(settings, '#model-save');
  await until(async () => String(await rp.evaluate(settings, 'document.querySelector("#model-status").textContent')).startsWith('已保存') || undefined, 10_000, '保存');
  await rp.cdp.send('Target.closeTarget', { targetId: (await rp.targets()).find((t) => t.url.endsWith('/settings.html'))!.targetId });
  // 没配模型时默认会话的创建被推迟，配好后才建出来：等它建好，再像用户一样点「新会话」开一段干净的。
  const settled = 'document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && document.querySelector("#send-btn")?.disabled === false';

  await sleep(3000);
  await until(async () => await rp.evaluate(panel, settled) || undefined, 60_000, '默认会话建好');
  await rp.click(panel, '#conversation-new');
  await until(async () => await rp.evaluate(panel, settled) || undefined, 30_000, '新会话建好');

  // 点「新会话」后马上打字。
  await rp.click(panel, '#conversation-new');
  const busy = await rp.evaluate(panel, 'document.querySelector("#conversation-new").getAttribute("aria-busy") === "true"');

  await rp.click(panel, '#input');
  await rp.typeText(panel, '新会话里的第一句');
  const busyAfterTyping = await rp.evaluate(panel, 'document.querySelector("#conversation-new").getAttribute("aria-busy") === "true"');

  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new").getAttribute("aria-busy") === "false"') || undefined, 30_000, '新会话建好');
  await sleep(800);
  const draft = await rp.evaluate(panel, '({ input: document.querySelector("#input").value, empty: !document.querySelector("#messages .msg.user") })');

  results.push(['会话建好前打的字留在新会话', busy && busyAfterTyping && draft.input === '新会话里的第一句' && draft.empty, { busy, busyAfterTyping, draft }]);
} finally {
  await rp.close();
  site.close();
  await model.close?.();
}

for (const [name, pass, actual] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(actual));

if (results.length < 1 || results.some(([, pass]) => !pass)) process.exitCode = 1;
