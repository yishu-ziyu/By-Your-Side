import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isTaskActionRequest, isTaskReceipt, type TaskActionRequest, type TaskReceipt } from '../../shared/task-actions.js';
import type { PageContext } from '../../shared/protocol.js';

export interface QueuedTask {
  request: TaskActionRequest;
  title: string;
  state: 'queued' | 'suspended' | 'starting' | 'running' | 'completed' | 'cancelled' | 'failed' | 'unknown';
  receipt: TaskReceipt;
}

const MERGED = '已并回上一件';

/** 另开那件已经并回上一件：之后它停下的结局、重复的并回都不再改写它。 */
export const isMerged = (job: QueuedTask): boolean => job.receipt.message === MERGED;

/** 另开那件做到一半时扩展后台重启：它停在检查点，能安全接着做时由自动续做接上（见 resumeSeparate）。 */
const STOPPED = '扩展后台重启，这件事停下了，还没做完。';

/** 没有本机目录的宿主（扩展）用它存队列：启动前已读进内存，写入在后台。 */
export interface TaskQueuePersistence {
  load(): readonly unknown[];
  save(jobs: QueuedTask[]): void;
}

const QUEUE_STATES: ReadonlyArray<QueuedTask['state']> = ['queued', 'suspended', 'starting', 'running', 'completed', 'cancelled', 'failed', 'unknown'];

function isQueuedTask(value: unknown): value is QueuedTask {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<QueuedTask>;

  // 请求校验遇到个别畸形字段（如 forkedFrom: null）会抛错，坏记录一律当不合格。
  try { return isTaskActionRequest(job.request) && isTaskReceipt(job.receipt) && typeof job.title === 'string' && QUEUE_STATES.includes(job.state as QueuedTask['state']); }
  catch { return false; }
}

/** Durable admission for independent requirements. Execution still belongs to TaskDispatcher. */
export class TaskQueue {
  private readonly jobs = new Map<string, QueuedTask>();
  private pumping = false;
  private repump = false;
  constructor(private readonly options: {
    directory?: string;
    persist?: TaskQueuePersistence;
    maxRunning: number;
    maxWaiting: number;
    enabled?: () => boolean;
    running: () => number;
    blocked: (request: TaskActionRequest) => boolean;
    execute: (request: TaskActionRequest) => Promise<TaskReceipt>;
    changed: (job: QueuedTask) => void;
  }) {
    if (options.persist) {
      // 存储里读出的是外部数据：坏的那条跳过，不让整个宿主起不来。
      for (const job of options.persist.load()) if (isQueuedTask(job)) this.restore(job);

      return;
    }

    if (!options.directory) {
      return;
    }

    mkdirSync(options.directory, { recursive: true, mode: 0o700 });

    try {
      const records = readdirSync(options.directory).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(options.directory!, f), 'utf8')) as unknown);

      for (const job of records) {
        if (!isQueuedTask(job)) {
          throw Error('Invalid task queue entry');
        }

        this.restore(job);
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  /**
   * A restarted host must not repeat an external action or silently resume an old page request.
   * 改写的收条带新的 updatedAt：后台按它去重，沿用旧时间会被当成旧消息丢掉，侧栏停在重启前的样子。
   */
  private restore(job: QueuedTask) {
    const updatedAt = Date.now();

    if (job.state === 'queued') {
      job.state = 'suspended';
      job.receipt = { ...job.receipt, status: 'queued', message: '连接已重启，这项待办尚未启动；原要求已保留，明确继续后才重新安排。', updatedAt };
    }
    else if (['starting', 'running'].includes(job.state)) {
      job.state = 'unknown';
      job.receipt = job.request.originConversationId && job.request.source === 'text'
        ? { ...job.receipt, status: 'unknown', message: STOPPED, updatedAt }
        : { ...job.receipt, status: 'unknown', message: '连接已重启，这项要求已保留；请核对后重新安排，不会自动重做。', updatedAt };
    }

    this.jobs.set(job.request.conversationId, job);
  }
  get(id: string) {
    return this.jobs.get(id);
  }
  list(origin?: string) {
    return [...this.jobs.values()].filter(j => !origin || j.request.originConversationId === origin);
  }
  private save(job: QueuedTask, claim = false) {
    if (this.options.persist) {
      this.options.persist.save([...this.jobs.values()].map(j => j.request.conversationId === job.request.conversationId ? job : j));

      return;
    }

    if (!this.options.directory) {
      return;
    }

    const file = join(this.options.directory, job.request.conversationId + '.json');
    const temp = `${file}.${randomUUID()}.tmp`;

    if (claim) {
      writeFileSync(file, JSON.stringify(job), { flag: 'wx', mode: 0o600 });

      return;
    }

    try {
      writeFileSync(temp, JSON.stringify(job), { mode: 0o600 });
      renameSync(temp, file);
    }
    finally {
      rmSync(temp, { force: true });
    }
  }
  private update(job: QueuedTask, change: Partial<QueuedTask>) {
    const next = { ...job, ...change };
    this.save(next);
    Object.assign(job, next);
  }
  add(request: TaskActionRequest, title: string): TaskReceipt {
    if (!isTaskActionRequest(request) || request.action !== 'start') {
      throw Error('Invalid queued request');
    }

    const existing = this.get(request.conversationId);

    if (existing) {
      return existing.receipt;
    }

    const base: TaskReceipt = { requestId: request.requestId, conversationId: request.conversationId, originConversationId: request.originConversationId, source: request.source, action: 'start', runId: null, text: request.text ?? '', targetTitle: title, status: 'queued', message: `已排队：${title}`, updatedAt: Date.now() };

    if (this.list().filter(j => j.state === 'queued' || j.state === 'suspended').length >= this.options.maxWaiting) {
      return { ...base, status: 'rejected', message: '待办已满，这项要求尚未接收；可以先取消一项待办。' };
    }

    const job: QueuedTask = { request: structuredClone(request), title, state: 'queued', receipt: base };
    this.jobs.set(request.conversationId, job);

    try {
      this.save(job, true);
    }
    catch (error) {
      this.jobs.delete(request.conversationId);
      throw error;
    }

    this.options.changed(job);

    return base;
  }
  cancel(id: string): TaskReceipt | undefined {
    const job = this.get(id);

    if (!job || !['queued', 'suspended'].includes(job.state)) {
      return;
    }

    this.update(job, { state: 'cancelled', receipt: { ...job.receipt, action: 'abort', status: 'applied', message: `已取消待办：${job.title}`, updatedAt: Date.now() } });
    this.options.changed(job);

    return job.receipt;
  }
  revise(id: string, text: string): TaskReceipt | undefined {
    const job = this.get(id);

    if (!job || !['queued', 'suspended'].includes(job.state)) {
      return;
    }

    const updated = `${job.request.text}\n用户补充要求：${text}`;

    if (updated.length > 12000) {
      throw Error('待办要求过长，修改未保存。');
    }

    this.update(job, { request: { ...job.request, text: updated }, receipt: { ...job.receipt, text: updated, message: `待办已更新：${job.title}`, updatedAt: Date.now() } });
    this.options.changed(job);

    return job.receipt;
  }
  bindRun(id: string, runId: string | null) {
    const job = this.get(id);

    if (job?.state === 'starting') {
      this.update(job, { receipt: { ...job.receipt, runId } });
    }
  }
  suspendPending(): void {
    let failed = false;

    for (const job of this.jobs.values()) {
      if (job.state === 'queued') {
        const change: Partial<QueuedTask> = { state: 'suspended', receipt: { ...job.receipt, message: '连接断开，这项待办尚未启动；明确继续后才重新安排。', updatedAt: Date.now() } };

        try {
          this.update(job, change);
        }
        catch {
          Object.assign(job, change);
          failed = true;
        }

        this.options.changed(job);
      }
    }

    if (failed) {
      throw new Error('Suspended pending jobs in memory, but could not persist all of them');
    }
  }
  resumePending(id: string, context?: PageContext): TaskReceipt | undefined {
    const job = this.get(id);

    if (!job || job.state !== 'suspended') {
      return;
    }

    const nextRequest = { ...job.request };

    if (job.request.context && context) nextRequest.context = context;
    this.update(job, { state: 'queued', request: nextRequest, receipt: { ...job.receipt, status: 'queued', message: `已重新排队：${job.title}`, updatedAt: Date.now() } });
    this.options.changed(job);

    return job.receipt;
  }
  /** 另开的那件事结束了：交出的回答或没做成的原因记进收条，发起它的会话据此显示（重放时也在）。 */
  settleSeparate(id: string, outcome: { text: string } | { failed: string } | { merged: true }): void {
    const job = this.get(id);

    // 并回上一件以后，它停下时的结局不再改写这张卡。
    if (!job?.request.originConversationId || isMerged(job)) return;
    const receipt: TaskReceipt = 'text' in outcome
      ? { ...job.receipt, status: 'accepted', result: { text: outcome.text.slice(0, 14000), at: Date.now() }, updatedAt: Date.now() }
      : 'merged' in outcome ? { ...job.receipt, action: 'start', status: 'applied', message: MERGED, updatedAt: Date.now() }
        : { ...job.receipt, status: 'failed', message: outcome.failed, updatedAt: Date.now() };
    if (receipt.status === job.receipt.status && receipt.message === job.receipt.message && receipt.result?.text === job.receipt.result?.text) return;
    this.update(job, { receipt });
    this.options.changed(job);
  }

  /** 重启后停下的另开那件又接着做了（自动续做或用户点了继续）：卡片回到「正在做」，做完照常带回回答。 */
  resumeSeparate(id: string): void {
    const job = this.get(id);

    if (!job?.request.originConversationId || job.state !== 'unknown' || job.receipt.message !== STOPPED) return;
    this.update(job, { state: 'running', receipt: { ...job.receipt, status: 'accepted', message: `正在做：${job.title}`, updatedAt: Date.now() } });
    this.options.changed(job);
  }

  finish(id: string, state: 'completed' | 'cancelled' | 'failed') {
    const job = this.get(id);

    if (!job || !['starting', 'running'].includes(job.state)) {
      return;
    }

    this.update(job, { state });
  }
  async pump(): Promise<void> {
    if (this.options.enabled?.() === false) {
      return;
    }

    if (this.pumping) {
      this.repump = true;

      return;
    }

    this.pumping = true;

    try {
      for (const job of this.jobs.values()) {
        if (this.options.enabled?.() === false) {
          break;
        }

        if (job.state !== 'queued' || this.options.blocked(job.request)) {
          continue;
        }

        if (this.options.running() >= this.options.maxRunning) {
          break;
        }

        this.update(job, { state: 'starting' });

        try {
          job.receipt = await this.options.execute(job.request);

          // Very short executions can finish synchronously in execute().
          if (this.get(job.request.conversationId)?.state === 'starting') {
            if (job.receipt.status === 'accepted') {
              job.state = 'running';
            } else if (job.receipt.status === 'unknown') {
              job.state = 'unknown';
            } else {
              job.state = 'failed';
            }
          }
        }
        catch {
          job.state = 'unknown';
          job.receipt = { ...job.receipt, status: 'unknown', message: '任务启动结果尚无法确认，不会自动重做。', updatedAt: Date.now() };
        }

        this.save(job);
        this.options.changed(job);
      }
    }
    finally {
      this.pumping = false;

      if (this.repump) {
        this.repump = false;
        await this.pump();
      }
    }
  }
}
