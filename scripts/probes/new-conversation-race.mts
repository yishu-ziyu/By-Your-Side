/**
 * 前提实验：点「新会话」后隔 delay 毫秒就发消息，这条消息进的是新对话还是旧对话？
 *   npx tsx scripts/probes/new-conversation-race.mts --headless --delay=0
 * 判据：模型收到的这一轮请求里带不带旧对话的暗号。退出码 0 = 进了新对话，1 = 进了旧对话。
 */
import { createServer } from 'node:http';
import { launchRealPath, requireHeadless, siteAddress, until, sleep } from '../acceptance/real-path/harness.mts';
import { configureViaSettings } from '../acceptance/real-path/inproc-config.mts';
import { startScriptedModel } from '../acceptance/real-path/scripted-model.mts';

requireHeadless();
const delay = Number(process.argv.find((a) => a.startsWith('--delay='))?.slice(8) ?? 0);
const code = `暗号${Date.now()}`;
const requests: string[] = [];
const model = await startScriptedModel([{ match: '第一段', steps: [{ text: '记下了。' }] }, { match: '第二段', steps: [{ text: '第二段收到。' }] }], undefined, (p) => { requests.push(JSON.stringify(p)); });
const site = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end('<!doctype html><title>练习页</title><p>一页普通文字。</p>'));
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const rp = await launchRealPath();
let leaked: boolean | null = null;

try {
  const work = await rp.attach((await until(async () => (await rp.targets()).find((t) => t.url === 'about:blank'), 10_000, '空白页')).targetId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: 'custom', modelId: 'fixture', credential: { type: 'api_key', key: 'local-fixture' } }, { baseUrl: model.baseUrl });
  await rp.cdp.send('Target.closeTarget', { targetId: configured.settingsTargetId });
  const settled = 'document.querySelector("#conversation-new")?.getAttribute("aria-busy") !== "true" && document.querySelector("#send-btn")?.disabled === false';
  await until(async () => await rp.evaluate(panel, settled) || undefined, 60_000, '侧栏就绪');
  const send = async (text: string, on = panel) => { await rp.click(on, '#input'); await rp.typeText(on, text); await rp.pressEnter(on); };
  await send(`第一段：${code}`);
  await until(async () => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText ?? ""')).includes('记下了') || undefined, 30_000, '第一段回答');
  await sleep(1000);
  let p = panel;
  if (process.argv.includes('--restart')) { await rp.restart(); p = await rp.attach(await rp.openSidePanel()); await until(async () => await rp.evaluate(p, settled) || undefined, 60_000, '重启后侧栏就绪'); }
  const before = requests.length;
  await rp.click(p, '#conversation-new');
  await sleep(delay);
  await send('第二段：你好', p);
  await until(async () => requests.slice(before).find((r) => r.includes('第二段')), 30_000, '第二段请求');
  leaked = requests.slice(before).filter((r) => r.includes('第二段')).some((r) => r.includes(code));
  await sleep(1500);
  const view = await rp.evaluate(p, '({ msgs: document.querySelector("#messages")?.innerText.slice(0, 160), conversations: document.querySelectorAll("[data-conversation-id]").length })');
  console.log(JSON.stringify({ delay, restart: process.argv.includes('--restart'), leaked, view }));
} finally {
  await rp.close();
  site.close();
  await model.close?.();
}

process.exitCode = leaked === false ? 0 : 1;
