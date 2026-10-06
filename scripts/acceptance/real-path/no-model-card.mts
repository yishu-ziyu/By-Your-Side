/** #71 R5：没连模型就发消息，回复是带「连一个模型」按钮的卡片，点了打开设置页。只装扩展，无头。 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, until, sleep } from './harness.mts';

requireHeadless();

const out = join(REPO, 'out/acceptance/no-model-card');

await mkdir(out, { recursive: true });

const rp = await launchRealPath();

const results: Array<[string, boolean]> = [];

try {
  const panel = await rp.attach(await rp.openSidePanel());

  await rp.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, panel);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled === false && document.querySelector("#conversation-new")?.getAttribute("aria-label") === "新会话"') || undefined, 60_000, '默认会话建好');
  await rp.click(panel, '#input');
  await rp.typeText(panel, '这篇文章的核心观点是什么？');
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, '!!document.querySelector(".receipt-decision button")') || undefined, 30_000, '连模型卡片');
  await sleep(300);
  await rp.screenshot(panel, join(out, 'card.png'));
  results.push(['回复是带按钮的卡片，不是折起的灰字', await rp.evaluate(panel, 'document.querySelector(".receipt-decision button").textContent === "连一个模型" && !document.querySelector("details.receipt")')]);
  await rp.click(panel, '.receipt-decision button');
  const settings = await until(async () => (await rp.targets()).find((t) => t.url.endsWith('/settings.html')), 10_000, '设置页').catch(() => undefined);

  results.push(['点按钮打开模型设置页', !!settings]);
} finally {
  await rp.close();
}

for (const [name, pass] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);

if (results.some(([, pass]) => !pass)) process.exitCode = 1;
