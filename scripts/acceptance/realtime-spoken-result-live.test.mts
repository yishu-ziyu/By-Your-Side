import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newTrace,isSettled,summarize,fixtureReceipt} from './realtime-spoken-result-live.mts';

function sample(id='S1') {
  const t=newTrace();
  t.judgments.push({type:'judgment',at:1,completedAt:2,judgment:{lane:'task',pageChange:0.9,spokenResult:id==='S1'?0.1:0.9}});
  for(const [n,action] of ['list','switch'].entries()){
    const rid=`r${n}`,callId=`c${n}`,at=10+n*10;
    t.outgoing.push({type:'response.create',at});
    t.provider.push({type:'response.created',response:{id:rid},at:at+1},{type:'response.done',response:{id:rid,output:[{type:'function_call'}]},at:at+2});
    t.client.push({type:'response_done',responseId:rid,at:at+2});
    t.tools.push({type:'tool',name:'tabs',callId,args:{action,tabId:8},at:at+1});
    t.outgoing.push({type:'conversation.item.create',item:{type:'function_call_output',call_id:callId,output:JSON.stringify(action==='switch'?{hostFeedback:{text:'切好了'}}:{})},at:at+3});
  }
  t.logs.push({type:'spoken_result_gate',at:24,callIds:['c1'],applied:id==='S1',reason:id==='S1'?'capsule_only':'spoken_result_needed'});
  return t;
}
function answer(t:ReturnType<typeof sample>,text='一加一等于二') {
  t.outgoing.push({type:'response.create',at:30});
  t.provider.push({type:'response.created',response:{id:'answer'},at:31},
    {type:'response.audio.delta',response_id:'answer',delta:'AAAA',at:32},
    {type:'response.done',response:{id:'answer'},at:34});
  t.client.push({type:'audio',responseId:'answer',data:'AAAA',at:32},
    {type:'transcript',role:'assistant',responseId:'answer',text,final:true,at:33},
    {type:'response_done',responseId:'answer',at:34});
}
test('zero data, unmatched response or tool is never settled',()=>{
  assert.equal(isSettled(newTrace()),false);
  const t=sample();assert.equal(isSettled(t),true);
  t.tools.push({type:'tool',callId:'pending',at:25});assert.equal(isSettled(t),false);
  t.tools.pop();t.provider.pop();assert.equal(isSettled(t),false);
});
test('pending judgment remains pending in recorder without changing production timing',()=>{
  const t=sample();t.judgments[0]!.completedAt=null;assert.equal(isSettled(t),false);
});
test('S1 two tool responses and no confirmation is a reduction success',()=>{
  const result=summarize('S1',sample(),'quiescent');
  assert.equal(result.status,'PASS');assert.equal(result.applied,true);assert.equal(result.continuationAfterSwitch,false);
  assert.equal(result.toolResponseCount,2);assert.equal(result.timely,true);
});
test('S1 fail-open is explicitly distinct from reduction success',()=>{
  const t=sample();t.logs[0]!.applied=false;t.logs[0]!.reason='judgment_unavailable';t.judgments[0]!.completedAt=50;answer(t,'切好了');
  const result=summarize('S1',t,'quiescent');assert.equal(result.status,'PASS');assert.equal(result.reduction,'not_applied');
  assert.equal(result.failOpenReason,'judgment_late_or_unavailable');assert.equal(result.timely,false);
});
test('S1 applied gate with a third response fails',()=>{
  const t=sample();answer(t,'切好了');assert.equal(summarize('S1',t,'quiescent').reason,'success_confirmation_generated');
});
test('S2 requires actual complete audio for the answer response',()=>{
  const t=sample('S2');answer(t);assert.equal(summarize('S2',t,'quiescent').status,'PASS');
  t.client.find(e=>e.type==='audio')!.data='BBBB';assert.equal(summarize('S2',t,'quiescent').reason,'audio_delivery_mismatch');
  t.provider=t.provider.filter(e=>e.type!=='response.audio.delta');t.client=t.client.filter(e=>e.type!=='audio');
  assert.equal(summarize('S2',t,'quiescent').reason,'spoken_answer_missing');
});
test('S3 must actually read snapshot and deliver the obstacle in audio',()=>{
  const t=sample('S3');answer(t,'需要先登录才能继续，要帮你处理吗？');
  assert.equal(summarize('S3',t,'quiescent').reason,'spoken_obstacle_missing');
  t.tools.push({type:'tool',name:'snapshot',callId:'snapshot',at:26});
  t.outgoing.push({type:'conversation.item.create',item:{type:'function_call_output',call_id:'snapshot',output:'{}'},at:27});
  assert.equal(summarize('S3',t,'quiescent').status,'PASS');
  assert.match(String(fixtureReceipt('S3','snapshot',{}).text),/登录/);
  assert.throws(()=>fixtureReceipt('S1','fill',{}));
});
test('timeout, disconnect and missing capsule do not pass',()=>{
  for(const reason of ['timeout','connection_closed','not_ready'])assert.equal(summarize('S1',sample(),reason).status,'FAIL');
  const t=sample();t.outgoing.find(e=>e.item?.call_id==='c1')!.item.output='{}';
  assert.equal(summarize('S1',t,'quiescent').reason,'success_capsule_missing');
});
