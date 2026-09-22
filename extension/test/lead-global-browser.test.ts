import { beforeEach, expect, it, vi } from 'vitest';

let stored: Record<string, unknown>;

beforeEach(() => {
  vi.resetModules(); stored={};
  vi.stubGlobal('chrome', {
    storage:{session:{get:vi.fn(async(k:string)=>({[k]:stored[k]})),set:vi.fn(async(v:object)=>Object.assign(stored,v))}},
    tabs:{query:vi.fn(async()=>[1,2,3].map(id=>({id,title:`page ${id}`,url:`https://test/${id}`}))),get:vi.fn(async(id:number)=>({id})),onRemoved:{addListener:vi.fn()}},
  });
});

async function setup(){
  const s=await import('../src/background/state.js');
  const a=s.executionKey('A','main'), b=s.executionKey('B','main'), w=s.executionKey('B','writer');
  await s.setWorkingTab(1,a);await s.setWorkingTab(2,w);

  return {s,a,b,w};
}

it('主 Agent 列出全部页面，worker 仅见分配页',async()=>{
  const {a,w}=await setup();const {listTabs}=await import('../src/background/exec/tabs.js');
  expect((await listTabs(a)).tabs.map(t=>t.id)).toEqual([1,2,3]);
  expect((await listTabs(w)).tabs.map(t=>t.id)).toEqual([2]);
});

it('跨会话读取不认领页面，不改变双方指针；worker 不能读取未分配页',async()=>{
  const {s,a,w}=await setup();
  await expect(s.resolveReadableTab(2,a)).resolves.toMatchObject({id:2});
  expect(await s.getWorkingTabId(a)).toBe(1);
  expect((await s.getTabResource(2))?.collaborators).toEqual([w]);
  await expect(s.resolveReadableTab(1,w)).rejects.toThrow();
});

it('认领必须匹配检查时的归属，不能覆盖另一次接手',async()=>{
  const {s,a,b,w}=await setup();
  await s.claimGlobalTab(2,a,'B');
  expect((await s.getTabResource(2))?.collaborators).toEqual([a]);
  expect(await s.getWorkingTabId(w)).toBeNull();
  await expect(s.claimGlobalTab(2,b,'B')).rejects.toThrow(/归属已变化/);
  await expect(s.claimGlobalTab(3,w,null)).rejects.toThrow(/主 Agent/);
});

it('跨会话接手等待原主 Agent 的操作完成，并按页阻止移交期间的新操作',async()=>{
  const {s,a,b}=await setup();await s.claimGlobalTab(2,b,'B');
  const {WorkerTabControl}=await import('../src/background/worker-tab-control.js');const c=new WorkerTabControl();
  let end!:()=>void,started!:()=>void;const began=new Promise<void>(r=>started=r);
  const running=c.run(b,async()=>{started();await new Promise<void>(r=>end=r);});await began;
  const move=c.manage({action:'claim',tabId:2,expectedConversationId:'B'},a);
  // 旧断言期望 isStopped(b)（整个成员被停止）。那是错误语义：接手只封被交接的那一页，
  // b 在别的页仍应可操作。改为验证该页围栏本身，以及围栏不跨页扩散。
  await vi.waitFor(()=>expect(s.isTabTransferring(2)).toBe(true));
  expect(s.isTabTransferring(1)).toBe(false);
  await expect(c.run(b,async()=>{await s.guardToolAccess('fill',b,2);})).rejects.toThrow(/正在移交/);
  expect((await s.getTabResource(2))?.conversationId).toBe('B');
  end();await running;await move;
  expect((await s.getTabResource(2))?.conversationId).toBe('A');
});

it('原会话正在由用户接管时，不移交页面',async()=>{
  const {s,a}=await setup();const {WorkerTabControl}=await import('../src/background/worker-tab-control.js');
  const c=new WorkerTabControl();
  await expect(c.manage({action:'claim',tabId:2,expectedConversationId:'B'},a,()=>{},async()=>{throw Error('页面现在归你');})).rejects.toThrow(/页面现在归你/);
  expect((await s.getTabResource(2))?.conversationId).toBe('B');
});

it('接手主 Agent 曾经使用的旧页，不停止它现在另一页的任务',async()=>{
  const {s,b}=await setup();await s.claimGlobalTab(2,b,'B');await s.setWorkingTab(3,b);
  const {WorkerTabControl}=await import('../src/background/worker-tab-control.js');const c=new WorkerTabControl();
  const info=await c.manage({action:'inspect',tabId:2},s.executionKey('A','main'));
  expect(info.members).toEqual([]);
});
