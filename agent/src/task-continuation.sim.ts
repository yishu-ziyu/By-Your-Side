import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskContinuationObserver } from './task-continuation.js';
import type { TaskContinuation, WaitCondition } from '../../shared/task-continuation.js';
import type { TaskProgressSnapshot } from '../../shared/voice.js';
import { decideTaskNextStep } from '../../shared/task-next-step.js';

const condition: WaitCondition = { target: '#status', property: 'text', operator: 'equals', expected: '完成', goalItem: 'results', description: '等待结果生成完成' };

function simulation() {
  let time = 1000, value = '生成中', documentId = 'document-1', url = 'https://example.com/results', enabled = true;
  let failSave = false, failRead = false, wakes = 0, saves = 0;
  let readGate: Promise<void> | undefined;
  const snapshot: TaskProgressSnapshot = { conversationId: 'sim', observedAt: time, state: 'running', goal: '筛选标注', runId: 'run', startedAt: time, active: [], lastAction: null, successVerified: false, results: [], goalPage: { url, title: '结果' } };
  const requests: string[] = [];
  const observer = new TaskContinuationObserver({
    rpc: { getPageTarget: () => 1, call: async name => {
      if (name === 'list_tabs') return { tabs: [{ id: 1, url }] };
      if (readGate) await readGate;
      if (failRead) throw new Error('读取失败');
      return { tabId: 1, documentId, url, properties: { visibleText: value } };
    } },
    snapshot: () => ({ ...snapshot, observedAt: time }), update: c => { snapshot.continuation = c; },
    enabled: () => enabled, now: () => time, idle: () => true, changed: () => {},
    save: async () => { saves++; if (failSave) throw new Error('保存失败'); },
    wake: async c => { wakes++; requests.push(c.requestId!); snapshot.continuation = { ...c, state: 'RUNNING', processingVersion: c.pendingVersion, pendingVersion: null, segmentStartedAt: time }; return true; },
  });
  return { observer, snapshot, requests, register: (mode: 'once' | 'watch' = 'once', next = condition, durationMs = 60_000) => observer.register({ condition: next, mode, durationMs }),
    value: (next: string) => { value = next; }, time: (next: number) => { time = next; }, document: (next: string) => { documentId = next; }, url: (next: string) => { url = next; },
    enable: (next: boolean) => { enabled = next; }, failSave: () => { failSave = true; }, failRead: () => { failRead = true; }, gate: (next: Promise<void>) => { readGate = next; },
    counts: () => ({ wakes, saves }), continuation: () => snapshot.continuation! };
}

test('模拟：外部等待不耗主动预算，重复信号只推进一次，核对前不推进已处理位置', async () => {
  const s = simulation();
  try {
    await s.register(); s.snapshot.state = 'idle';
    s.time(40_000); await s.observer.poll();
    assert.equal(s.counts().wakes, 0); assert.equal(s.continuation().activeMs, 0);
    s.value('完成'); await s.observer.poll(); await s.observer.poll();
    assert.equal(s.counts().wakes, 1); assert.equal(s.continuation().processedVersion, null);
    const processing = s.continuation().processingVersion;
    s.time(41_000); await s.observer.settled('done');
    assert.equal(s.continuation().state, 'COMPLETED'); assert.equal(s.continuation().processedVersion, processing); assert.equal(s.continuation().activeMs, 1000);
  } finally { s.observer.dispose(); }
});

test('模拟：条件先于登记已满足仍会自动续做', async () => {
  const s = simulation();
  try { s.value('完成'); await s.register(); await s.observer.poll(); assert.equal(s.counts().wakes, 1); }
  finally { s.observer.dispose(); }
});

for (const action of ['pause', 'stop', 'revise'] as const) test(`模拟：${action} 与读回竞争，迟到结果不能唤醒`, async () => {
  const s = simulation();
  try {
    await s.register(); s.value('完成');
    let release!: () => void;
    s.gate(new Promise<void>(resolve => { release = resolve; }));
    const polling = s.observer.poll();
    await Promise.resolve(); await s.observer.control(action, '用户控制'); release(); await polling;
    assert.equal(s.counts().wakes, 0); assert.equal(s.continuation().controlVersion, 1);
    assert.equal(s.continuation().goalVersion, action === 'revise' ? 2 : 1);
    if (action === 'stop') assert.equal(decideTaskNextStep(s.snapshot).action, 'stop');
  } finally { s.observer.dispose(); }
});

for (const fault of ['read', 'document', 'resource', 'save'] as const) test(`模拟：${fault} 失败不续做、不推进处理位置`, async () => {
  const s = simulation();
  try {
    await s.register(); s.value('完成');
    if (fault === 'read') s.failRead();
    if (fault === 'document') s.document('replacement');
    if (fault === 'resource') s.url('https://example.com/another');
    if (fault === 'save') s.failSave();
    await s.observer.poll().catch(() => {});
    assert.equal(s.counts().wakes, 0); assert.equal(s.continuation().processedVersion, null); assert.equal(s.continuation().state, 'SUSPENDED');
  } finally { s.observer.dispose(); }
});

test('模拟：连续关注只在成功核对后提交版本，失败批次保持可核实', async () => {
  const s = simulation();
  try {
    await s.register('watch', { ...condition, operator: 'changed', expected: undefined });
    s.value('第一批'); await s.observer.poll(); await s.observer.settled('done');
    const first = s.continuation().processedVersion;
    await s.observer.poll(); assert.equal(s.counts().wakes, 1);
    s.value('第二批'); await s.observer.poll(); await s.observer.settled('open');
    assert.equal(s.counts().wakes, 2); assert.equal(s.continuation().processedVersion, first); assert.equal(s.continuation().state, 'SUSPENDED');
  } finally { s.observer.dispose(); }
});

for (const stop of ['deadline', 'budget', 'disabled'] as const) test(`模拟：${stop} 是停止原因，不能成为目标完成`, async () => {
  const s = simulation();
  try {
    await s.register();
    if (stop === 'deadline') s.time(62_000);
    if (stop === 'budget') s.snapshot.continuation = { ...s.continuation(), observations: s.continuation().maxObservations };
    if (stop === 'disabled') s.enable(false);
    await s.observer.poll();
    assert.equal(s.continuation().state, 'STOPPED'); assert.equal(s.counts().wakes, 0); assert.equal(decideTaskNextStep(s.snapshot).action, 'stop');
  } finally { s.observer.dispose(); }
});

test('模拟：后台恢复仅观察原文档，在途片段恢复为暂停核实', async () => {
  const s = simulation();
  try {
    await s.register(); s.value('完成'); await s.observer.poll();
    await s.observer.restore(); assert.equal(s.continuation().state, 'SUSPENDED'); assert.equal(s.counts().wakes, 1);
  } finally { s.observer.dispose(); }
});

test('模拟：处理完成但进度保存失败，不能提前推进已处理位置', async () => {
  const s = simulation();
  try {
    await s.register(); s.value('完成'); await s.observer.poll();
    s.failSave(); await assert.rejects(s.observer.settled('done'), /保存失败/);
    assert.equal(s.continuation().state, 'SUSPENDED'); assert.equal(s.continuation().processedVersion, null); assert.ok(s.continuation().processingVersion);
  } finally { s.observer.dispose(); }
});

test('模拟：暂停仍消耗总期限，到期不能被用户以外的事件恢复', async () => {
  const s = simulation();
  try {
    await s.register(); await s.observer.control('pause', '用户暂停'); s.time(62_000); s.value('完成'); await s.observer.poll();
    assert.equal(s.continuation().state, 'STOPPED'); assert.equal(s.continuation().stopReason, 'deadline'); assert.equal(s.counts().wakes, 0);
  } finally { s.observer.dispose(); }
});

test('模拟：一小时关注按期限结束，不因观察次数提前停下', async () => {
  const s = simulation();
  try {
    await s.register('watch', condition, 3_600_000); s.snapshot.state = 'idle';
    const { createdAt, expiresAt, pollMs } = s.continuation();
    for (let at = createdAt + pollMs; at < expiresAt; at += pollMs) { s.time(at); await s.observer.poll(); }
    assert.equal(s.continuation().state, 'WAITING_CONDITION');
    s.time(expiresAt); await s.observer.poll();
    assert.equal(s.continuation().state, 'STOPPED'); assert.equal(s.continuation().stopReason, 'deadline');
  } finally { s.observer.dispose(); }
});

test('模拟：暂停后继续关注回到等待，条件满足前不唤醒；重载后重绑同一资源，换资源拒绝', async () => {
  const s = simulation();
  try {
    await s.register(); s.snapshot.state = 'idle';
    await s.observer.control('pause', '用户暂停');
    const paused = s.continuation().controlVersion;
    await s.observer.resume();
    assert.equal(s.continuation().state, 'WAITING_CONDITION'); assert.ok(s.continuation().controlVersion > paused);
    await s.observer.poll(); assert.equal(s.counts().wakes, 0);
    s.document('document-2'); await s.observer.poll();
    assert.equal(s.continuation().state, 'SUSPENDED');
    await s.observer.resume();
    assert.equal(s.continuation().state, 'WAITING_CONDITION'); assert.equal(s.continuation().documentId, 'document-2'); assert.equal(s.continuation().lastError, undefined);
    s.value('完成'); await s.observer.poll(); assert.equal(s.counts().wakes, 1);
    await s.observer.control('pause', '用户暂停'); s.url('https://example.com/other');
    await assert.rejects(s.observer.resume(), /未能继续关注/);
    assert.equal(s.continuation().state, 'WAITING_USER');
  } finally { s.observer.dispose(); }
});
