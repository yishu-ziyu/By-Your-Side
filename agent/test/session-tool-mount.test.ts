import { expect, it, vi } from 'vitest';
import { BrowserAgentSession } from '../src/session.js';

vi.mock('../src/run-trace.js', () => ({ RunTrace: class { begin() {} correlate() {} record() {} event() {} stage() { return { end() {} }; } } }));

it('团队工具切换不能重新启用SDK目录中被禁用的本地工具', () => {
  const permitted = ['snapshot', 'fill', 'spawn_worker', 'take_tab', 'post', 'await_message', 'list_workers', 'stop_worker', 'page_operation'];
  let active = [...permitted];
  const raw = {
    getAllTools: () => [...permitted, 'bash', 'read', 'edit', 'write', 'powershell'].map(name => ({ name })),
    getActiveToolNames: () => [...active],
    setActiveToolsByName: vi.fn((names: string[]) => { active = [...names]; }),
  };
  const Constructor = BrowserAgentSession as unknown as new (...args: any[]) => BrowserAgentSession;
  const session = new Constructor(raw, null, { emit() {}, setStatus() {} }, null, null);
  for (const mounted of [false, true, false, true]) {
    session.setTeamToolsMounted(mounted);
    expect(active.filter(name => !permitted.includes(name))).toEqual([]);
    expect(active).toContain('fill');
    expect(active).toContain('spawn_worker');
    expect(active.includes('page_operation')).toBe(mounted);
    expect(session.isToolHiddenByMode('page_operation')).toBe(!mounted);
    expect(session.isToolHiddenByMode('bash')).toBe(false);
    expect(active.includes('post')).toBe(mounted);
  }
});

it('a tool excluded from initial permission is not treated as a mode-hidden capability', () => {
  let active = ['fill','snapshot'];
  const raw = {getActiveToolNames:()=>active, setActiveToolsByName:(names:string[])=>{active=names;}};
  const Constructor=BrowserAgentSession as unknown as new (...args:any[])=>BrowserAgentSession;
  const session=new Constructor(raw,null,{emit(){},setStatus(){}},null,null);
  session.setTeamToolsMounted(false);
  expect(session.isToolHiddenByMode('page_operation')).toBe(false);
});
