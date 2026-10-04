import {describe, expect, it, vi} from 'vitest';
import {RepeatedToolFailurePolicy} from '../src/tool-failure-policy.js';

function setup(skip?:(toolCallId:string)=>boolean) {
  const handlers:Record<string,Function>={};
  const stopped=vi.fn(), abort=vi.fn();
  const policy=new RepeatedToolFailurePolicy(stopped,undefined,skip);
  policy.extension()({on:(name:string,fn:Function)=>{handlers[name]=fn;}} as any);
  const result=(toolName:string,text:string,isError=true,url?:string,toolCallId='call')=>handlers.tool_result!({toolCallId,toolName,isError,input:url?{url}:{},content:[{type:'text',text}]},{abort});

  return {policy,stopped,abort,result};
}

describe('repeated execution failure boundary',()=>{
  it('does not count a refused repeat of an already-succeeded step (docs/evals/20261004-honest-completion.md R1)',()=>{
    const refused=new Set(['c2','c3','c4']);
    const h=setup(id=>refused.has(id));

    for(const id of refused)h.result('click','「点击「保存」」已有成功回执，不重复执行。请继续剩余步骤。',true,undefined,id);
    expect(h.abort).not.toHaveBeenCalled();

    // A genuine failure of the same operation is still counted.
    for(const id of ['f1','f2','f3'])h.result('click','target rejected',true,undefined,id);
    expect(h.stopped).toHaveBeenCalledWith({toolName:'click',error:'target rejected',attempts:3});
  });
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
  it('does not count the same refusal for different targets as retries (journeys C01)',()=>{
    const h=setup();
    const refused='fetch 拒绝本地/私网地址（127.0.0.1）';

    for(const path of ['/offer/a','/offer/b','/offer/c'])h.result('fetch',refused,true,`http://127.0.0.1:9/${path}`);
    expect(h.abort).not.toHaveBeenCalled();

    for(let i=0;i<2;i++)h.result('fetch',refused,true,'http://127.0.0.1:9//offer/a');

    expect(h.stopped).toHaveBeenCalledWith({toolName:'fetch',error:refused,attempts:3});
  });
});
