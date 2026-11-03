/**
 * Given 注册页有 Google 与 GitHub，助手只等用户选择；
 * When 用户回复「默认用goole」；Then 无需交还，助手点击 Google，停在验证码前。
 * Given 用户说「不要 Google，等一下」；Then 仍等待，不动页面。
 * Given 交接实际要求用户完成验证码；When 用户补充文字；Then 页面仍归用户。
 * --live 使用真实模型；默认脚本模型只验证扩展与控制链路。
 */
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
const model = live ? null : await startScriptedModel([
  { match: '[HANDOFF BOUNDARY]', steps: [{ tool: { name: 'click', args: { target: '#google' } } }, { text: '已选择 Google，等待验证。' }] },
  { match: personalGoal, steps: [{ tool: { name: 'hand_to_user', args: { ask: '请完成验证码和安全验证。', targets: ['#code', '#verify'], kind: 'choice', options: ['Google', 'GitHub'] } } }] },
  { match: goal, steps: [{ tool: { name: 'hand_to_user', args: { ask: '请选择用 Google 还是 GitHub 注册。', targets: ['#google', '#github'], kind: 'choice', options: ['Google', 'GitHub'] } } }] },
], undefined, p => { if (p.tools?.length) requests.push(JSON.stringify(p.messages)); });
const rp = await launchRealPath();
let panel = '', work = '';
let result: Record<string, unknown> = {};
try {
  work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  await rp.cdp.send('Page.navigate', { url: origin }, work);
  panel = await rp.attach(await rp.openSidePanel());
  const items = live ? modelStorageItems(await loadModelPlan(modelName)) : { inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model!.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } };
  if (live) items.inproc_fast_model_config = items.inproc_model_config;
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(() => rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled === false`), 60_000, '侧栏就绪');
  const before = await rp.evaluate(work, `document.querySelector('#result').textContent`);
  await rp.click(panel, '#input'); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  if (!known) {
    await until(() => rp.evaluate(panel, live ? `!!document.querySelector('.handoff-card .btn-primary:not(:disabled)') || [...document.querySelectorAll('.msg.assistant')].some(n => /Google/i.test(n.textContent) && /GitHub/i.test(n.textContent) && /[?？]/.test(n.textContent))` : `!!document.querySelector('.handoff-card .btn-primary:not(:disabled)')`), live ? 90_000 : 30_000, '等待用户选择');
    await rp.screenshot(panel, join(out, 'choice-panel.png'));
    if (!live) {
      const requestsBefore = requests.length;
      await rp.click(panel, '#input'); await rp.typeText(panel, '不要 Google，等一下'); await rp.pressEnter(panel);
      await sleep(1500);
      assert.equal(await rp.evaluate(work, `document.querySelector('#result').textContent`), '', '否定选择时不动页面');
      assert.equal(requests.length, requestsBefore, '否定选择时不恢复模型');
      assert.equal(await rp.evaluate(panel, `!!document.querySelector('.handoff-card .btn-primary:not(:disabled)')`), true, '否定选择时仍等待用户');
    }
    await rp.click(panel, '#input'); await rp.typeText(panel, choice); await rp.pressEnter(panel);
  }
  await until(() => rp.evaluate(work, `document.querySelector('#result').textContent === '已选择 Google，等待验证'`), live ? 90_000 : 10_000, '助手点击 Google');
  if (live) await until(() => rp.evaluate(panel, `!!document.querySelector('.handoff-card')?.innerText.includes('验证') || [...document.querySelectorAll('.msg.assistant')].some(n => /验证码|验证.*你|你.*验证/.test(n.textContent))`), 45_000, '助手提示用户完成验证');
  else await sleep(1000);
  const after = await rp.evaluate(work, `document.querySelector('#result').textContent`);
  const delivered = live ? true : requests.some(r => r.includes(choice) && r.includes('[HANDOFF BOUNDARY]'));
  const verification = await rp.evaluate(work, `({visible:!document.querySelector('#verification').hidden,code:document.querySelector('#code').value})`);
  const claimsCompletion = await rp.evaluate(panel, `[...document.querySelectorAll('.msg.assistant')].some(n => /注册成功|已完成注册|账号创建成功/.test(n.textContent))`);
  result = { before, after, delivered, verification, claimsCompletion, userClickedHandback: false, model: live ? modelName : 'scripted', case: known ? 'known' : natural ? 'natural' : 'choice' };
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
    assert.equal(requests.length, count, '验证交接时补充文字不能自动继续');
    assert.equal(await rp.evaluate(work, `document.querySelector('#result').textContent`), '已选择 Google，等待验证', '验证未提交');
    assert.equal(await rp.evaluate(work, `document.querySelector('#code').value`), '', '验证码未填写');
    result.personalHandoffStayedPaused = true;

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
