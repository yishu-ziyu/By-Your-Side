import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, REPO, siteAddress, until, sleep } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';
import { loadModelPlan, modelStorageItems, DEFAULT_TEST_MODEL } from './inproc-config.mjs';

requireHeadless();
const live = process.argv.includes('--live');
const known = live && process.argv.includes('--case=known');
const natural = live && process.argv.includes('--case=natural');
const modelName = process.argv.find(a => a.startsWith('--model='))?.slice(8) ?? DEFAULT_TEST_MODEL;
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-login-choice`);
await mkdir(out, { recursive: true });
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>申请账号</title><h1>选择注册方式</h1><button id="google" onclick="document.querySelector('#result').textContent='已选择 Google，等待验证';document.querySelector('#verification').hidden=false">Continue with Google</button><button id="github" onclick="document.querySelector('#result').textContent='已选择 GitHub'">Continue with GitHub</button><p id="result"></p><div id="verification" hidden><label>验证码 <input id="code" autocomplete="one-time-code"></label><button id="verify" onclick="document.querySelector('#result').textContent='验证已提交'">验证</button></div>`));
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const goal = known ? '帮我完成申请，使用 Google 登录；遇到验证码请交给我。' : natural ? '帮我完成申请。' : live ? '帮我完成申请，请先问我选择哪种注册方式。遇到验证码请交给我。' : '帮我完成申请';
const choice = process.argv.includes('--case=ordinal') ? '第一个' : '默认用goole';
const personalGoal = '测试人工验证';
const requests: string[] = [];
const routing = { match: '"clauses":', steps: [{ text: '{}' }] };
const model = live ? null : await startScriptedModel([
  routing,
  { match: '[HANDOFF BOUNDARY]', steps: [{ tool: { name: 'click', args: { target: '#google' } } }, { text: '已选择 Google，等待验证。' }] },
  { match: personalGoal, steps: [{ tool: { name: 'hand_to_user', args: { ask: '请完成验证码和安全验证。', targets: ['#code', '#verify'], kind: 'choice', options: ['Google', 'GitHub'] } } }] },
  { match: goal, steps: [{ text: '请选择 Google 或 GitHub。', pieces: [{ text: '请选择 Google 或 GitHub。' }, { text: '\n', delayMs: 2000 }], thenTool: { name: 'hand_to_user', args: { ask: '请选择用 Google 还是 GitHub 注册。', kind: 'choice', options: ['Google', 'GitHub'] } } }] },
], undefined, async p => {
  if (p.tools?.length) requests.push(JSON.stringify(p.messages));
  if (p.messages?.some(m => typeof m.content === 'string' && m.content.startsWith("Route a user's message"))) {
    const input = JSON.parse(String(p.messages.find(m => m.role === 'user')?.content));
    routing.steps[0]!.text = JSON.stringify({ steps: [{ action: 'steer', taskId: input.tasks[0].id }] });
    if (input.message === choice) await sleep(4000);
  }
});
const rp = await launchRealPath();
let panel = '', work = '';
let result: Record<string, unknown> = { model: live ? modelName : 'scripted', case: known ? 'known' : natural ? 'natural' : 'choice' };
try {
  work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: origin }, work);
  panel = await rp.attach(await rp.openSidePanel());
  const items = live ? modelStorageItems(await loadModelPlan(modelName)) : { inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model!.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } };
  if (live) items.inproc_fast_model_config = items.inproc_model_config;
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(() => rp.evaluate(panel, `document.querySelector('#conversation-new')?.disabled === false && document.querySelector('#send-btn')?.disabled === false`), 60_000, '侧栏就绪');
  const before = await rp.evaluate(work, `document.querySelector('#result').textContent`);
  let choiceAnswer = '';
  await rp.click(panel, '#input'); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  if (!known) {
    await until(async () => (live && await rp.evaluate(work, `document.querySelector('#result').textContent !== ''`)) || await rp.evaluate(panel, `!!document.querySelector('.handoff-card .btn-primary:not(:disabled)') || [...document.querySelectorAll('.msg.assistant')].some(n => /Google/i.test(n.innerText) && /GitHub/i.test(n.innerText))`), live ? 90_000 : 30_000, '等待用户选择或页面操作');
    await rp.screenshot(panel, join(out, 'choice-panel.png'));
    assert.equal(await rp.evaluate(work, `document.querySelector('#result').textContent`), '', '用户未选择时，助手不能自行点击登录方式');
    choiceAnswer = String(await rp.evaluate(panel, `[...document.querySelectorAll('.msg.assistant')].map(n => n.innerText).join('')`));
    await rp.click(panel, '#input'); await rp.typeText(panel, choice); await rp.pressEnter(panel);
  }
  await until(() => rp.evaluate(work, `document.querySelector('#result').textContent === '已选择 Google，等待验证'`), live ? 90_000 : 10_000, '助手点击 Google');
  if (live) {
    await until(() => rp.evaluate(panel, `!!document.querySelector('.handoff-card .btn-primary:not(:disabled)') || [...document.querySelectorAll('.msg.assistant[data-delivery-kind="reply"]:not([data-streaming])')].some(n => /验证/.test(n.innerText) && !${JSON.stringify(choiceAnswer)}.includes(n.innerText))`), 45_000, '等待验证码交接或本轮结束');
    const handoff = await rp.evaluate(panel, `({ask:document.querySelector('.handoff-card')?.innerText ?? '',control:document.querySelector('#takeover-btn')?.textContent})`);
    result.handoff = handoff;
    assert.ok(/验证/.test(String(handoff.ask)) && handoff.control === '交还', '验证码步骤必须真正交给用户，不能只用文字要求用户操作');
  }
  else await sleep(1000);
  const after = await rp.evaluate(work, `document.querySelector('#result').textContent`);
  const delivered = live ? true : requests.some(r => r.includes(choice) && r.includes('[HANDOFF BOUNDARY]'));
  const verification = await rp.evaluate(work, `({visible:!document.querySelector('#verification').hidden,code:document.querySelector('#code').value})`);
  const claimsCompletion = await rp.evaluate(panel, `[...document.querySelectorAll('.msg.assistant')].some(n => /注册成功|已完成注册|账号创建成功/.test(n.textContent))`);
  result = { ...result, before, after, delivered, verification, claimsCompletion, userClickedHandback: false };
  await rp.screenshot(panel, join(out, 'panel.png'));
  await rp.screenshot(work, join(out, 'page.png'));
  assert.equal(before, '', '回复前未点击');
  assert.equal(delivered, true, '选择送进原任务');
  assert.equal(after, '已选择 Google，等待验证', '无需额外点交还，助手实际点击 Google');
  assert.deepEqual(verification, { visible: true, code: '' }, '验证码仍由用户处理');
  assert.equal(claimsCompletion, false, '验证未完成时不声称注册成功');
  if (!live) {
    await until(() => rp.evaluate(panel, `document.querySelector('#conversation-new')?.disabled === false`), 30_000, '可以新建会话');
    await rp.click(panel, '#conversation-new');
    await until(() => rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled === false && !document.querySelector('.handoff-card')`), 30_000, '新会话就绪');
    await rp.click(panel, '#input'); await rp.typeText(panel, personalGoal); await rp.pressEnter(panel);
    await until(() => rp.evaluate(panel, `!!document.querySelector('.handoff-card .btn-primary:not(:disabled)')`), 30_000, '等待用户亲手验证');
    const card = await rp.evaluate(panel, `document.querySelector('.handoff-card').innerText`);
    assert.ok(String(card).includes('需要你来这一步'), '验证码要求不能冒充只需回答的选择');
    const count = requests.length;
    await rp.click(panel, '#input'); await rp.typeText(panel, 'Google'); await rp.pressEnter(panel);
    await sleep(1500);
    assert.ok(requests.length > count, '交给用户后，用户说话就接着做');
    assert.equal(await rp.evaluate(work, `document.querySelector('#result').textContent`), '已选择 Google，等待验证', '验证未提交');
    assert.equal(await rp.evaluate(work, `document.querySelector('#code').value`), '', '验证码未填写');
    result.personalHandoffContinued = true;

  }
  console.log('PASS 登录方式选择后继续', JSON.stringify(result));
} catch (error) {
  if (panel) {
    result.panelState = await rp.evaluate(panel, `({text:document.body.innerText.slice(-1600), send:document.querySelector('#send-btn')?.className, newDisabled:document.querySelector('#conversation-new')?.disabled, handoff:!!document.querySelector('.handoff-card')})`).catch(() => null);
    await rp.screenshot(panel, join(out, 'failure-panel.png')).catch(() => {});
  }
  console.error('FAIL 登录方式选择后继续', JSON.stringify(result), String(error));
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
  await rp.close(); await rp.remove(); await model?.close(); await new Promise<void>(r => site.close(() => r()));
}
