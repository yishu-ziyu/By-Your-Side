import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {TaskDispatcher,TaskReceiptStore,TaskActionRejected} from '../src/task-dispatcher.js';
import type {TaskActionRequest} from '../../shared/task-actions.js';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
const req:TaskActionRequest={requestId:'q1',conversationId:'A',source:'voice',action:'steer',expectedRunId:'run1',text:'预算800'};
const accepted={status:'accepted' as const,runId:'run1',message:'已送达'};
it('deduplicates concurrent, reordered, completed and disk-reloaded requests; rejects conflicting IDs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
 const d=new TaskDispatcher(new TaskReceiptStore(dir));let release!:()=>void;
 const execute=vi.fn(async()=>{await new Promise<void>(r=>release=r);return accepted;});
 const a=d.dispatch(req,'比价',execute),b=d.dispatch({...req},'比价',execute);await new Promise(r=>setTimeout(r,0));
 expect(execute).toHaveBeenCalledTimes(1);release();expect(await a).toEqual(await b);
 const reversed=Object.fromEntries(Object.entries(req).reverse()) as unknown as TaskActionRequest;
 expect((await d.dispatch(reversed,'比价',execute)).status).toBe('accepted');
 expect((await d.dispatch({...req,text:'预算600'},'比价',execute)).status).toBe('rejected');
 const loaded=new TaskDispatcher(new TaskReceiptStore(dir));expect((await loaded.dispatch(req,'比价',execute)).status).toBe('accepted');expect(execute).toHaveBeenCalledTimes(1);
 expect((await loaded.dispatch({...req,conversationId:'B'},'另一会话',async()=>accepted)).status).toBe('accepted');
});
it('records pending before execution and does not replay an uncertain request after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
 const store=new TaskReceiptStore(dir),d=new TaskDispatcher(store);
 const execute=vi.fn(async()=>{const file=join(dir,readdirSync(dir)[0]!);expect(JSON.parse(readFileSync(file,'utf8')).pending).toBe(true);throw new Error('connection lost after enqueue');});
 expect((await d.dispatch(req,'A',execute)).status).toBe('unknown');
 const file=join(dir,readdirSync(dir)[0]!);const value=JSON.parse(readFileSync(file,'utf8'));value.pending=true;writeFileSync(file,JSON.stringify(value));
 const reloaded=new TaskDispatcher(new TaskReceiptStore(dir));expect((await reloaded.dispatch(req,'A',execute)).status).toBe('unknown');expect(execute).toHaveBeenCalledTimes(1);
});
it('never executes without durable claim and leaves post-execution save failures unknown',async()=>{
 const store=new TaskReceiptStore(),d=new TaskDispatcher(store),execute=vi.fn(async()=>accepted);
 vi.spyOn(store,'claim').mockImplementationOnce(()=>{throw Error('disk full');});
 expect((await d.dispatch(req,'A',execute)).status).toBe('rejected');expect(execute).not.toHaveBeenCalled();
 vi.spyOn(store,'finish').mockImplementationOnce(()=>{throw Error('disk full');});
 expect((await d.dispatch({...req,requestId:'q2'},'A',execute)).status).toBe('unknown');
 expect((await d.dispatch({...req,requestId:'q2'},'A',execute)).status).toBe('unknown');expect(execute).toHaveBeenCalledTimes(1);
});
it('serializes state validation with acceptance and keeps expected rejections distinct',async()=>{
 const d=new TaskDispatcher();let running=true;
 await d.dispatch(req,'A',async()=>{running=false;return accepted;});
 const result=await d.dispatch({...req,requestId:'q2'},'A',async()=>{if(!running)throw new TaskActionRejected('原任务已结束');return accepted;});
 expect(result).toMatchObject({status:'rejected',message:'原任务已结束'});
});
it('does not execute when a previously claimed record is unreadable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
 const d=new TaskDispatcher(new TaskReceiptStore(dir)), execute=vi.fn(async()=>accepted);
 await d.dispatch(req,'A',execute);writeFileSync(join(dir,readdirSync(dir)[0]!),'{partial');
 expect((await d.dispatch(req,'A',execute)).status).toBe('unknown');expect(execute).toHaveBeenCalledTimes(1);
});
