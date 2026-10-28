import { createHash, randomUUID } from 'node:crypto';
import { isWaitCondition, type TaskContinuation, type WaitCondition } from '../../shared/task-continuation.js';
import type { TaskProgressSnapshot } from '../../shared/voice.js';
import type { ToolRpc } from './rpc.js';

export interface ConditionRegistration { condition: WaitCondition; mode: 'once' | 'watch'; durationMs: number }
type Observation = { version: string; value: string | boolean; documentId: string; url: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = (c: TaskContinuation) => ['COMPLETED', 'STOPPED', 'FAILED'].includes(c.state);

/** Owns passive observation only. All model execution is admitted by the host dispatcher. */
export class TaskContinuationObserver {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private busy = false;
  private disposed = false;
  constructor(private readonly host: {
    rpc: Pick<ToolRpc, 'call' | 'getPageTarget'>;
    enabled: () => boolean;
    snapshot: () => TaskProgressSnapshot;
    update: (value: TaskContinuation) => void;
    save: () => Promise<void>;
    changed: () => void;
    idle: () => boolean;
    modelCalls?: () => number;
    wake: (value: TaskContinuation) => Promise<boolean>;
    stopExecution?: () => void;
    now?: () => number;
  }) {}
  private now() { return this.host.now?.() ?? Date.now(); }
  private current(c: TaskContinuation, generation: number) {
    const live = this.host.snapshot().continuation;
    return !this.disposed && generation === this.generation && live?.id === c.id && live.goalVersion === c.goalVersion && live.controlVersion === c.controlVersion;
  }
  private async commit(c: TaskContinuation) {
    const prior = this.host.snapshot().continuation;
    const generation = this.generation;
    this.host.update(c);
    try { await this.host.save(); }
    catch (error) {
      const live = this.host.snapshot().continuation;
      if (generation !== this.generation || live?.id !== c.id || live.goalVersion !== c.goalVersion || live.controlVersion !== c.controlVersion) throw error;
      this.invalidate();
      this.host.update({ ...(c.state === 'STOPPED' ? c : prior ?? c), state: c.state === 'STOPPED' ? 'STOPPED' : 'SUSPENDED', segmentStartedAt: null, lastError: '委托状态未能保存，已停止自动续做；请核对已有结果。' });
      this.host.changed();
      throw error;
    }
    this.host.changed();
  }
  invalidate() { this.generation++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  async register(input: ConditionRegistration): Promise<TaskContinuation> {
    if (!this.host.enabled()) throw new Error('持续委托尚未开启。');
    if (!isWaitCondition(input.condition) || !['once', 'watch'].includes(input.mode) || !Number.isSafeInteger(input.durationMs) || input.durationMs < 1000 || input.durationMs > 3_600_000) throw new Error('请登记可复核的页面条件和一小时以内的明确期限。');
    const snapshot = this.host.snapshot();
    if (!snapshot.runId || snapshot.state !== 'running' || snapshot.active.length > 1) throw new Error('当前任务不能登记等待条件。');
    const tabId = this.host.rpc.getPageTarget();
    if (!tabId || !snapshot.goalPage?.url) throw new Error('等待需要绑定原任务页面。');
    const prior = snapshot.continuation;
    if (prior && (terminal(prior) || prior.state !== 'RUNNING')) throw new Error('原委托已失效，未登记新等待。');
    this.invalidate();
    const generation = this.generation;
    const now = this.now();
    const c: TaskContinuation = prior ? { ...prior, condition: structuredClone(input.condition), state: 'WAITING_CONDITION', segmentStartedAt: null,
      activeMs: prior.activeMs + (prior.segmentStartedAt === null ? 0 : now - prior.segmentStartedAt) } : {
      schema: 1, id: randomUUID(), goalVersion: 1, controlVersion: 0, state: 'WAITING_CONDITION', mode: input.mode,
      tabId, url: snapshot.goalPage.url, documentId: '', condition: structuredClone(input.condition), createdAt: now, expiresAt: now + input.durationMs,
      observations: 0, maxObservations: 720, activeMs: Math.max(0, now - (snapshot.startedAt ?? now)), maxActiveMs: 180_000,
      modelCalls: this.host.modelCalls?.() ?? 0, maxModelCalls: 60, pollMs: 2000, baseline: null,
      observedVersion: null, processingVersion: null, processedVersion: null, pendingVersion: null, requestId: null, segmentStartedAt: null,
    };
    const observation = await this.read(c);
    if (generation !== this.generation || this.disposed || this.host.snapshot().runId !== snapshot.runId || this.host.snapshot().state !== 'running') throw new Error('任务已变化，等待条件未接收。');
    c.documentId = observation.documentId;
    c.baseline = observation.version;
    c.observedVersion = observation.version;
    c.observations++;
    await this.commit(c);
    if (this.current(c, generation)) this.schedule(0);
    return c;
  }
  private async read(c: TaskContinuation): Promise<Observation> {
    const tabs = await this.host.rpc.call('list_tabs', {});
    const list: unknown[] = Array.isArray(tabs) ? tabs : tabs && typeof tabs === 'object' && Array.isArray((tabs as { tabs?: unknown }).tabs) ? (tabs as { tabs: unknown[] }).tabs : [];
    const tab = list.find(t => !!t && typeof t === 'object' && (t as { id?: unknown }).id === c.tabId) as { url?: unknown } | undefined;
    if (tab?.url !== c.url) throw new Error('原页面已关闭或切换到其他资源，关注已暂停。');
    const property = c.condition.property === 'text' ? 'visibleText' : c.condition.property;
    let result: unknown;
    let value: string | boolean;
    if (property === 'exists') {
      result = await this.host.rpc.call('read_elements', { tabId: c.tabId, selector: c.condition.target, limit: 2 });
      if (!result || typeof result !== 'object' || !('total' in result) || typeof result.total !== 'number' || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('未能核实目标元素是否出现。');
      value = result.total > 0;
    } else {
      result = await this.host.rpc.call('read_element', { tabId: c.tabId, target: c.condition.target, properties: [property] });
      if (c.condition.operator === 'changed' && result && typeof result === 'object' && 'tagName' in result && ['body','html'].includes(String(result.tagName).toLowerCase())) throw new Error('整页变化不能证明目标条件，请指定明确的结果列表或状态字段。');
      const actual = result && typeof result === 'object' ? (result as { properties?: Record<string, unknown> }).properties?.[property] : undefined;
      if (typeof actual !== 'string' && typeof actual !== 'boolean') throw new Error('页面未提供可复核的观察字段。');
      if (typeof actual === 'string' && actual.length > 100_000) throw new Error('观察结果过长，请缩小目标范围。');
      value = actual;
    }
    const data = result as { documentId?: unknown; url?: unknown; tabId?: unknown };
    if (typeof data.documentId !== 'string' || !data.documentId || data.tabId !== c.tabId || data.url !== undefined && data.url !== c.url || c.documentId && data.documentId !== c.documentId) throw new Error('页面文档已变化，关注已暂停，请重新核实原页面。');
    const after = await this.host.rpc.call('list_tabs', {});
    const afterList = Array.isArray(after) ? after : (after as { tabs?: unknown[] } | null)?.tabs;
    if (!afterList?.some(t => !!t && typeof t === 'object' && (t as { id?: unknown }).id === c.tabId && (t as { url?: unknown }).url === c.url)) throw new Error('观察期间页面已变化，未继续执行。');
    return { value, version: hash([data.documentId, value]), documentId: data.documentId, url: c.url };
  }
  private matches(c: TaskContinuation, o: Observation) {
    const condition = c.condition;
    if (condition.operator === 'changed') return o.version !== (c.processedVersion ?? c.baseline);
    return condition.operator === 'contains' ? typeof o.value === 'string' && typeof condition.expected === 'string' && o.value.includes(condition.expected) : o.value === condition.expected;
  }
  private schedule(delay?: number) {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll().catch(error => console.error('[continuation] observation stopped:', error instanceof Error ? error.message : String(error))); }, delay ?? this.host.snapshot().continuation?.pollMs ?? 2000);
  }
  async restore() {
    const c = this.host.snapshot().continuation;
    if (!c || terminal(c)) return;
    if (!this.host.enabled()) { await this.control('stop', '功能已关闭'); return; }
    if (c.state !== 'WAITING_CONDITION') { await this.commit({ ...c, state: 'SUSPENDED', segmentStartedAt: null, lastError: '执行片段已中断，请先核对已有结果再继续。' }); this.schedule(); return; }
    this.schedule(0);
  }
  async poll() {
    if (this.busy || this.disposed) return;
    const c = this.host.snapshot().continuation;
    if (!c || terminal(c)) return;
    if (!this.host.enabled()) { await this.control('stop', '功能已关闭'); return; }
    if (this.now() >= c.expiresAt) { await this.control('stop', 'deadline'); return; }
    if (c.activeMs + (c.segmentStartedAt === null ? 0 : this.now() - c.segmentStartedAt) >= c.maxActiveMs || c.modelCalls >= c.maxModelCalls || c.observations >= c.maxObservations) { await this.control('stop', 'budget'); return; }
    if (c.state !== 'WAITING_CONDITION') { this.schedule(); return; }
    if (!this.host.idle()) { this.schedule(); return; }
    this.busy = true;
    const generation = this.generation;
    try {
      const observation = await this.read(c);
      if (!this.current(c, generation)) return;
      const next = { ...c, observations: c.observations + 1, observedVersion: observation.version };
      const ready = this.matches(c, observation) && observation.version !== c.processedVersion;
      if (ready) {
        next.pendingVersion = observation.version;
        next.requestId = `wake-${c.id}-${c.goalVersion}-${observation.version}`;
      }
      await this.commit(next);
      if (!this.current(c, generation)) return;
      if (ready) await this.host.wake(next);
    } catch (error) {
      if (this.current(c, generation)) await this.commit({ ...this.host.snapshot().continuation!, state: 'SUSPENDED', segmentStartedAt: null, lastError: error instanceof Error ? error.message.slice(0, 500) : '观察失败，已暂停。' });
    } finally { this.busy = false; this.schedule(); }
  }
  async control(action: 'pause' | 'stop' | 'revise', reason: string) {
    this.invalidate();
    const c = this.host.snapshot().continuation;
    if (!c || terminal(c)) return;
    if (action !== 'revise') this.host.stopExecution?.();
    await this.commit({ ...c, state: action === 'stop' ? 'STOPPED' : action === 'pause' ? 'WAITING_USER' : 'SUSPENDED',
      controlVersion: c.controlVersion + 1, goalVersion: c.goalVersion + (action === 'revise' ? 1 : 0),
      activeMs: c.activeMs + (c.segmentStartedAt === null ? 0 : this.now() - c.segmentStartedAt), segmentStartedAt: null,
      pendingVersion: null, requestId: null, ...(action === 'stop' ? { stopReason: reason } : { lastError: reason }) });
    if (action !== 'stop') this.schedule();
  }
  async settled(status: 'done' | 'needs_user' | 'open' | 'blocked' | 'unavailable') {
    const c = this.host.snapshot().continuation;
    if (!c || terminal(c) || !['RUNNING', 'VERIFYING'].includes(c.state)) return;
    const now = this.now();
    await this.commit({ ...c, activeMs: c.activeMs + (c.segmentStartedAt === null ? 0 : now - c.segmentStartedAt), segmentStartedAt: null,
      state: status === 'done' ? c.mode === 'watch' ? 'WAITING_CONDITION' : 'COMPLETED' : status === 'needs_user' ? 'WAITING_USER' : 'SUSPENDED',
      processedVersion: status === 'done' ? c.processingVersion : c.processedVersion, processingVersion: null, pendingVersion: null, requestId: null,
      ...(status !== 'done' ? { lastError: '本次处理尚未核对完成，保留未处理位置。' } : {}) });
    this.schedule();
  }
  dispose() { this.disposed = true; this.invalidate(); }
}
