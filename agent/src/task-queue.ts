import {mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isTaskActionRequest,isTaskReceipt,type TaskActionRequest,type TaskReceipt} from '../../shared/task-actions.js';

export interface QueuedTask {
 request:TaskActionRequest;
 title:string;
 state:'queued'|'starting'|'running'|'completed'|'cancelled'|'failed'|'unknown';
 receipt:TaskReceipt;
}
/** Durable admission for independent requirements. Execution still belongs to TaskDispatcher. */
export class TaskQueue {
 private readonly jobs=new Map<string,QueuedTask>();
 private pumping=false;
 private repump=false;
 constructor(private readonly options:{
  directory?:string; maxRunning:number; maxWaiting:number;
  running:()=>number;
  blocked:(request:TaskActionRequest)=>boolean;
  execute:(request:TaskActionRequest)=>Promise<TaskReceipt>;
  changed:(job:QueuedTask)=>void;
 }){
  if(!options.directory)return;
  mkdirSync(options.directory,{recursive:true,mode:0o700});
  try{
   const records=readdirSync(options.directory).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(options.directory!,f),'utf8')) as QueuedTask);
   for(const job of records){
    if(!isTaskActionRequest(job?.request)||!isTaskReceipt(job?.receipt)||!['queued','starting','running','completed','cancelled','failed','unknown'].includes(job.state))throw Error('Invalid task queue entry');
    // A restarted host must not repeat an external action or silently resume an old page request.
    if(['starting','running','queued'].includes(job.state)){
     job.state='unknown';job.receipt={...job.receipt,status:'unknown',message:'连接已重启，这项要求已保留；请核对后重新安排，不会自动重做。'};
    }
    this.jobs.set(job.request.conversationId,job);
   }
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 get(id:string){return this.jobs.get(id);}
 list(origin?:string){return [...this.jobs.values()].filter(j=>!origin||j.request.originConversationId===origin);}
 private save(job:QueuedTask,claim=false){
  if(!this.options.directory)return;
  const file=join(this.options.directory,job.request.conversationId+'.json'),temp=`${file}.${randomUUID()}.tmp`;
  if(claim){writeFileSync(file,JSON.stringify(job),{flag:'wx',mode:0o600});return;}
  try{writeFileSync(temp,JSON.stringify(job),{mode:0o600});renameSync(temp,file);}finally{rmSync(temp,{force:true});}
 }
 private update(job:QueuedTask,change:Partial<QueuedTask>){
  const next={...job,...change};this.save(next);Object.assign(job,next);
 }
 add(request:TaskActionRequest,title:string):TaskReceipt{
  if(!isTaskActionRequest(request)||request.action!=='start')throw Error('Invalid queued request');
  const existing=this.get(request.conversationId);if(existing)return existing.receipt;
  const base:TaskReceipt={requestId:request.requestId,conversationId:request.conversationId,originConversationId:request.originConversationId,source:request.source,action:'start',runId:null,text:request.text??'',targetTitle:title,status:'queued',message:`已排队：${title}`,updatedAt:Date.now()};
  if(this.list().filter(j=>j.state==='queued').length>=this.options.maxWaiting)return {...base,status:'rejected',message:'待办已满，这项要求尚未接收；可以先取消一项待办。'};
  const job:QueuedTask={request:structuredClone(request),title,state:'queued',receipt:base};
  this.jobs.set(request.conversationId,job);
  try{this.save(job,true);}catch(error){this.jobs.delete(request.conversationId);throw error;}
  this.options.changed(job);return base;
 }
 cancel(id:string):TaskReceipt|undefined{
  const job=this.get(id);if(!job||job.state!=='queued')return;
  this.update(job,{state:'cancelled',receipt:{...job.receipt,action:'abort',status:'applied',message:`已取消待办：${job.title}`,updatedAt:Date.now()}});
  this.options.changed(job);return job.receipt;
 }
 revise(id:string,text:string):TaskReceipt|undefined{
  const job=this.get(id);if(!job||job.state!=='queued')return;
  const updated=`${job.request.text}\n用户补充要求：${text}`;
  if(updated.length>12000)throw Error('待办要求过长，修改未保存。');
  this.update(job,{request:{...job.request,text:updated},receipt:{...job.receipt,text:updated,message:`待办已更新：${job.title}`,updatedAt:Date.now()}});
  this.options.changed(job);return job.receipt;
 }
 bindRun(id:string,runId:string|null){
  const job=this.get(id);if(job?.state==='starting')this.update(job,{receipt:{...job.receipt,runId}});
 }
 finish(id:string,state:'completed'|'cancelled'|'failed'){
  const job=this.get(id);if(!job||!['starting','running'].includes(job.state))return;
  this.update(job,{state});
 }
 async pump():Promise<void>{
  if(this.pumping){this.repump=true;return;}
  this.pumping=true;
  try{
   for(const job of this.jobs.values()){
    if(job.state!=='queued'||this.options.blocked(job.request))continue;
    if(this.options.running()>=this.options.maxRunning)break;
    this.update(job,{state:'starting'});
    try{
     job.receipt=await this.options.execute(job.request);
     // Very short executions can finish synchronously in execute().
     if(this.get(job.request.conversationId)?.state==='starting')job.state=job.receipt.status==='accepted'?'running':job.receipt.status==='unknown'?'unknown':'failed';
    }catch{job.state='unknown';job.receipt={...job.receipt,status:'unknown',message:'任务启动结果尚无法确认，不会自动重做。',updatedAt:Date.now()};}
    this.save(job);this.options.changed(job);
   }
  }finally{this.pumping=false;if(this.repump){this.repump=false;await this.pump();}}
 }
}
