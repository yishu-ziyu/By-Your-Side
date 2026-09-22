import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {TaskDispatcher,TaskReceiptStore,TaskActionRejected} from '../src/task-dispatcher.js';
import type {TaskActionRequest} from '../../shared/task-actions.js';

const dirs:string[]=[];

afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));

const req:TaskActionRequest={requestId:'q1',conversationId:'A',source:'voice',action:'steer',expectedRunId:'run1',text:'预算800'};

const accepted={status:'accepted' as const,runId:'run1',message:'已送达'};

it('deduplicates concurrent, reordered, completed and disk-reloaded requests; rejects conflicting IDs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
 const d=new TaskDispatcher(new TaskReceiptStore(dir));let release!:()=>void;

 const execute=vi.fn(async()=>{await new Promise<void>(r=>release=r);

return accepted;});

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
 await d.dispatch(req,'A',async()=>{running=false;

return accepted;});

 const result=await d.dispatch({...req,requestId:'q2'},'A',async()=>{if(!running)throw new TaskActionRejected('原任务已结束');

return accepted;});

 expect(result).toMatchObject({status:'rejected',message:'原任务已结束'});
});

it('does not execute when a previously claimed record is unreadable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
 const store=new TaskReceiptStore(dir), d=new TaskDispatcher(store), execute=vi.fn(async()=>accepted);
 await d.dispatch(req,'A',execute);
 store.sync();
 const receiptFile=readdirSync(dir).find(name=>name.endsWith('.json')&&!name.startsWith('_'));

 if(!receiptFile) throw new Error('expected a receipt file');
 writeFileSync(join(dir,receiptFile),'{partial');
 const reloaded=new TaskDispatcher(new TaskReceiptStore(dir));
 expect((await reloaded.dispatch(req,'A',execute)).status).toBe('unknown');expect(execute).toHaveBeenCalledTimes(1);
});

// 请求指纹与 receipt 文件名由共享 canonical helper 之前的旧实现产生，用于锁住已落盘记录的字节兼容。
const LOCKED_FINGERPRINT='f3a674bba33bb98d95aa428a327f728023d3fdc72f3b15c0c27830eb86b7a36e';

const receiptName=(conversationId:string,requestId:string)=>`${createHash('sha256').update(`${conversationId}:${requestId}`).digest('hex')}.json`;

const nested:TaskActionRequest={...req,expectedControlVersion:3,scope:'task',tabId:7,context:{tabId:7,title:'订单',url:'https://shop.example/order',selection:{text:'总价 10 元'}}};

const image=(n:number)=>({id:`a${n}`,type:'image' as const,name:`图${n}`,dataBase64:'AA',mimeType:'image/png' as const});

it('keeps the recorded request fingerprint while array order and parameter changes still conflict',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
 const d=new TaskDispatcher(new TaskReceiptStore(dir)),execute=vi.fn(async()=>accepted);
 expect((await d.dispatch(nested,'比价',execute)).status).toBe('accepted');
 expect(JSON.parse(readFileSync(join(dir,receiptName('A','q1')),'utf8')).fingerprint).toBe(LOCKED_FINGERPRINT);
 const reordered=Object.fromEntries(Object.entries(nested).reverse()) as unknown as TaskActionRequest;
 const reorderedNested={...nested,context:{selection:{text:'总价 10 元'},url:'https://shop.example/order',title:'订单',tabId:7}};
 expect((await d.dispatch(reordered,'比价',execute)).status).toBe('accepted');
 expect((await d.dispatch(reorderedNested,'比价',execute)).status).toBe('accepted');
 expect(execute).toHaveBeenCalledTimes(1);
 expect((await d.dispatch({...nested,text:'预算600'},'比价',execute)).status).toBe('rejected');
 const attached:TaskActionRequest={...req,requestId:'q2',attachments:[image(1),image(2)]};
 expect((await d.dispatch(attached,'比价',execute)).status).toBe('accepted');
 expect((await d.dispatch({...attached,attachments:[image(2),image(1)]},'比价',execute)).status).toBe('rejected');
 expect(execute).toHaveBeenCalledTimes(2);
});

it('does not replay old finished or pending receipts reloaded from disk',async()=>{
 for(const pending of [false,true]){
  const dir=mkdtempSync(join(tmpdir(),'ego-receipts-'));dirs.push(dir);
  writeFileSync(join(dir,receiptName('A','q1')),JSON.stringify({fingerprint:LOCKED_FINGERPRINT,pending,
   receipt:{requestId:'q1',conversationId:'A',source:'voice',action:'steer',runId:'run1',text:'预算800',targetTitle:'比价',status:'accepted',message:'已送达',updatedAt:1}}));
  const execute=vi.fn(async()=>accepted);
  const result=await new TaskDispatcher(new TaskReceiptStore(dir)).dispatch(nested,'比价',execute);
  expect(execute).not.toHaveBeenCalled();
  expect(result.status).toBe(pending?'unknown':'accepted');
 }
});

const applied={status:'applied' as const,runId:'run1',message:'已接管'};

const settled=<T>(value:T)=>new Promise<T>(resolve=>setTimeout(()=>resolve(value),100));

it('lets a stop overtake a correction that is still waiting for its pre-observation',async()=>{
 const d=new TaskDispatcher();let releaseSteer!:()=>void;

 const steer=d.dispatch(req,'比价',async()=>{await new Promise<void>(resolve=>{releaseSteer=resolve;});

return accepted;});

 await new Promise(resolve=>setTimeout(resolve,0));
 const stop=d.dispatch({...req,requestId:'q-stop',action:'abort'},'比价',async()=>applied);
 expect(await Promise.race([stop.then(receipt=>receipt.status),settled('blocked' as const)])).toBe('applied');
 releaseSteer();
 expect((await steer).status).toBe('accepted');
});

it('keeps control requests ordered on their own channel and deduplicates replays',async()=>{
 const d=new TaskDispatcher();const order:string[]=[];let releasePause!:()=>void;

 const pause=d.dispatch({...req,requestId:'c1',action:'pause'},'比价',async()=>{
  order.push('pause:start');await new Promise<void>(resolve=>{releasePause=resolve;});order.push('pause:end');

return applied;});

 await new Promise(resolve=>setTimeout(resolve,0));

 const resume=d.dispatch({...req,requestId:'c2',action:'resume'},'比价',async()=>{order.push('resume');

return applied;});

 const replay=d.dispatch({...req,requestId:'c2',action:'resume'},'比价',async()=>{order.push('resume:replay');

return applied;});

 await new Promise(resolve=>setTimeout(resolve,0));
 expect(order).toEqual(['pause:start']);
 releasePause();
 expect((await pause).status).toBe('applied');
 expect(await resume).toEqual(await replay);
 expect(order).toEqual(['pause:start','pause:end','resume']);
});

it('keeps later normal input behind an earlier control request',async()=>{
 const d=new TaskDispatcher();const order:string[]=[];let releasePause!:()=>void;

 const pause=d.dispatch({...req,requestId:'c1',action:'pause'},'比价',async()=>{
  order.push('pause:start');await new Promise<void>(resolve=>{releasePause=resolve;});order.push('pause:end');

return applied;});

 await new Promise(resolve=>setTimeout(resolve,0));

 const steer=d.dispatch({...req,requestId:'s1'},'比价',async()=>{order.push('steer');

return accepted;});

 await new Promise(resolve=>setTimeout(resolve,0));
 expect(order).toEqual(['pause:start']);
 releasePause();
 await steer;expect(order).toEqual(['pause:start','pause:end','steer']);
});

it('preserves original input only for explicitly recoverable busy starts, including receipt replay',async()=>{
 const d=new TaskDispatcher();
 const input:TaskActionRequest={...req,action:'start',context:{tabId:4,title:'原页面',url:'https://example.test',selection:{text:'选中原文'}},attachments:[{id:'image1',name:'参考.png',type:'image',mimeType:'image/png',dataBase64:'aGVsbG8='}]};
 const denied=await d.dispatch(input,'当前任务',async()=>{throw new TaskActionRejected('另开会话',true)});
 expect(denied.newConversationRequest).toEqual(input);
 expect((await d.dispatch(input,'当前任务',async()=>accepted)).newConversationRequest).toEqual(input);
 const normal=await d.dispatch({...input,requestId:'q2'},'当前任务',async()=>{throw new TaskActionRejected('执行名额已满')});
 expect(normal.newConversationRequest).toBeUndefined();
});
