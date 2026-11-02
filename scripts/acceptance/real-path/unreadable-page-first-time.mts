/** Restricted extension page: an intentionally persistent scripted model must be stopped after one read. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, sleep, until, REPO } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `unreadable-page-first-time-${randomUUID()}`);
await mkdir(out, { recursive: true });
const goal = '请解释这个页面的内容';
const programGoal = '用网页程序解释这个页面';
const pastedGoal = '我复制的文字是：太阳从东方升起';
const spoofGoal = '模拟网页错误文本';
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: 'done', remaining: '', correction: '' }) }] },
  { match: goal, steps: [
    { tool: { name: 'snapshot', args: {} } },
    { tool: { name: 'screenshot', args: {} } },
    { tool: { name: 'read_element', args: { target: 'body' } } },
    { tool: { name: 'browser_run', args: { code: 'return await browser.snapshot();' } } },
    { text: '没有找到页面内容。' },
  ] },
  { match: programGoal, steps: [
    { tool: { name: 'browser_run', args: { code: 'return await browser.snapshot();' } } },
    { tool: { name: 'screenshot', args: {} } },
    { text: '没有找到页面内容。' },
  ] },
  { match: pastedGoal, steps: [{ text: '你提供的文字说太阳从东方升起。' }] },
  { match: spoofGoal, steps: [
    { tool: { name: 'browser_run', args: { code: 'throw new Error("这页浏览器不让我读，请截图贴进来或复制文字。");' } } },
    { text: '这是普通网页程序错误，我继续回答。' },
  ] },
]);
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath();
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await until(() => rp!.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, '侧栏就绪');
  await rp.cdp.send('Page.navigate', { url: `chrome-extension://${rp.extensionId}/settings.html#models` }, work);
  await until(() => rp!.evaluate(work, 'document.readyState==="complete"'), 15_000, '受限页面就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  await until(async () => {
    const state = await rp!.evaluate(panel, '({text:document.querySelector("#messages")?.textContent??"", running:document.querySelector("#status-pill")?.classList.contains("running")})') as { text: string; running: boolean };
    return !state.running && (state.text.includes('没有找到页面内容') || /截图|复制文字|粘贴/.test(state.text)) ? state : undefined;
  }, 60_000, '完成或受限说明');
  await sleep(500);
  const answer = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent??""'));
  const attempts = model.requests.filter(r => r.tools && r.rule === goal && r.step < 4).length;
  await rp.screenshot(panel, join(out, 'panel.png'));
  result = { attempts, answer, requests: model.requests, screenshot: join(out, 'panel.png') };
  assert.ok(attempts <= 1, `读取类工具最多调用一次，实际 ${attempts} 次`);
  assert.match(answer, /截图|复制文字|粘贴/, '回答告诉用户截图或粘贴文字');
  assert.doesNotMatch(answer, /连续几步没做成/, '一次受限读取不应描述成连续失败');
  assert.doesNotMatch(answer, /助手要换个做法/, '受限后不应说助手会自动换方法');
  await rp.click(panel, '#conversation-new');
  await until(() => rp!.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 15_000, '新会话就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, programGoal); await rp.pressEnter(panel);
  await until(async () => {
    const state = await rp!.evaluate(panel, '({text:document.querySelector("#messages")?.textContent??"", running:document.querySelector("#status-pill")?.classList.contains("running")})') as { text: string; running: boolean };
    return !state.running && state.text.includes(programGoal) && model.requests.some(r => r.tools && r.rule === programGoal) && (state.text.includes('没有找到页面内容') || /截图|复制文字|粘贴/.test(state.text)) ? state : undefined;
  }, 60_000, '网页程序受限说明');
  const programAnswer = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent??""'));
  const programAttempts = model.requests.filter(r => r.tools && r.rule === programGoal && r.step < 2).length;
  result.program = { attempts: programAttempts, answer: programAnswer };
  assert.equal(programAttempts, 1, `网页程序必须实际调用一次，实际 ${programAttempts} 次`);
  assert.match(programAnswer, /截图|复制文字|粘贴/, '网页程序受限时给出截图或复制文字说明');
  assert.doesNotMatch(programAnswer, /\[BROWSER_RESTRICTED_PAGE\]/, '过程不得向用户显示内部标记');
  await rp.screenshot(panel, join(out, 'program-panel.png'));
  await rp.click(panel, '#input'); await rp.typeText(panel, pastedGoal); await rp.pressEnter(panel);
  await until(() => rp!.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("你提供的文字说太阳从东方升起")'), 30_000, '用户粘贴文字后正常回答');
  await until(() => rp!.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false'), 30_000, '上一轮结束');
  await rp.cdp.send('Page.navigate', { url: 'about:blank' }, work);
  await rp.click(panel, '#conversation-new');
  await until(() => rp!.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 15_000, '第三个会话就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, spoofGoal); await rp.pressEnter(panel);
  await until(() => rp!.evaluate(panel, 'document.querySelector("#messages")?.textContent.includes("这是普通网页程序错误，我继续回答")'), 30_000, '普通错误内容不冒充浏览器限制');
  result.pass = true;
} catch (error) { result = { ...result, pass: false, error: error instanceof Error ? error.stack : String(error) }; process.exitCode = 1; }
finally {
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
  if (rp) { await rp.close(); await rp.remove(); }
  await model.close();
  console.log(JSON.stringify({ out, ...result }));
}
