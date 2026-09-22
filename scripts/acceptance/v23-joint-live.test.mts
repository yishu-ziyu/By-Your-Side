// 联合探针离线检查（先于真实两场景执行；node:test，与 realtime-spoken-result-live.test.mts 同法）。
// 覆盖：预算常量、场景集合与身份文案、import 不执行 main、jointChecks 的收尾/身份/核验/独立读取/胶囊次数判分。
// 收尾、音频完整性、异常退出的既有判分沿用 realtime-spoken-result-live 的 summarize/isSettled（另文件 8 例）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CAPS, JOINT_SCENARIOS, jointChecks, type Receipt, type ReadState} from './v23-joint-live.mts';
import {isSettled, newTrace, summarize} from './realtime-spoken-result-live.mts';

test('预算固定且与票面一致；只含 S1/S2；import 不执行 main', () => {
  assert.deepEqual(CAPS, {jev: 2, responses: 15, readyMs: 20_000, scenarioMs: 100_000, totalMs: 360_000});
  assert.deepEqual(JOINT_SCENARIOS.map(s => s.id), ['S1', 'S2']);
  assert.equal(JOINT_SCENARIOS[0].text, '切到测试标签页。');
  assert.equal(JOINT_SCENARIOS[1].text, '切到测试标签页，顺便告诉我一加一等于几。');
});

/** 与既有离线检查同构的轨迹样本：list+switch 两轮，切换输出带真实链形状的 hostFeedback。 */
function sample(id: 'S1' | 'S2') {
  const t = newTrace();
  t.judgments.push({type: 'judgment', at: 1, completedAt: 2, voiceId: id, judgment: {lane: 'task', pageChange: 0.9, spokenResult: id === 'S1' ? 0.1 : 0.9}} as never);
  for (const [n, action] of ['list', 'switch'].entries()) {
    const rid = `r${n}`, callId = `c${n}`, at = 10 + n * 10;
    t.outgoing.push({type: 'response.create', at});
    t.provider.push({type: 'response.created', response: {id: rid}, at: at + 1}, {type: 'response.done', response: {id: rid, output: [{type: 'function_call'}]}, at: at + 2});
    t.client.push({type: 'response_done', responseId: rid, at: at + 2});
    t.tools.push({type: 'tool', name: 'tabs', callId, args: {action, tabId: 8}, at: at + 1});
    t.outgoing.push({type: 'conversation.item.create', item: {type: 'function_call_output', call_id: callId, output: JSON.stringify(action === 'switch' ? {hostFeedback: {text: '切好了'}} : {})}, at: at + 3});
  }
  t.logs.push({type: 'spoken_result_gate', at: 24, callIds: ['c1'], applied: id === 'S1', reason: id === 'S1' ? 'capsule_only' : 'spoken_result_needed'});
  return t;
}
function answer(t: ReturnType<typeof sample>, text = '一加一等于二') {
  t.outgoing.push({type: 'response.create', at: 30});
  t.provider.push({type: 'response.created', response: {id: 'answer'}, at: 31},
    {type: 'response.audio.delta', response_id: 'answer', delta: 'AAAA', at: 32},
    {type: 'response.done', response: {id: 'answer'}, at: 34});
  t.client.push({type: 'audio', responseId: 'answer', data: 'AAAA', at: 32},
    {type: 'transcript', role: 'assistant', responseId: 'answer', text, final: true, at: 33},
    {type: 'response_done', responseId: 'answer', at: 34});
}
const receipt: Receipt = {tabId: 8, verification: {verified: true, activeTabId: 8, windowId: 1, windowFocused: true, workingTabId: 8}};
const pre: ReadState = {tabId: 7, windowId: 1, focused: true, aActive: true, bActive: false};
const post: ReadState = {tabId: 8, windowId: 1, focused: true, aActive: false, bActive: true};
const base = (id: 'S1' | 'S2', summary: ReturnType<typeof summarize>) => ({
  id, summary, receipt, pre, post, vis: {a: 'hidden', b: 'visible'}, successCapsules: 1, tabA: 7, tabB: 8,
});

test('S1 真实链形状全通过：轨迹收尾 + 回执核验 + 独立读取 + 胶囊一次 + 身份匹配', () => {
  assert.deepEqual(jointChecks(base('S1', summarize('S1', sample('S1'), 'quiescent'))), []);
});

test('S2 含已交付答案音频时全通过', () => {
  const t = sample('S2');
  answer(t);
  assert.ok(isSettled(t));
  assert.deepEqual(jointChecks(base('S2', summarize('S2', t, 'quiescent'))), []);
});

test('回显一致但无核验事实的回执不能通过（真实回执才可）', () => {
  const reasons = jointChecks({...base('S1', summarize('S1', sample('S1'), 'quiescent')), receipt: {tabId: 8}});
  assert.ok(reasons.includes('receipt_not_verified'));
  const lying = jointChecks({...base('S1', summarize('S1', sample('S1'), 'quiescent')),
    receipt: {tabId: 8, verification: {verified: false, activeTabId: 7, windowId: 1, windowFocused: true, workingTabId: 8}}});
  assert.ok(lying.includes('receipt_not_verified'));
});

test('独立读取不符、窗口未聚焦、可见性不符均不通过', () => {
  const summary = summarize('S1', sample('S1'), 'quiescent');
  assert.ok(jointChecks({...base('S1', summary), post: {...post, tabId: 7, aActive: true, bActive: false}}).includes('independent_read_mismatch'));
  assert.ok(jointChecks({...base('S1', summary), post: {...post, focused: false}}).includes('independent_read_mismatch'));
  assert.ok(jointChecks({...base('S1', summary), pre: {...pre, focused: false}}).includes('start_state_invalid'));
  assert.ok(jointChecks({...base('S1', summary), pre: {...pre, tabId: 8}}).includes('start_state_invalid'));
  assert.ok(jointChecks({...base('S1', summary), vis: {a: 'visible', b: 'hidden'}}).includes('visibility_mismatch'));
});

test('超时/断连等收尾失败与胶囊次数、身份串用都不通过', () => {
  const t = sample('S1');
  assert.ok(jointChecks({...base('S1', summarize('S1', t, 'timeout')), successCapsules: 1}).some(r => r.includes('scenario_S1_timeout')));
  const summary = summarize('S1', sample('S1'), 'quiescent');
  assert.ok(jointChecks({...base('S1', summary), successCapsules: 0}).includes('success_capsule_event_count'));
  assert.ok(jointChecks({...base('S1', summary), successCapsules: 2}).includes('success_capsule_event_count'));
  assert.ok(jointChecks({...base('S1', summary), summary: {...summary, request: {voiceId: 'S2'}}}).includes('judgment_identity_mismatch'));
  assert.ok(jointChecks({...base('S2', summary), successCapsules: 0}).includes('success_capsule_event_missing'));
});
