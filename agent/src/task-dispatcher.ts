import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isTaskReceipt, type TaskActionRequest, type TaskReceipt } from '../../shared/task-actions.js';

type RecordEntry = { fingerprint: string; pending: boolean; receipt: TaskReceipt };
const keyOf = (a: Pick<TaskActionRequest,'conversationId'|'requestId'>) => `${a.conversationId}:${a.requestId}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Canonical key order makes transport property ordering irrelevant to deduplication.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export class TaskActionRejected extends Error {}
export class TaskActionFailed extends Error {}
export class TaskReceiptError extends Error {
  constructor(readonly receipt:TaskReceipt) { super(receipt.message); }
}

/** One private file per request. Never prune automatically: an old ID must not execute again. */
export class TaskReceiptStore {
  private readonly memory = new Map<string, RecordEntry>();
  constructor(private readonly directory?: string) { if (directory) mkdirSync(directory,{recursive:true,mode:0o700}); }
  private file(key: string): string { return join(this.directory!, `${hash(key)}.json`); }
  read(key: string): RecordEntry | undefined {
    if (!this.directory) return this.memory.get(key);
    try {
      const record = JSON.parse(readFileSync(this.file(key),'utf8')) as RecordEntry;
      if (typeof record.fingerprint !== 'string' || typeof record.pending !== 'boolean' || !isTaskReceipt(record.receipt)) throw new Error('Invalid task receipt');
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  claim(key: string, record: RecordEntry): boolean {
    if (!this.directory) { if (this.memory.has(key)) return false; this.memory.set(key,record); return true; }
    try { writeFileSync(this.file(key),JSON.stringify(record),{flag:'wx',mode:0o600}); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  }
  finish(key: string, record: RecordEntry): void {
    if (!this.directory) { this.memory.set(key,record); return; }
    const file = this.file(key), staged = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(staged,JSON.stringify(record),{mode:0o600});renameSync(staged,file); }
    finally { rmSync(staged,{force:true}); }
  }
  list(conversationId: string): TaskReceipt[] {
    const records = this.directory ? readdirSync(this.directory).filter(f=>f.endsWith('.json')).map(f=> {
      try { return JSON.parse(readFileSync(join(this.directory!,f),'utf8')) as RecordEntry; } catch { return undefined; }
    }) : [...this.memory.values()];
    return records.filter((r):r is RecordEntry=>!!r && isTaskReceipt(r.receipt) && (r.receipt.conversationId===conversationId||r.receipt.originConversationId===conversationId))
      .map(r=>this.receipt(r)).sort((a,b)=>a.updatedAt-b.updatedAt).slice(-5000);
  }
  receipt(record: RecordEntry): TaskReceipt {
    return record.pending ? {...record.receipt,status:'unknown',message:'这条请求的执行结果尚无法确认；不会自动重做。'} : {...record.receipt};
  }
}

/** Serialized acceptance boundary, not a queue for waiting until a task becomes runnable. */
export class TaskDispatcher {
  private readonly active = new Map<string,{fingerprint:string;promise:Promise<TaskReceipt>}>();
  private readonly tails = new Map<string,Promise<unknown>>();
  constructor(readonly store = new TaskReceiptStore()) {}
  get(conversationId:string,requestId:string):TaskReceipt|undefined {
    const value=this.store.read(keyOf({conversationId,requestId}));return value?this.store.receipt(value):undefined;
  }
  dispatch(request:TaskActionRequest, targetTitle:string, execute:()=>Promise<Pick<TaskReceipt,'status'|'message'|'runId'>>):Promise<TaskReceipt> {
    const key=keyOf(request), fingerprint=hash(canonical(request));
    const base:TaskReceipt={requestId:request.requestId,conversationId:request.conversationId,source:request.source,...(request.originConversationId?{originConversationId:request.originConversationId}:{}),action:request.action,runId:request.expectedRunId,text:request.text??'',targetTitle,status:'unknown',message:'执行结果尚无法确认。',updatedAt:Date.now()};
    const conflict=()=>({...base,status:'rejected' as const,message:'同一请求编号的内容发生变化，操作未执行。'});
    const pending=this.active.get(key);
    if(pending)return pending.fingerprint===fingerprint?pending.promise:Promise.resolve(conflict());
    const promise=(this.tails.get(request.conversationId)??Promise.resolve()).catch(()=>{}).then(async()=>{
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
      catch(error) { receipt={...base,status:error instanceof TaskActionRejected?'rejected':error instanceof TaskActionFailed?'failed':'unknown',message:error instanceof TaskActionRejected||error instanceof TaskActionFailed?error.message:'执行结果尚无法确认；不会自动重做。',updatedAt:Date.now()}; }
      try { this.store.finish(key,{fingerprint,pending:false,receipt}); }
      catch { return {...receipt,status:'unknown' as const,message:'回执未能保存，执行结果尚无法确认；不会自动重做。'}; }
      return receipt;
    });
    this.active.set(key,{fingerprint,promise});this.tails.set(request.conversationId,promise);
    void promise.finally(()=>{this.active.delete(key);if(this.tails.get(request.conversationId)===promise)this.tails.delete(request.conversationId);}).catch(()=>{});
    return promise;
  }
}
