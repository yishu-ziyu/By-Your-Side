/** Restricted extension page: one read explains the restriction, a second read stops the run. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchRealPath, requireHeadless, sleep, until, watchInproc, REPO } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `unreadable-page-first-time-${randomUUID()}`);
await mkdir(out, { recursive: true });
const goal = '请解释这个页面的内容';
const programGoal = '用网页程序解释这个页面';
const pastedGoal = '我复制的文字是：太阳从东方升起';
const spoofGoal = '模拟网页错误文本';
const parallelGoal = '并行读取受限页面';
const slowParallelGoal = '并行读取受限页面和等待';
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
  { match: slowParallelGoal, steps: [
    { tool: { name: 'snapshot', args: {} } },
    { tools: [{ name: 'browser_run', args: { code: 'await browser.sleep({ms:8000}); return "wait complete";' } }, { name: 'screenshot', args: {} }] },
    { text: '并行工具占位。' },
    { text: '不应该等完或继续。' },
  ] },
  { match: parallelGoal, steps: [
    { tool: { name: 'snapshot', args: {} } },
    { tools: [{ name: 'screenshot', args: {} }, { name: 'tabs', args: { action: 'list' } }] },
    { text: '并行工具占位。' },
    { text: '不应该在第二次受限读取后继续。' },
  ] },
]);
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
let diagnostics: Awaited<ReturnType<typeof watchInproc>> | undefined;
const progress = setInterval(() => console.log(JSON.stringify({ phase: 'waiting', requests: model.requests.filter(r => r.tools).map(r => ({ rule: r.rule, step: r.step })) })), 10_000);
try {
  rp = await launchRealPath();
  const work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await until(() => rp!.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, '侧栏就绪');
  diagnostics = await watchInproc(rp, rp.extensionId);
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
  type Trace = { type: string; runId?: string; data?: { text?: string; toolName?: string; isError?: boolean; result?: { content?: Array<{ type?: string; text?: string }> } } };
  const readTraces = () => rp!.evaluate(panel, `new Promise((resolve,reject)=>{const o=indexedDB.open('sideagent-diagnostics');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result;const q=db.transaction('trace-lines').objectStore('trace-lines').getAll();q.onerror=()=>reject(q.error);q.onsuccess=()=>{resolve(q.result.map(x=>JSON.parse(x.line)));db.close()}}})`) as Promise<Trace[]>;
  const failures = await until(async () => {
    const rows = await readTraces();
    const restricted = rows.filter(row => row.type === 'tool_execution_end' && row.data?.isError === true && ['snapshot', 'screenshot'].includes(row.data.toolName ?? ''));
    return restricted.length >= 2 ? restricted : undefined;
  }, 10_000, '两次受限工具结果已记录');
  await rp.screenshot(panel, join(out, 'panel.png'));
  result = { attempts, answer, requests: model.requests, screenshot: join(out, 'panel.png'), failures };
  assert.equal(attempts, 2, `第一次说明、第二次受阻后停止，实际 ${attempts} 次`);
  assert.deepEqual(failures.map(row => row.data?.toolName), ['snapshot', 'screenshot'], '第二次调用没有变成第三次');
  // 第二次受限读取会停下本轮，模型不会再看到它的结果，所以只要求第一次带说明。
  assert.ok(failures[0].data?.result?.content?.some(part => part.type === 'text' && part.text?.includes('浏览器不允许读取这一页的内容')), '第一次受限读取返回限制说明');
  for (const row of failures) assert.ok(!(row.data?.result?.content ?? []).some(part => part.type === 'image'), '受限调用没有返回页面截图');
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
  assert.equal(programAttempts, 2, `网页程序首次读取和第二次读取后停止，实际 ${programAttempts} 次`);
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
  await until(() => rp!.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false'), 30_000, '普通错误处理结束');
  await rp.cdp.send('Page.navigate', { url: `chrome-extension://${rp.extensionId}/settings.html#models` }, work);
  await rp.click(panel, '#conversation-new');
  await until(() => rp!.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 15_000, '并行调用会话就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, parallelGoal); await rp.pressEnter(panel);
  await until(async () => {
    const state = await rp!.evaluate(panel, '({text:document.querySelector("#messages")?.textContent??"",running:document.querySelector("#status-pill")?.classList.contains("running")})') as { text: string; running: boolean };
    return !state.running && state.text.includes(parallelGoal) && (state.text.includes('这页浏览器不让我读') || state.text.includes('不应该在第二次受限读取后继续')) ? state : undefined;
  }, 60_000, '并行受限读取后的回答');
  const parallelAnswer = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent??""'));
  const parallelSteps = model.requests.filter(r => r.tools && r.rule === parallelGoal).map(r => r.step);
  result.parallel = { answer: parallelAnswer, steps: parallelSteps };
  assert.ok(parallelAnswer.includes('这页浏览器不让我读'), '并行工具结果后仍要给出受限说明');
  assert.ok(!parallelAnswer.includes('不应该在第二次受限读取后继续'), '并行工具不能让第二次受限读取后继续');
  assert.deepEqual(parallelSteps, [0, 1], '第二次受限读取后不能再调用模型');
  await until(() => rp!.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false'), 30_000, '并行调用结束');
  await rp.click(panel, '#conversation-new');
  await until(() => rp!.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 15_000, '慢并行调用会话就绪');
  await rp.click(panel, '#input'); await rp.typeText(panel, slowParallelGoal);
  const started = Date.now();
  await rp.pressEnter(panel);
  await until(async () => {
    const state = await rp!.evaluate(panel, '({text:document.querySelector("#messages")?.textContent??"",running:document.querySelector("#status-pill")?.classList.contains("running")})') as { text: string; running: boolean };
    return !state.running && state.text.includes(slowParallelGoal) && (state.text.includes('这页浏览器不让我读') || state.text.includes('不应该等完或继续')) ? state : undefined;
  }, 30_000, '慢并行调用后的回答');
  const elapsedMs = Date.now() - started;
  const slowSteps = model.requests.filter(r => r.tools && r.rule === slowParallelGoal).map(r => r.step);
  const slowTrace = await until(async () => {
    const rows = await readTraces();
    const runId = rows.findLast(row => row.type === 'run_start' && row.data?.text === slowParallelGoal)?.runId;
    const events = rows.filter(row => row.runId === runId && ['tool_execution_start', 'tool_execution_end'].includes(row.type));
    return events.some(row => row.type === 'tool_execution_end' && row.data?.toolName === 'browser_run') ? events : undefined;
  }, 10_000, '慢工具停止结果已记录');
  const slowStarted = slowTrace.findIndex(row => row.type === 'tool_execution_start' && row.data?.toolName === 'browser_run');
  const restrictedEnded = slowTrace.findIndex(row => row.type === 'tool_execution_end' && row.data?.toolName === 'screenshot');
  const slowEnded = slowTrace.find(row => row.type === 'tool_execution_end' && row.data?.toolName === 'browser_run');
  result.slowParallel = { elapsedMs, steps: slowSteps, slowStarted, restrictedEnded, slowEnded };
  assert.deepEqual(slowSteps, [0, 1], '慢并行工具不能让第二次受限读取后继续');
  assert.ok(slowStarted >= 0 && slowStarted < restrictedEnded, '慢工具必须已启动，才能验证在途任务取消');
  assert.equal(slowEnded?.data?.isError, true, '已经启动的慢工具应当被停止');
  assert.ok(elapsedMs < 6_000, `不能等并行的 8 秒任务结束，实际 ${elapsedMs}ms`);
  result.pass = true;
} catch (error) { result = { ...result, pass: false, error: error instanceof Error ? error.stack : String(error), logs: diagnostics?.logs().split('\n').slice(-40), requests: model.requests }; process.exitCode = 1; }
finally {
  clearInterval(progress);
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
  if (rp) { await rp.close(); await rp.remove(); }
  await model.close();
  console.log(JSON.stringify({ out, ...result }));
}
