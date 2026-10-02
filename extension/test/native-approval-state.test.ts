import {expect,it,vi} from 'vitest';
const send=vi.hoisted(()=>vi.fn());
vi.mock('../src/background/debugger.js',()=>({sendCommand:send}));
import {nativeApprovalState} from '../src/background/native-approval-state.js';
const fixture=(nodes:unknown,frames=['root'])=>{send.mockReset();send.mockResolvedValueOnce({frameTree:{frame:{id:'root'},childFrames:frames.slice(1).map(id=>({frame:{id}}))}}).mockResolvedValueOnce({strings:frames,documents:frames.map((_,frameId)=>({frameId,nodes}))});};
it('native backend identity and input values bind shadow targets',async()=>{fixture({backendNodeId:[17],inputValue:[1]});const old=await nativeApprovalState(1);fixture({backendNodeId:[18],inputValue:[1]});expect(await nativeApprovalState(1)).not.toBe(old);fixture({backendNodeId:[17],inputValue:[2]});expect(await nativeApprovalState(1)).not.toBe(old);});
it('missing child document fails closed instead of granting a root-only hash',async()=>{send.mockReset();send.mockResolvedValueOnce({frameTree:{frame:{id:'root'},childFrames:[{frame:{id:'cross-origin-child'}}]}}).mockResolvedValueOnce({strings:['root'],documents:[{frameId:0,nodes:{}}]});await expect(nativeApprovalState(1)).rejects.toThrow('子框架');});
