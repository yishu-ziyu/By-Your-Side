// Controller-owned: a correction invalidates unexecuted writes, including a running browser program.
import {describe,expect,it,vi} from 'vitest';
import {createBrowserTools} from '../src/tools.js';
import {BrowserAgentSession} from '../src/session.js';
describe('S2 correction execution fence',()=>{
 it('a browser program created before correction cannot write after its waiting read resolves',async()=>{
  let epoch=1,release!:(v:unknown)=>void;const waiting=new Promise(r=>release=r);
  const rpc:any={call:vi.fn(async(name:string)=>name==='snapshot'?waiting:{marked:true})};
  const tools=(createBrowserTools as any)(rpc,undefined,undefined,undefined,{epoch:()=>epoch,canWrite:()=>true});
  const program=tools.find((t:any)=>t.name==='browser_run');
  const pending=program.execute('p',{code:"await browser.snapshot(); return await browser.mark({target:'#x'});"}).catch((e:unknown)=>e);
  await vi.waitFor(()=>expect(rpc.call).toHaveBeenCalled());epoch++;release({text:'old X'});await pending;
  expect(rpc.call.mock.calls.filter((c:any)=>c[0]==='mark')).toHaveLength(0);
 });
 it('queued old-plan writes are blocked until the corrected user input has actually been consumed',async()=>{
  let allowed=false;const rpc:any={call:vi.fn(async()=>({marked:true}))};
  const tools=(createBrowserTools as any)(rpc,undefined,undefined,undefined,{epoch:()=>2,canWrite:()=>allowed});const mark=tools.find((t:any)=>t.name==='mark');
  await expect(mark.execute('old',{target:'#x'})).rejects.toThrow();expect(rpc.call).not.toHaveBeenCalled();allowed=true;await mark.execute('new',{target:'#y'});expect(rpc.call).toHaveBeenCalledTimes(1);
 });
 it('accepting a steer publishes a newer execution epoch before acknowledging; a turn alone does not release it',async()=>{
  let subscriber:(e:any)=>void=()=>{};const raw:any={isStreaming:true,steer:vi.fn(async()=>{}),subscribe:(f:any)=>subscriber=f};const status=vi.fn();
  const session:any=new (BrowserAgentSession as any)(raw,null,{emit:vi.fn(),setStatus:status},null,null);session.subscribeEvents();const epoch=session.executionEpoch();await session.steerCurrentTask('对象改成Y');
  expect(session.executionEpoch()).toBeGreaterThan(epoch);expect(status).toHaveBeenCalledWith('running');expect(session.canWriteCurrentInput()).toBe(false);
  subscriber({type:'turn_start'});expect(session.canWriteCurrentInput()).toBe(false);subscriber({type:'message_start',message:{role:'user',content:'不相关的旧消息'}});expect(session.canWriteCurrentInput()).toBe(false);
  subscriber({type:'message_start',message:{role:'user',content:'对象改成Y'}});expect(session.canWriteCurrentInput()).toBe(true);
 });
});
it('handback publishes its real supplied page snapshot as matched observation evidence before continuing',()=>{const emit=vi.fn();const raw:any={model:{id:'fixture'},isStreaming:false,agent:{state:{messages:[]}},abort:vi.fn(async()=>{}),prompt:vi.fn(async()=>{})};const session:any=new (BrowserAgentSession as any)(raw,null,{emit,setStatus:vi.fn()},null,null);session.holdForUser({abortStream:false});try{void session.continueAfterHandback({tabId:7,url:'https://fixture.test',title:'当前页'},'verified fresh Y snapshot');const start=emit.mock.calls.map(c=>c[0]).find(e=>e.kind==='tool_start'&&e.name==='snapshot');const end=emit.mock.calls.map(c=>c[0]).find(e=>e.kind==='tool_end'&&e.name==='snapshot');expect(start).toBeDefined();expect(end).toMatchObject({toolCallId:start?.toolCallId,isError:false,resultText:'verified fresh Y snapshot'});}finally{session.abort();}});
