import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, until, sleep } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();
const out = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-steer-restores-superseded-answer`);
await mkdir(out, { recursive: true });

const Q1 = '帮我查一下两件事：第一件先核实最新公告，第二件帮我找一下 X。';
const Q2 = '你可以把我的页面切换到那个具体的 X 页面。';
const FIRST_ANSWER = 'X 我还没对上，你是指社交平台还是别的？第一件公告已查清：已经正式恢复职务。';
const SECOND_ANSWER = 'X 具体指哪一页还没对上，请告诉我网址，我马上切过去。';
const FINDING = '无关旧标签页里的概念还没找完';

const site = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
    .end('<!doctype html><meta charset="utf-8"><title>旧搜索页</title><p>这是一页旧的搜索记录。</p>');
});
await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const model = await startScriptedModel([
  { match: `"lastReply":"${SECOND_ANSWER}`, steps: [{ text: JSON.stringify({ status: 'needs_user', items: [{ text: '切换页面', done: false }], remaining: '等用户给网址' }) }] },
  { match: '"lastReply"', steps: [{ text: JSON.stringify({ status: 'continue', goalOnPage: false, repair: 'complete_task', verificationSubject: 'answer', evidence: FIRST_ANSWER, items: [{ text: '找旧概念', done: false }], remaining: '继续搜索', correction: '继续搜索旧概念', finding: FINDING }) }] },
  { match: Q2, steps: [{ text: SECOND_ANSWER }] },
  { match: '[GOAL CHECK]', steps: [{ text: '正在重做上一轮。', delayMs: 4000 }] },
  { match: Q1, steps: [{ tool: { name: 'tabs', args: { action: 'open', url: `${origin}/news` } } }, { text: FIRST_ANSWER }] },
]);

const rp = await launchRealPath();
let panel = '';
let failure: unknown;
const evidence: Record<string, unknown> = {};

const INSPECT_JS = `(() => {
  const nodes = [...document.querySelectorAll('#messages > *')];
  const assistants = nodes
    .filter(n => n.matches('.msg.assistant[data-delivery-id]:not(.opening-line)') && n.dataset.deliveryKind !== 'ack')
    .map(n => ({ index: nodes.indexOf(n), text: n.textContent?.trim() ?? '' }));
  const users = nodes
    .filter(n => n.matches('.msg.user'))
    .map(n => ({ index: nodes.indexOf(n), text: n.textContent?.trim() ?? '' }));
  const superseded = [...document.querySelectorAll('#messages .run-superseded')].map(n => n.textContent?.trim() ?? '');
  const metas = [...document.querySelectorAll('#messages .run-meta')].filter(n => !n.hidden).map(n => n.textContent?.trim() ?? '');
  return { assistants, users, superseded, metas };
})()`;

try {
  const target = await rp.cdp.send('Target.createTarget', { url: `${origin}/` });
  await rp.cdp.send('Target.activateTarget', { targetId: target.targetId });
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: 'custom', modelId: 'fixture', baseUrl: model.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-fixture' } })}).then(()=>true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector('#conversation-new')?.disabled===false && document.querySelector('#send-btn')?.disabled===false && document.querySelector('#think-chip')?.textContent?.includes('fixture')`), 60_000, 'panel ready');

  await rp.click(panel, '#input');
  await rp.typeText(panel, Q1);
  await rp.pressEnter(panel);

  await until(async () => await rp.evaluate(panel, `!!document.querySelector('#messages .run-superseded') && document.querySelector('#send-btn')?.classList.contains('stopping')`), 30_000, 'goal_check redo started');
  await rp.screenshot(panel, join(out, 'during-redo.png'));

  await rp.click(panel, '#input');
  await rp.typeText(panel, Q2);
  await rp.click(panel, '#steer-send-btn');

  await until(async () => await rp.evaluate(panel, `document.querySelector('#messages')?.innerText?.includes(${JSON.stringify(SECOND_ANSWER)}) && !document.querySelector('#send-btn')?.classList.contains('stopping')`), 30_000, 'second answer settled');
  await sleep(500);
  await rp.screenshot(panel, join(out, 'after-steer.png'));

  const live = await rp.evaluate(panel, INSPECT_JS) as { assistants: Array<{ index: number; text: string }>; users: Array<{ index: number; text: string }>; superseded: string[]; metas: string[] };
  evidence.live = live;

  const verifyView = (view: typeof live, phase: string) => {
    const first = view.assistants.find(a => a.text.includes('已经正式恢复职务'));
    const second = view.assistants.find(a => a.text.includes('请告诉我网址'));
    const q2 = view.users.find(u => u.text.includes('具体的 X 页面'));
    assert.ok(first, `${phase}: 追问打断核对重做后，第一轮已经展示过的回答必须恢复留在对话里: ${JSON.stringify(view)}`);
    assert.ok(second, `${phase}: 第二轮回答必须显示: ${JSON.stringify(view)}`);
    assert.ok(q2 && first.index < q2.index && q2.index < second.index, `${phase}: 第一轮回答必须在追问之前、第二轮回答在追问之后: ${JSON.stringify(view)}`);
    assert.equal(view.superseded.length, 0, `${phase}: 已恢复的回答不应继续留在折叠的 run-superseded 里: ${JSON.stringify(view)}`);
    assert.ok(!view.metas.some(m => m.includes(FINDING)), `${phase}: 过期的核对发现不应残留在追问后的状态行里: ${JSON.stringify(view)}`);
  };

  verifyView(live, 'live');

  await rp.cdp.send('Page.reload', {}, panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector('#messages')?.innerText?.includes(${JSON.stringify(SECOND_ANSWER)})`), 20_000, 'history replayed');
  await sleep(300);
  await rp.screenshot(panel, join(out, 'after-reload.png'));

  const replay = await rp.evaluate(panel, INSPECT_JS) as typeof live;
  evidence.replay = replay;
  verifyView(replay, 'replay');
} catch (error) {
  failure = error;
  if (panel) await rp.screenshot(panel, join(out, 'failure.png')).catch(() => {});
} finally {
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

await writeFile(join(out, 'result.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', evidence, error: failure ? String(failure) : null }, null, 2));
console.log(JSON.stringify({ status: failure ? 'FAIL' : 'PASS', out, evidence, error: failure ? String(failure) : null }));
if (failure) process.exitCode = 1;
