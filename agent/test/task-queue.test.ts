import {expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskQueue} from '../src/task-queue.js';
import type {TaskActionRequest} from '../../shared/task-actions.js';

const request=(id:string):TaskActionRequest=>({requestId:id,conversationId:id,originConversationId:'main',source:'voice',action:'start',expectedRunId:null,text:id});

function setup(directory?:string){
 let running=1;const blocked=new Set<string>();

 const execute=vi.fn(async(r:TaskActionRequest)=>{running++;

return {requestId:r.requestId,conversationId:r.conversationId,source:r.source,action:r.action,runId:r.conversationId+'-run',text:r.text!,targetTitle:r.text!,status:'accepted' as const,message:'accepted',updatedAt:1};});

 const queue=new TaskQueue({directory,maxRunning:2,maxWaiting:3,running:()=>running,blocked:r=>blocked.has(r.conversationId),execute,changed:()=>{}});

 return {queue,execute,blocked,setRunning:(n:number)=>running=n};
}

it('admits at most two running jobs, retains FIFO waiters, rejects overload explicitly',async()=>{
 const h=setup();
 h.queue.add(request('a'),'a');await h.queue.pump();

 for(const id of ['b','c','d'])expect(h.queue.add(request(id),id).status).toBe('queued');
 expect(h.queue.add(request('e'),'e').status).toBe('rejected');
 await h.queue.pump();expect(h.execute).toHaveBeenCalledTimes(1);
 h.setRunning(1);h.queue.finish('a','completed');await h.queue.pump();await vi.waitFor(()=>expect(h.execute).toHaveBeenCalledTimes(2));
 expect(h.execute.mock.calls.map(([r])=>r.conversationId)).toEqual(['a','b']);
});

it('blocked pages do not block independent work; queued edits and cancellation only affect their target',async()=>{
 const h=setup();h.blocked.add('a');
 h.queue.add(request('a'),'a');h.queue.add(request('b'),'b');h.queue.add(request('c'),'c');
 h.queue.revise('a','使用中文');h.queue.cancel('c');await h.queue.pump();
 expect(h.execute.mock.calls.map(([r])=>r.conversationId)).toEqual(['b']);
 expect(h.queue.get('a')?.request.text).toContain('使用中文');expect(h.queue.get('c')?.state).toBe('cancelled');
 h.blocked.delete('a');h.setRunning(1);h.queue.finish('b','completed');await h.queue.pump();await vi.waitFor(()=>expect(h.execute).toHaveBeenCalledTimes(2));
 expect(h.execute.mock.calls[1]![0].text).toContain('使用中文');
});

it('duplicate admission does not create a second execution and restart never repeats unknown effects',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'voice-queue-'));

 try{
  const h=setup(directory);h.queue.add(request('a'),'a');h.queue.add(request('a'),'a');await h.queue.pump();
  h.queue.add(request('b'),'b');expect(h.execute).toHaveBeenCalledTimes(1);
  const restored=setup(directory);await restored.queue.pump();
  expect(restored.execute).not.toHaveBeenCalled();expect(restored.queue.list().map(j=>j.state)).toEqual(['unknown','suspended']);
  expect(restored.queue.get('b')?.request.text).toBe('b');
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it('does not apply an amendment that could not be saved',()=>{
 const directory=mkdtempSync(join(tmpdir(),'voice-queue-fail-'));
 const h=setup(directory);h.queue.add(request('a'),'a');
 rmSync(directory,{recursive:true,force:true});
 expect(()=>h.queue.revise('a','未落盘要求')).toThrow();
 expect(h.queue.get('a')?.request.text).toBe('a');
 expect(()=>h.queue.cancel('a')).toThrow();expect(h.queue.get('a')?.state).toBe('queued');
});
