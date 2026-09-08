import {afterEach,expect,it,vi} from 'vitest';
import {TaskControlBroker} from '../src/task-control.js';
afterEach(()=>vi.useRealTimers());
it('waits for a matching final extension acknowledgement and ignores wrong/duplicate frames',async()=>{
 const emit=vi.fn(),broker=new TaskControlBroker(emit);let resolved=false;
 const p=broker.request('A','q','pause','run').then(r=>{resolved=true;return r;});
 expect(emit).toHaveBeenCalledWith({type:'task_control',conversationId:'A',requestId:'q',action:'pause',runId:'run'});
 expect(broker.permits('A','q','pause','run')).toBe(true);
 const frame={type:'task_control_result' as const,conversationId:'A',requestId:'q',action:'pause' as const,runId:'run',ok:true};
 expect(broker.receive({...frame,conversationId:'B'})).toBe(false);expect(broker.receive({...frame,runId:'old'})).toBe(false);
 await Promise.resolve();expect(resolved).toBe(false);
 expect(broker.receive(frame)).toBe(true);expect((await p).ok).toBe(true);expect(broker.receive(frame)).toBe(false);
});
it('invalidates expired and disconnected requests, preventing late control execution',async()=>{
 vi.useFakeTimers();const broker=new TaskControlBroker(()=>{},50);
 const p=broker.request('A','q','resume','run');const failed=expect(p).rejects.toThrow('timeout');
 await vi.advanceTimersByTimeAsync(51);await failed;expect(broker.permits('A','q','resume','run')).toBe(false);
 const second=broker.request('A','next','abort','run');const disconnected=expect(second).rejects.toThrow('disconnected');broker.disconnect();await disconnected;
});
