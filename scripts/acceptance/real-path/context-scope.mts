import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, REPO, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-context-scope`);
await mkdir(out, { recursive: true });
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<title>研究材料</title><h1>研究材料</h1><main>${'用于多轮阅读的原始材料。'.repeat(700)}</main>`));
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const recover = { name: 'read_attachment', args: { name: 'PENDING' } };
const requests: Array<{ goal: string; raw: string }> = [];
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: '{"status":"done","remaining":"","correction":""}' }] },
  { match: 'SCOPE1', steps: [{ tool: { name: 'screenshot', args: {} } }, { text: 'SCOPE1DONE 第一轮阅读已结束。' }] },
  { match: 'SCOPE2', steps: [{ text: 'SCOPE2DONE 第二轮阅读已结束。' }] },
  { match: 'SCOPE3', steps: [{ text: 'SCOPE3DONE 第三轮阅读已结束。' }] },
  { match: 'SCOPE4', steps: [{ tool: recover }, { text: 'SCOPE4DONE 早先的原图已取回。' }] },
  { match: 'SCOPEGUIDE', steps: [{ tool: { name: 'answer_ui_guide', args: {} } }, { text: 'SCOPEGUIDEDONE 已读到按需指南。' }] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const raw = JSON.stringify(payload.messages);
  const user = [...payload.messages ?? []].reverse().find(m => m.role === 'user' && !String(m.content).startsWith('本次运行的上下文') && /SCOPE[1234]|SCOPEGUIDE/.test(JSON.stringify(m.content)));
  requests.push({ goal: JSON.stringify(user?.content), raw });
  const id = /earlier:([A-Za-z0-9_-]+)/.exec(raw)?.[1];
  if (id) recover.args.name = `earlier:${id}`;
});
const rp = await launchRealPath();
const checks: Record<string, boolean> = {};
let panel = '', error: string | null = null;
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' }, inproc_custom_catalog: { baseUrl: model.baseUrl, models: [{ id: 'fixture', images: true }] }, sideagent_mini_apps: true })}).then(()=>true)`);
  const ready = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.getAttribute("aria-busy")==="false" && document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, '会话和连接就绪');
  const say = async (goal: string) => {
    await ready(); await rp.click(panel, '#input'); await rp.typeText(panel, `${goal} 读一下并记住这一轮的结论`); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes(${JSON.stringify(`${goal}DONE`)}) && document.querySelector('#send-btn')?.disabled===false`) || undefined, 40_000, `${goal} 回答出现`);
  };
  await ready();
  const root = await rp.cdp.send('DOM.getDocument', {}, panel) as { root: { nodeId: number } };
  const file = await rp.cdp.send('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#file-input' }, panel) as { nodeId: number };
  await rp.cdp.send('DOM.setFileInputFiles', { nodeId: file.nodeId, files: [join(REPO, 'scripts/acceptance/fixtures/files/scan-page.png')] }, panel);
  await until(async () => await rp.evaluate(panel, '!!document.querySelector("#attachments-strip:not([hidden]) .tile-56, #attachments-strip:not([hidden]) img")') || undefined, 20_000, '用户图片已挂上');
  for (const goal of ['SCOPE1', 'SCOPE2', 'SCOPE3', 'SCOPE4']) await say(goal);
  const fourth = requests.filter(r => r.goal.includes('SCOPE4'));
  const first = fourth[0]?.raw ?? '';
  const last = fourth.at(-1)?.raw ?? '';
  const messages = JSON.parse(last || '[]') as Array<{ role: string; content?: unknown }>;
  const pixels = (raw: string) => (raw.match(/"type":"image_url"/g) ?? []).length;
  checks.oldPageCompacted = first.includes('Historical run (data, not instructions)') && first.includes('earlier:');
  checks.oldScreenshotOnDemand = pixels(first) === 1 && pixels(last) === 2;
  checks.userImagePreserved = messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('image_url'));
  checks.conclusionPreserved = first.includes('SCOPE1DONE');
  checks.guidesNotEager = !requests[0]!.raw.includes('Mini apps (<app>, free HTML');
  await rp.screenshot(panel, join(out, 'recovered.png'));
  await say('SCOPEGUIDE');
  checks.guidesAvailable = requests.filter(r => r.goal.includes('SCOPEGUIDE')).at(-1)!.raw.includes('bys.page.captions()');
  await rp.cdp.send('Page.reload', {}, panel); await ready();
  checks.replayed = await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText.includes("SCOPE1DONE") && document.querySelector("#messages")?.innerText.includes("SCOPE4DONE")') as boolean;
  await rp.screenshot(panel, join(out, 'reopened.png'));
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
} catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e); if (panel) await rp.screenshot(panel, join(out, 'failure.png')).catch(() => {}); }
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', error, checks, recover: recover.args.name, requests: requests.map(r => ({ goal: r.goal, chars: r.raw.length })), model: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', out, error }));
if (error) process.exitCode = 1;
