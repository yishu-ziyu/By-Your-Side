import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isTaskReceipt, type TaskActionRequest, type TaskReceipt } from '../../shared/task-actions.js';
import { canonicalValue } from './canonical-value.js';

type RecordEntry = { fingerprint: string; pending: boolean; receipt: TaskReceipt };

const keyOf = (a: Pick<TaskActionRequest,'conversationId'|'requestId'>) => `${a.conversationId}:${a.requestId}`;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class TaskActionRejected extends Error {
  constructor(message: string, readonly allowNewConversation = false) { super(message); }
}

export class TaskActionFailed extends Error {}

export class TaskReceiptError extends Error {
  constructor(readonly receipt:TaskReceipt) { super(receipt.message); }
}

/** One private file per request. Never prune automatically: an old ID must not execute again. */
export class TaskReceiptStore {
  private readonly memory = new Map<string, RecordEntry>();
  private indexMem: Record<string, string[]> | null = null;
  private readonly membership = new Map<string, Set<string>>();
  private indexDirty = false;
  private indexMissing = false;
  private scannedAll = false;
  private readonly loadedConversations = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly directory?: string) { if (directory) mkdirSync(directory,{recursive:true,mode:0o700}); }
  private file(key: string): string { return join(this.directory!, `${hash(key)}.json`); }
  private remember(key: string, record: RecordEntry): void {
    this.memory.set(key, record);
    this.addKey(record.receipt.conversationId, key);

    if (record.receipt.originConversationId) this.addKey(record.receipt.originConversationId, key);
  }
  read(key: string): RecordEntry | undefined {
    const cached = this.memory.get(key);

    if (cached) return cached;

    if (!this.directory) return;

    try {
      const record = JSON.parse(readFileSync(this.file(key),'utf8')) as RecordEntry;

      if (typeof record.fingerprint !== 'string' || typeof record.pending !== 'boolean' || !isTaskReceipt(record.receipt)) throw new Error('Invalid task receipt');
      this.remember(key, record);

      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  claim(key: string, record: RecordEntry): boolean {
    if (!this.directory) {
      if (this.memory.has(key)) return false;
      this.remember(key, record);

      return true;
    }

    try {
      writeFileSync(this.file(key),JSON.stringify(record),{flag:'wx',mode:0o600});
      this.remember(key, record);
      this.scheduleFlush();

      return true;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  }
  finish(key: string, record: RecordEntry): void {
    this.remember(key, record);

    if (!this.directory) return;
    const file = this.file(key), staged = `${file}.${randomUUID()}.tmp`;

    try { writeFileSync(staged,JSON.stringify(record),{mode:0o600});renameSync(staged,file); this.scheduleFlush(); }
    finally { rmSync(staged,{force:true}); }
  }
  /** Durable index catch-up; list/read do not wait on this. */
  sync(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }

    this.flushIndex();
  }
  private indexPath(): string { return join(this.directory!, "_index.json"); }
  private loadIndex(): Record<string, string[]> {
    if (this.indexMem) return this.indexMem;

    try { this.indexMem = JSON.parse(readFileSync(this.indexPath(), "utf8")) as Record<string, string[]>; }
    catch { this.indexMem = {}; this.indexMissing = true; }

    this.membership.clear();

    for (const [id, keys] of Object.entries(this.indexMem)) this.membership.set(id, new Set(keys));

    return this.indexMem;
  }
  private flushIndex(): void {
    if (!this.directory || !this.indexDirty || !this.indexMem) return;
    const staged = `${this.indexPath()}.${randomUUID()}.tmp`;

    try { writeFileSync(staged, JSON.stringify(this.indexMem), { mode: 0o600 }); renameSync(staged, this.indexPath()); this.indexDirty = false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    finally { rmSync(staged, { force: true }); }
  }
  private addKey(conversationId: string, key: string): void {
    if (this.directory) this.loadIndex();
    else this.indexMem ??= {};
    const index = this.indexMem!;
    const list = index[conversationId] ?? (index[conversationId] = []);
    let set = this.membership.get(conversationId);

    if (!set) { set = new Set(list); this.membership.set(conversationId, set); }

    if (set.has(key)) return;
    set.add(key);
    list.push(key);
    this.indexDirty = true;
  }
  private scheduleFlush(): void {
    if (!this.directory || this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushIndex(); }, 250);
    this.flushTimer.unref?.();
  }
  private hydrateConversation(conversationId: string): void {
    if (this.loadedConversations.has(conversationId)) return;
    this.loadedConversations.add(conversationId);

    if (!this.directory) return;
    const keys = this.loadIndex()[conversationId] ?? [];

    if (keys.length === 0 && this.indexMissing && !this.scannedAll) {
      this.scannedAll = true;

      for (const name of readdirSync(this.directory).filter((f) => f.endsWith(".json") && !f.startsWith("_"))) {
        try {
          const record = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as RecordEntry;

          if (typeof record.fingerprint === "string" && typeof record.pending === "boolean" && isTaskReceipt(record.receipt)) {
            this.remember(`${record.receipt.conversationId}:${record.receipt.requestId}`, record);
          }
        } catch { /* skip unreadable records; list must not throw */ }
      }

      return;
    }

    for (const key of keys.slice(-5000)) {
      if (this.memory.has(key)) continue;

      try { this.read(key); } catch { /* skip unreadable records; list must not throw */ }
    }
  }
  list(conversationId: string): TaskReceipt[] {
    this.hydrateConversation(conversationId);
    const keys = (this.indexMem?.[conversationId] ?? []).slice(-5000);

    const records = keys.length > 0
      ? keys.map((key) => this.memory.get(key)).filter((r): r is RecordEntry => !!r)
      : [...this.memory.values()].filter((r) => r.receipt.conversationId===conversationId||r.receipt.originConversationId===conversationId);

    return records.filter(r => isTaskReceipt(r.receipt))
      .map(r=>this.receipt(r)).sort((a,b)=>a.updatedAt-b.updatedAt).slice(-5000);
  }
  receipt(record: RecordEntry): TaskReceipt {
    return record.pending ? {...record.receipt,status:'unknown',message:'这条请求的执行结果尚无法确认；不会自动重做。'} : {...record.receipt};
  }
}

/**
 * 控制（暂停/接管/终止）有自己的接收通道：它不等待慢的 start/steer（例如还在等页面预观察的那几秒），
 * 否则"页面已经归用户"的停止请求会被卡在普通输入后面。控制自身仍按会话串行。
 * 普通输入仍按会话串行，并且新入队的普通输入排在它之前已入队的控制之后，保持既有先后。
 */
const CONTROL_ACTIONS = new Set<TaskActionRequest['action']>(['pause','abort','resume']);

/** Serialized acceptance boundary, not a queue for waiting until a task becomes runnable. */
export class TaskDispatcher {
  private readonly active = new Map<string,{fingerprint:string;promise:Promise<TaskReceipt>}>();
  private readonly tails = new Map<string,Promise<unknown>>();
  private readonly controlTails = new Map<string,Promise<unknown>>();
  constructor(readonly store = new TaskReceiptStore()) {}
  get(conversationId:string,requestId:string):TaskReceipt|undefined {
    const value=this.store.read(keyOf({conversationId,requestId}));

return value?this.store.receipt(value):undefined;
  }
  dispatch(request:TaskActionRequest, targetTitle:string, execute:()=>Promise<Pick<TaskReceipt,'status'|'message'|'runId'> & Partial<Pick<TaskReceipt,'action'|'diff'>>>, options?:{deferredResume?:boolean}):Promise<TaskReceipt> {
    const key=keyOf(request), fingerprint=hash(canonicalValue(request));
    const base:TaskReceipt={requestId:request.requestId,conversationId:request.conversationId,source:request.source,action:request.action,runId:request.expectedRunId,text:request.text??'',targetTitle,status:'unknown',message:'执行结果尚无法确认。',updatedAt:Date.now()};

    if (request.originConversationId) base.originConversationId = request.originConversationId;
    const conflict=()=>({...base,status:'rejected' as const,message:'同一请求编号的内容发生变化，操作未执行。'});
    const pending=this.active.get(key);

    if(pending)return pending.fingerprint===fingerprint?pending.promise:Promise.resolve(conflict());
    // A checkpoint resume includes a slow page read. It belongs to the ordinary
    // lane so pause/abort can invalidate it immediately, not wait behind the read.
    const conversationId=request.conversationId,control=CONTROL_ACTIONS.has(request.action)&&!(request.action==='resume'&&options?.deferredResume);
    const controlTail=this.controlTails.get(conversationId)??Promise.resolve();
    const prior=control?controlTail:Promise.all([this.tails.get(conversationId)??Promise.resolve(),controlTail]);

    const promise=prior.catch(()=>{}).then(async()=>{
      const record:RecordEntry={fingerprint,pending:true,receipt:base};
      let existing:RecordEntry|undefined;

      try { existing=this.store.read(key); }
      catch { return {...base,status:'unknown' as const,message:'已有请求记录无法读取，执行结果尚无法确认；不会自动重做。'}; }

      if(existing)return existing.fingerprint===fingerprint?this.store.receipt(existing):conflict();

      try {
        if(!this.store.claim(key,record)) {
          let raced:RecordEntry|undefined;

          try { raced=this.store.read(key); } catch { return {...base,status:'unknown' as const,message:'已有请求记录无法读取；不会自动重做。'}; }

          if(!raced)return {...base,status:'unknown' as const,message:'请求记录状态发生变化；不会自动重做。'};

          return raced.fingerprint===fingerprint?this.store.receipt(raced):conflict();
        }
      } catch { return {...base,status:'rejected' as const,message:'无法保存请求记录，操作未执行。'}; }

      let receipt:TaskReceipt;

      try { receipt={...base,...await execute(),updatedAt:Date.now()}; }
      catch(error) { receipt={...base,status:error instanceof TaskActionRejected?'rejected':error instanceof TaskActionFailed?'failed':'unknown',message:error instanceof TaskActionRejected||error instanceof TaskActionFailed?error.message:'执行结果尚无法确认；不会自动重做。',updatedAt:Date.now()};

 if (error instanceof TaskActionRejected && error.allowNewConversation && request.action === 'start') receipt.newConversationRequest = structuredClone(request); }

      try { this.store.finish(key,{fingerprint,pending:false,receipt}); }
      catch { return {...receipt,status:'unknown' as const,message:'回执未能保存，执行结果尚无法确认；不会自动重做。'}; }

      return receipt;
    });

    const tails=control?this.controlTails:this.tails;
    this.active.set(key,{fingerprint,promise});tails.set(conversationId,promise);
    void promise.finally(()=>{this.active.delete(key);

if(tails.get(conversationId)===promise)tails.delete(conversationId);}).catch(()=>{});

    return promise;
  }
}
