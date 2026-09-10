import {mkdtempSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {VoicePlanStore} from '../src/voice-plan-store.js';
it('claims before classification and replays the same completed plan after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'voice-plan-'));
 try{
  const store=new VoicePlanStore(dir),execute=vi.fn(async()=>({kind:'none' as const}));
  const first=await store.run('A','p1',{text:'question'},execute);
  expect(await new VoicePlanStore(dir).run('A','p1',{text:'question'},execute)).toEqual(first);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await store.run('A','p1',{text:'different'},execute)).toMatchObject({kind:'clarify'});
  expect(execute).toHaveBeenCalledTimes(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('joins concurrent delivery and refuses to resume a pending on-disk plan',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'voice-plan-'));let finish!:(r:any)=>void;
 try{
  const store=new VoicePlanStore(dir),execute=vi.fn(()=>new Promise<any>(r=>finish=r));
  const first=store.run('A','p1','same',execute),duplicate=store.run('A','p1','same',execute);await Promise.resolve();
  store.update('A','p1',{steps:[{action:'pause',text:'暂停',targetId:'A',status:'pending'},{action:'resume',text:'继续',targetId:'A',status:'unexecuted'}]});
  expect(await new VoicePlanStore(dir).run('A','p1','same',execute)).toMatchObject({kind:'action',status:'unknown'});
  finish({kind:'action',ok:true,status:'applied',message:'done'});
  expect(await duplicate).toEqual(await first);expect(execute).toHaveBeenCalledTimes(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('does not classify or execute when persisted plan data is corrupt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'voice-plan-'));
 try{
  const store=new VoicePlanStore(dir);await store.run('A','p1','x',async()=>({kind:'none'}));
  writeFileSync(join(dir,readdirSync(dir)[0]!),'{broken');const execute=vi.fn();
  expect(await store.run('A','p1','x',execute)).toMatchObject({status:'unknown'});expect(execute).not.toHaveBeenCalled();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('reports an execution error as unknown instead of claiming no action was sent',async()=>{
 const store=new VoicePlanStore();const result=await store.run('A','p1','x',async()=>{store.update('A','p1',{steps:[{action:'start',text:'task',targetId:'A',status:'pending'}]});throw Error('after dispatch');});
 expect(result).toMatchObject({kind:'action',status:'unknown',plan:{steps:[{status:'pending'}]}});
 expect(await store.run('A','p1','x',vi.fn())).toMatchObject({status:'unknown',plan:{steps:[{status:'pending'}]}});
});
