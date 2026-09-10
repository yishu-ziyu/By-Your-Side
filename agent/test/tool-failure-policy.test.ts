import {describe, expect, it, vi} from 'vitest';
import {RepeatedToolFailurePolicy} from '../src/tool-failure-policy.js';

function setup() {
  const handlers:Record<string,Function>={};
  const stopped=vi.fn(), abort=vi.fn();
  const policy=new RepeatedToolFailurePolicy(stopped);
  policy.extension()({on:(name:string,fn:Function)=>{handlers[name]=fn;}} as any);
  const result=(toolName:string,text:string,isError=true)=>handlers.tool_result!({toolName,isError,content:[{type:'text',text}]},{abort});
  return {policy,stopped,abort,result};
}
describe('repeated execution failure boundary',()=>{
  it('stops after three identical failures even with successful observations between them',()=>{
    const h=setup();
    h.result('mark','target rejected');h.result('snapshot','observed',false);
    h.result('mark','target rejected');expect(h.abort).not.toHaveBeenCalled();
    h.result('mark','target rejected');h.result('mark','target rejected');
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.stopped).toHaveBeenCalledWith({toolName:'mark',error:'target rejected',attempts:3});
  });
  it('allows a corrected error, successful retry, or new user request a fresh attempt',()=>{
    const h=setup();
    h.result('mark','A');h.result('mark','A');h.result('mark','B');
    h.result('mark','ok',false);h.result('mark','B');h.result('mark','B');
    expect(h.abort).not.toHaveBeenCalled();
    h.policy.reset();h.result('mark','B');h.result('mark','B');
    expect(h.abort).not.toHaveBeenCalled();h.result('mark','B');expect(h.abort).toHaveBeenCalledTimes(1);
  });
});
