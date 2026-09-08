import {afterEach,expect,it,vi} from 'vitest';
import {requestMicrophonePermission,microphonePermissionState} from '../src/sidepanel/voice-permission.js';
afterEach(()=>vi.unstubAllGlobals());
it('requests only audio and releases every track immediately after permission succeeds',async()=>{
 const stop=vi.fn();const getUserMedia=vi.fn(async()=>({getTracks:()=>[{stop},{stop}]}));
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});
 await requestMicrophonePermission();
 expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({audio:true,video:false});expect(stop).toHaveBeenCalledTimes(2);
});
it('propagates denial rather than claiming a successful grant',async()=>{
 const failure=new DOMException('denied','NotAllowedError');
 await expect(requestMicrophonePermission(()=>Promise.reject(failure))).rejects.toBe(failure);
});
it('checking permission never requests audio and handles unavailable permissions API',async()=>{
 const getUserMedia=vi.fn();vi.stubGlobal('navigator',{permissions:{query:async()=>({state:'prompt'})},mediaDevices:{getUserMedia}});
 expect(await microphonePermissionState()).toBe('prompt');expect(getUserMedia).not.toHaveBeenCalled();
 vi.stubGlobal('navigator',{});expect(await microphonePermissionState()).toBe('unknown');
});
