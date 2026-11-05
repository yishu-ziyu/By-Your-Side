import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';
requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-handoff-reload-stop`);
await mkdir(out, { recursive: true });
const site = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>登录练习</title><h1>请验证</h1><input id=code>'); });
await new Promise<void>(d => site.listen(0, '127.0.0.1', d));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: 'done', remaining: '', correction: '' }) }] },
  { match: '帮我登录', steps: [{ tool: { name: 'hand_to_user', args: { ask: '请在页面上完成验证' } } }, { text: '已继续。' }] },
]);
const rp = await launchRealPath();
const state = (p: string) => rp.evaluate(p, `({stopping:document.querySelector('#send-btn')?.classList.contains('stopping'),takeover:document.querySelector('#takeover-btn')?.hidden?null:document.querySelector('#takeover-btn')?.textContent,placeholder:document.querySelector('#input')?.placeholder,card:!!document.querySelector('.handoff-card .btn-primary:not(:disabled)')})`);
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: origin }, work);
  let panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'x', env: { SIDEAGENT_CUSTOM_ENDPOINT: model.baseUrl } } })}).then(()=>true)`);
  await until(() => rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled === false`), 60000, '就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, '帮我登录'); await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, `!!document.querySelector('.handoff-card .btn-primary:not(:disabled)')`), 30000, '交给用户');
  console.log('handed', JSON.stringify(await state(panel)));
  await rp.evaluate(panel, `chrome.runtime.reload()`).catch(() => {});
  await sleep(4000);
  panel = await rp.attach(await rp.openSidePanel());
  await until(() => rp.evaluate(panel, `!!document.querySelector('#input')`), 20000, '重开侧栏');
  await sleep(4000);
  console.log('reopened', JSON.stringify(await state(panel)));
  await rp.screenshot(panel, join(out, 'after-reload.png'));
  for (let i = 0; i < 3; i++) {
    const s = await state(panel);
    if (!s.stopping) break;
    await rp.click(panel, '#send-btn');
    await sleep(2500);
    console.log('stop click', i + 1, JSON.stringify(await state(panel)));
  }
  await rp.screenshot(panel, join(out, 'after-stop.png'));
  const end = await state(panel);
  const staleCard = await rp.evaluate(panel, `!!document.querySelector('.handoff-card')`);
  if (end.stopping || end.takeover || staleCard) { console.error('FAIL 交给用户后重新加载扩展，点停止没有结束任务', JSON.stringify({ end, staleCard })); process.exitCode = 1; }
  else console.log('PASS 交给用户后重新加载扩展，点停止能结束任务');
} catch (e) { console.error('FAIL', e instanceof Error ? e.message : e); process.exitCode = 1; }
await rp.close(); await rp.remove(); await model.close(); site.close();
