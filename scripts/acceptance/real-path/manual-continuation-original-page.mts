/** Same live browser: ask on A, switch to B, click continue, and verify the resumed prompt and answer use A. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from './harness.mts';
import { startScriptedModel, type Step } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-manual-continuation-original-page`);
await mkdir(out, { recursive: true });
const site = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.url === '/b'
  ? '<!doctype html><title>页面乙</title><p>页面乙校验码：海星</p>'
  : '<!doctype html><title>页面甲</title><p>页面甲校验码：枫叶</p><button id="blocked" disabled>核对</button>'));
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const goal = '读出页面甲的校验码，并点核对按钮。';
const resumeSteps: Step[] = [{ text: '续做输入不正确。' }];
let resumedPrompt = '';
const model = await startScriptedModel([
  { match: '[TASK CONTINUATION]', steps: resumeSteps },
  { match: '"lastReply"', steps: [{ text: JSON.stringify({ status: 'needs_user', remaining: '核对按钮不可用', correction: '' }) }] },
  { match: goal, steps: [
    { tool: { name: 'snapshot', args: {} } },
    { tool: { name: 'click', args: { target: '#blocked', label: '核对' } } },
    { text: '核对按钮不可用，校验码暂未确认。' },
  ] },
], undefined, payload => {
  for (const message of payload.messages ?? []) {
    if (message.role !== 'user') continue;
    const text = typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
    if (!text.includes('[TASK CONTINUATION]')) continue;
    resumedPrompt = text;
    resumeSteps[0] = { text: text.includes('页面甲校验码：枫叶') && !text.includes('页面乙校验码：海星') && text.includes('校验码')
      ? '页面甲校验码：枫叶；核对按钮不可用。' : '续做拿到了错误的页面或目标。' };
  }
});
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let panel = '', failure = '';
try {
  const a = await until(async () => (await rp.targets()).find(t => t.type === 'page' && t.url === 'about:blank'), 10_000, '页面甲');
  const work = await rp.attach(a.targetId);
  await rp.cdp.send('Page.navigate', { url: `${origin}/a` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await until(() => rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, '侧栏就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("核对按钮不可用")'), 60_000, '原任务未完成');
  await until(() => rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")'), 30_000, '原任务结束');
  const hasResumeButton = await rp.evaluate(panel, '(()=>{const r=document.querySelector("#resume-entry-root");return !!r&&!r.hidden&&!!r.querySelector(".resume-action")})()');
  evidence.hasResumeButton = hasResumeButton;
  console.log(`初次回答后续做按钮：${hasResumeButton ? '有' : '无，将输入继续原任务'}`);
  await rp.screenshot(work, join(out, 'page-a.png'));
  const b = await rp.cdp.send('Target.createTarget', { url: `${origin}/b` });
  await rp.cdp.send('Target.activateTarget', { targetId: b.targetId });
  const pageB = await rp.attach(b.targetId);
  await until(() => rp.evaluate(pageB, 'document.body?.textContent.includes("海星")'), 15_000, '页面乙就绪');
  await rp.screenshot(pageB, join(out, 'page-b.png'));
  if (hasResumeButton) await rp.click(panel, '#resume-entry-root .resume-action');
  else { await rp.click(panel, '#input'); await rp.typeText(panel, '继续原任务'); await rp.pressEnter(panel); }
  await until(() => resumedPrompt || undefined, 30_000, '手动续做请求');
  await until(() => rp.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("页面甲校验码：枫叶；核对按钮不可用") || document.querySelector("#messages")?.textContent.includes("续做拿到了错误的页面或目标")'), 30_000, '续做回答');
  await sleep(300);
  const shown = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent??""'));
  evidence.resumeHasA = resumedPrompt.includes('页面甲校验码：枫叶');
  evidence.resumeHasB = resumedPrompt.includes('页面乙校验码：海星');
  evidence.resumeHasGoal = resumedPrompt.includes('校验码');
  evidence.shown = shown;
  await rp.screenshot(panel, join(out, 'panel.png'));
  assert.equal(evidence.resumeHasA, true, '续做请求必须包含 A 的当前页面内容');
  assert.equal(evidence.resumeHasB, false, '续做请求不能把 B 当作原页面');
  assert.equal(evidence.resumeHasGoal, true, '续做请求保留原问题');
  assert.ok(shown.includes('页面甲校验码：枫叶；核对按钮不可用。'), '用户看到针对 A 的回答');
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  evidence.requests = model.requests;
  evidence.resumedPromptSeen = !!resumedPrompt;
  if (panel) {
    evidence.panel = await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent??""').catch(() => null);
    await rp.screenshot(panel, join(out, 'failure.png')).catch(() => {});
  }
}
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', failure, evidence }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}
console.log(JSON.stringify({ status: failure ? 'FAIL' : 'PASS', out, failure }));
if (failure) process.exitCode = 1;
