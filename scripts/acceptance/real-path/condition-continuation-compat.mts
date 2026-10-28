/**
 * Legacy checkpoint compatibility through real A -> B package replacement.
 * A leaves an ordinary read task open, with no continuation metadata. B must
 * recover its original goal/run and prior answer, wait for the real resume
 * user message "继续原任务", then read the original page and finish the remaining item.
 * No checkpoint or protocol facts are injected. Only the model and page are scripted.
 * npx tsx scripts/acceptance/real-path/condition-continuation-compat.mts --headless --baseline=/abs/A --candidate=/abs/B-final
 * This case does not test B -> A downgrade; report that separately as unrun.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from './harness.mts';
import { startScriptedModel, type Step } from './scripted-model.mts';
import { redactCredentialText } from '../../../shared/untrusted.js';
import type { TaskView } from '../../../shared/task-view.js';

requireHeadless();
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baselineArg = arg('baseline'), candidateArg = arg('candidate');
assert.ok(baselineArg && candidateArg, '--baseline=<A> and --candidate=<B-final> are required');
const baseline = await realpath(resolve(baselineArg)), candidate = await realpath(resolve(candidateArg));
assert.notEqual(baseline, candidate, 'A and B must be distinct prepared packages');
for (const dist of [baseline, candidate]) await readFile(join(dist, 'manifest.json'), 'utf8');
const artifacts = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-condition-continuation-compat`);
await mkdir(artifacts, { recursive: true });
const ASK = '旧记录兼容验收：分别核对当前页甲和乙的分数，并说明原页面依据。';
const PARTIAL = '【旧版已有回答】已核对甲：90分，依据是当前页第一项；乙的分数尚未核对，这个目标还没全部完成。';
const FINAL = '【兼容续做完成】甲90分，乙60分。乙的分数已从原页面第二项重新读取并核对；原来已核对的甲90分保留。';
const RESUME_CONTROL = '继续原任务';
const phases: Array<{ at: number; phase: string; detail?: unknown }> = [];
const log = (phase: string, detail?: unknown) => { const entry = { at: Date.now(), phase, ...(detail === undefined ? {} : { detail }) }; phases.push(entry); console.log(JSON.stringify(entry)); };
const stage = async <T,>(name: string, run: () => Promise<T>): Promise<T> => {
  log(`${name}：开始`);
  try { const value = await run(); log(`${name}：完成`); return value; }
  catch (error) { log(`${name}：失败`, redactCredentialText(String(error)).slice(0, 1800)); throw error; }
};
type Message = { role: string; name?: string; tool_call_id?: string; content?: string | Array<{ text?: string }> | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type Payload = { at: number; tools?: unknown[]; messages?: Message[] };
const textOf = (content: Message['content']) => typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
const payloads: Payload[] = [];
const checker: Step = { text: '' };
const resumed: Step[] = [
  { tool: { name: 'snapshot', args: {} } },
  { tool: { name: 'read_element', args: { target: '#second' } } },
  { text: FINAL },
];
const model = await startScriptedModel([
  { match: '"lastReply"', steps: [checker] },
  { match: '"requests"', steps: [{ text: JSON.stringify({ scope: 'local' }) }] },
  { match: '"userMessage"', steps: [{ text: JSON.stringify({ feedback: 'none', aspect: null, lasting: false, rule: '', evidence: '' }) }] },
  { match: '"task":', steps: [{ text: JSON.stringify({ title: '旧记录核对' }) }] },
  { match: '[TASK CONTINUATION]', steps: resumed },
  { match: '[RESTART CONTINUATION]', steps: resumed },
  { match: ASK, steps: [{ tool: { name: 'snapshot', args: {} } }, { tool: { name: 'read_element', args: { target: '#first' } } }, { text: PARTIAL }] },
], undefined, payload => {
  const entry = { at: Date.now(), ...structuredClone(payload) } as Payload;
  payloads.push(entry);
  const user = [...(entry.messages ?? [])].reverse().find(message => message.role === 'user');
  const done = textOf(user?.content).includes('"lastReply"') && textOf(user?.content).includes(FINAL);
  checker.text = JSON.stringify({ status: done ? 'done' : 'open', remaining: done ? '' : '乙的分数尚未核对', items: [{ text: '核对甲的分数并说明依据', done: true }, { text: '核对乙的分数并说明依据', done }] });
  log('脚本模型收到实际请求', { count: payloads.length, tools: !!payload.tools?.length });
});
const site = createServer((req, res) => {
  if (req.url !== '/') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>旧任务原始依据</title>
  <style>body{font:18px/1.8 -apple-system,sans-serif;margin:40px;max-width:760px}section{padding:20px;margin:24px 0;border:1px solid #ddd}</style>
  <main><h1>原页面分数记录</h1><p>这份页面是本地兼容验收的原始来源。甲和乙是两个独立项目，各自的分数只表示这个项目本次记录的值。核对任意一项时，必须直接读取该项的文字，保留已经核实的另一项。页面不包含任何提交、保存或发送操作。</p>
  <section id="first">甲：90分。来源：本页第一项记录。</section><section id="second">乙：60分。来源：本页第二项记录。</section></main></html>`);
});
await new Promise<void>(resolveListen => site.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let panel = '', work = '', phase = 'baseline', error: string | null = null;
let oldView: TaskView | undefined, restoredView: TaskView | undefined, finalView: TaskView | undefined;
let beforeViews: TaskView[] = [], afterViews: TaskView[] = [];
let oldPanel = '', restoredPanel = '', finalPanel = '';
let quietWindow: { before: number; after: number; from: number; to: number } | null = null;
let resumeRequestedAt: number | null = null;
let replacement: unknown = null;
const bundleHashes = async (directory: string) => Object.fromEntries(await Promise.all(['background.js', 'inproc.js', 'sidepanel.js'].map(async name => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')])));
const baselineHashes = await bundleHashes(baseline), candidateHashes = await bundleHashes(candidate);
try {
  rp = await stage('使用旧版A启动隔离真实扩展', () => launchRealPath({ dist: baseline }));
  const browser = rp;
  const openOriginalPage = async () => {
    const targets = await browser.targets();
    let page = targets.find(target => target.type === 'page' && target.url === origin);
    if (!page) {
      page = targets.find(target => target.type === 'page' && target.url === 'about:blank');
      if (!page) { const created = await browser.cdp.send('Target.createTarget', { url: origin }); page = { targetId: created.targetId, type: 'page', url: origin, title: '' }; }
    }
    work = await browser.attach(page.targetId);
    if (page.url !== origin) await browser.cdp.send('Page.navigate', { url: origin }, work);
    await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
    await until(() => browser.evaluate(work, '!!document.querySelector("#first")&&!!document.querySelector("#second")'), 10_000, 'same original page');
  };
  const installReadPort = async () => browser.evaluate(panel, `(() => {
    globalThis.__compatViews=[];globalThis.__compatMessages=[];const port=chrome.runtime.connect({name:'sideagent-panel'});globalThis.__compatPort=port;
    port.onMessage.addListener(message=>{globalThis.__compatMessages.push(message);if(message.kind==='server'&&message.msg?.type==='task_view')globalThis.__compatViews.push(message.msg.view)});
    port.postMessage({kind:'sync',afterSeq:0});port.postMessage({kind:'client',msg:{type:'task_view_query',requestId:crypto.randomUUID()}});return true;
  })()`);
  const readViews = async () => await browser.evaluate(panel, 'globalThis.__compatViews??[]') as TaskView[];
  let lastState = '', lastLogAt = 0;
  const latest = async () => {
    const view = (await readViews()).findLast(item => item.goal === ASK);
    const state = `${phase}/${view?.state ?? 'none'}/${view?.goalStatus?.status ?? 'unverified'}`;
    if (state !== lastState || Date.now() - lastLogAt > 10_000) { lastState = state; lastLogAt = Date.now(); log('权威任务状态', { state, runId: view?.runId ?? null, resumable: view?.resumable ?? false }); }
    return view;
  };
  const panelContent = async () => String(await browser.evaluate(panel, 'document.querySelector("#messages")?.textContent??""'));
  await stage('打开原页面和旧版侧栏', async () => { await openOriginalPage(); panel = await browser.attach(await browser.openSidePanel()); await browser.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, panel); });
  await browser.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'demo-model', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-demo-no-secret' }, sideagent_self_use: { until: Date.now() + 600_000 } })}).then(()=>true)`);
  await until(() => browser.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, 'old sidebar ready');
  await installReadPort();
  await stage('在旧版接收普通只读任务', async () => { await browser.click(panel, '#input'); await browser.typeText(panel, ASK); await browser.pressEnter(panel); });
  oldView = await stage('留下无continuation元数据的真实可恢复旧记录', () => until(async () => {
    const view = await latest();
    return view?.runId && view.state === 'idle' && view.goalStatus?.status === 'open' && view.resumable && (await panelContent()).includes(PARTIAL) ? view : undefined;
  }, 60_000, 'legacy partial answer + open checker + resumable task view'));
  assert.equal(oldView.continuation, undefined, 'A produced a legacy task without continuation metadata');
  assert.ok(oldView.goalStatus?.remaining?.includes('乙'), 'the old checkpoint retains the unmet user outcome');
  oldPanel = await panelContent(); beforeViews = await readViews();
  await browser.screenshot(work, join(artifacts, 'a-source.png')); await browser.screenshot(panel, join(artifacts, 'a-partial-panel.png'));
  await sleep(750);
  const isolatedManifest = JSON.parse(await readFile(join(browser.dirs.extension, 'manifest.json'), 'utf8')) as { key?: unknown };
  assert.equal(typeof isolatedManifest.key, 'string', 'isolated extension has a stable generated key');
  const savedKey = isolatedManifest.key as string;
  await stage('仅关闭本次隔离浏览器', () => browser.close());
  phase = 'candidate'; panel = ''; work = '';
  await stage('在自有临时目录换入候选B并保留隔离扩展身份', async () => {
    const destination = resolve(browser.dirs.extension);
    assert.equal(destination, resolve(browser.root, 'extension'), 'only the owned temporary extension package can be replaced');
    assert.notEqual(destination, baseline); assert.notEqual(destination, candidate);
    await rm(destination, { recursive: true, force: true });
    await cp(candidate, destination, { recursive: true, dereference: true });
    const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
    manifest.key = savedKey; await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const installedHashes = await bundleHashes(destination);
    assert.deepEqual(installedHashes, candidateHashes, 'the actual replacement runtime bytes equal prepared B');
    replacement = { extensionId: browser.extensionId, originalKeySha256: createHash('sha256').update(savedKey).digest('hex'), installedHashes };
  });
  await stage('沿用相同隔离profile重启候选B', () => browser.restart());
  await stage('重开原URL和候选侧栏', async () => { await openOriginalPage(); panel = await browser.attach(await browser.openSidePanel()); await browser.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, panel); });
  await until(() => browser.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, 'candidate sidebar ready');
  assert.equal(await browser.evaluate(panel, 'chrome.runtime.id'), browser.extensionId, 'A and B use the same extension storage identity');
  assert.notEqual(await browser.evaluate(panel, 'chrome.storage.local.get("continuousDelegation").then(stored=>stored.continuousDelegation??null)'), true, 'ordinary legacy recovery does not require enabling continuous delegation');
  await installReadPort();
  restoredView = await stage('读回旧目标、runId与可恢复记录', () => until(async () => { const view = await latest(); return view?.runId === oldView!.runId && view.goal === ASK && view.resumable && view.continuation === undefined ? view : undefined; }, 30_000, 'legacy checkpoint restored by B'));
  restoredPanel = await panelContent();
  assert.ok(restoredPanel.includes(PARTIAL), 'the prior answer survives A to B replacement');
  assert.equal(restoredView.goal, oldView.goal, 'original accepted goal is unchanged');
  assert.deepEqual(restoredView.revisions, oldView.revisions, 'accepted user requirements retain their order');
  await sleep(750);
  const from = Date.now(), before = payloads.length;
  await stage('确认明确继续前不调用模型', () => sleep(4500));
  quietWindow = { from, to: Date.now(), before, after: payloads.length };
  assert.equal(quietWindow.after, quietWindow.before, 'upgrading a recoverable legacy record cannot automatically run a model');
  assert.ok(!(await panelContent()).includes(FINAL), 'no final result is invented before explicit continuation');
  await browser.screenshot(panel, join(artifacts, 'b-restored-before-resume.png'));
  await stage('用户在真实输入框明确说继续原任务', async () => {
    await until(() => browser.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 15_000, 'real composer ready for explicit continuation');
    await browser.click(panel, '#input'); await browser.typeText(panel, RESUME_CONTROL);
    resumeRequestedAt = Date.now(); await browser.pressEnter(panel);
  });
  finalView = await stage('同一旧任务读取原页并核对剩余项', () => until(async () => {
    const view = await latest();
    return view?.runId === oldView!.runId && view.state === 'idle' && view.goalStatus?.status === 'done' && (await panelContent()).includes(FINAL) ? view : undefined;
  }, 60_000, 'legacy run completed after explicit resume'));
  finalPanel = await panelContent(); afterViews = await readViews();
  assert.equal(finalView.goal, ASK, 'resume does not replace the original task goal');
  assert.equal(finalView.continuation, undefined, 'ordinary recovery does not create a continuous delegation');
  const continuationRequests = payloads.filter(payload => payload.at >= resumeRequestedAt! && payload.tools?.length && payload.messages?.some(message => message.role === 'user' && /\[(?:TASK|RESTART) CONTINUATION\]/.test(textOf(message.content))));
  assert.ok(continuationRequests.length > 0, 'the real user control causes a task/restart continuation request');
  const readIds = new Set(continuationRequests.flatMap(payload => payload.messages ?? []).flatMap(message => message.tool_calls ?? []).filter(call => {
    if (call.function.name !== 'read_element') return false;
    try { return JSON.parse(call.function.arguments).target === '#second'; } catch { return false; }
  }).map(call => call.id));
  const secondRead = continuationRequests.flatMap(payload => payload.messages ?? []).find(message => message.role === 'tool' && readIds.has(message.tool_call_id ?? '') && /乙/.test(textOf(message.content)) && /60/.test(textOf(message.content)));
  assert.ok(secondRead, 'actual read_element response proves the remaining score was reread from the source page');
  assert.equal(await browser.evaluate(work, 'location.href'), origin, 'resume reads the original bound page');
  assert.ok(afterViews.filter(view => view.goal === ASK).every(view => view.runId === oldView!.runId), 'no late event starts a different run for the original requirement');
  const users = await browser.evaluate(panel, `Array.from(document.querySelectorAll('#messages .msg.user')).map(node=>(node.querySelector('.user-msg-text')?.textContent??node.textContent??'').trim())`) as string[];
  assert.equal(users[0], ASK, 'the original user request remains visible');
  assert.equal(users.length, 2, 'there is exactly the original goal and the necessary explicit continuation message');
  assert.equal(users[1], RESUME_CONTROL, 'the second user bubble is solely the explicit resume control');
  await browser.screenshot(work, join(artifacts, 'b-completed-source.png')); await browser.screenshot(panel, join(artifacts, 'b-completed-panel.png'));
  log('旧记录兼容核验完成', { runId: finalView.runId, originalAnswerRetained: restoredPanel.includes(PARTIAL), originalGoal: finalView.goal, quietWindow });
} catch (caught) {
  error = redactCredentialText(caught instanceof Error ? caught.stack ?? caught.message : String(caught)); log('兼容验收失败', error.split('\n')[0]);
  if (rp && panel) { await rp.screenshot(panel, join(artifacts, 'failure-panel.png')).catch(() => {}); finalPanel = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent??""').catch(() => '')); }
  if (rp && work) await rp.screenshot(work, join(artifacts, 'failure-page.png')).catch(() => {});
} finally {
  if (rp && panel) { const current = await rp.evaluate(panel, 'globalThis.__compatViews??[]').catch(() => []) as TaskView[]; if (phase === 'candidate') afterViews = current; else beforeViews = current; await rp.evaluate(panel, 'globalThis.__compatPort?.disconnect();true').catch(() => {}); }
  await writeFile(join(artifacts, 'payloads.jsonl'), payloads.map(payload => JSON.stringify(payload)).join('\n'));
  await writeFile(join(artifacts, 'a-task-views.json'), JSON.stringify(beforeViews, null, 2)); await writeFile(join(artifacts, 'b-task-views.json'), JSON.stringify(afterViews, null, 2));
  await writeFile(join(artifacts, 'stages.jsonl'), phases.map(entry => JSON.stringify(entry)).join('\n'));
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', dependency: 'real isolated extension A -> B with same Chrome profile and extensionId; real task checkpoint and explicit continuation through composer; scripted local model/checker and page', baseline, candidate, baselineHashes, candidateHashes, replacement, oldView, restoredView, finalView, quietWindow, resumeRequestedAt, necessaryUserControl: RESUME_CONTROL, autonomousCompletionMetric: 'not applicable: legacy recovery explicitly requires this user control', oldPanel, restoredPanel, finalPanel, requests: model.requests, downgrade: { status: 'NOT_RUN', reason: 'This script only verifies legacy A -> B recovery. B -> A rollback requires a separate real run.' }, error }, null, 2));
  await rp?.close(); await rp?.remove(); await model.close(); site.closeAllConnections(); await new Promise<void>(done => site.close(() => done()));
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', artifacts, oldRunId: oldView?.runId ?? null, restoredRunId: restoredView?.runId ?? null, finalRunId: finalView?.runId ?? null, downgrade: 'NOT_RUN', error: error?.split('\n')[0] ?? null }, null, 2));
if (error) process.exitCode = 1;
