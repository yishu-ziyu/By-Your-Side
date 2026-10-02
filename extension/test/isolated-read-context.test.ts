import {expect,it,vi} from 'vitest';
const send=vi.hoisted(()=>vi.fn());
vi.mock('../src/background/debugger.js',()=>({sendCommand:send}));
import {isolatedReadContext} from '../src/background/isolated-read-context.js';
it('resolves a named isolated world in the current frame without MAIN fallback',async()=>{
 send.mockReset();send.mockResolvedValueOnce({frameTree:{frame:{id:'frame-current'}}}).mockResolvedValueOnce({executionContextId:71});
 expect(await isolatedReadContext(1)).toBe(71);
 expect(send.mock.calls).toEqual([[1,'Page.getFrameTree'],[1,'Page.createIsolatedWorld',{frameId:'frame-current',worldName:'sideagent-trusted-read',grantUniveralAccess:false}]]);
});
it('does not read in MAIN when isolated context creation fails',async()=>{
 send.mockReset();send.mockResolvedValueOnce({frameTree:{frame:{id:'frame-current'}}}).mockResolvedValueOnce({});
 await expect(isolatedReadContext(1)).rejects.toThrow('隔离读取');
 expect(send.mock.calls.some(([,method])=>method==='Runtime.evaluate')).toBe(false);
});
