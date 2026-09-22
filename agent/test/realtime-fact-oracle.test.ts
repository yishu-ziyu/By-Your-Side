import {describe,expect,it} from 'vitest';
import {assessFactRun,finalReply,isPageRead,type FactEvent} from '../../scripts/acceptance/realtime-fact-oracle.mjs';
const event=(seq:number,channel:string,data:Record<string,unknown>):FactEvent=>({seq,at:seq*100,channel,data});
const created=(seq:number,id:string)=>event(seq,'provider-in',{type:'response.created',response:{id}});
const done=(seq:number,id:string,text:string,output:unknown[]=[])=>event(seq,'provider-in',{type:'response.done',response:{id,status:'completed',output:[{type:'message',content:[{transcript:text}]},...output]}});
const probe={value:'',writes:[],saved:0,submitted:0,deleted:0,code:'hidden'};
describe('Realtime fact-consumption collection boundaries',()=>{
 it('keeps a no-tool verbal success as an action failure and language unjudged',()=>{
  const result=assessFactRun('A',[created(1,'r1'),done(2,'r1','已经填写好了')],probe);
  expect(result.action).toBe('FAIL');expect(result.finalAnswer).toBe('CAPTURED');expect(result.language).toBe('NOT_JUDGED');
 });
 it('does not accept a tool response or preamble as final, even after the page changed',()=>{
  const events=[created(1,'r1'),done(2,'r1','我来填写',[{type:'function_call',call_id:'c1',name:'fill',arguments:'{}'}])];
  expect(finalReply(events)).toBeNull();
  const result=assessFactRun('A',events,{...probe,value:'星河',writes:['星河']});
  expect(result.finalAnswer).toBe('UNDETERMINED');expect(result.language).toBe('NOT_JUDGED');expect(result.postActionRead).toBe('FAIL');
 });
 it('requires sent output before a new completed response and preserves provider/host IDs',()=>{
  const events=[created(1,'r1'),done(2,'r1','',[{type:'function_call',call_id:'provider',name:'fill'}]),
   event(3,'provider-out',{item:{type:'function_call_output',call_id:'provider',output:JSON.stringify({toolCallId:'host',executionFact:'unknown'})}}),created(4,'r2')];
  expect(finalReply(events)).toBeNull();events.push(done(5,'r2','原调用没有确认回执。'));
  expect(finalReply(events)?.responseId).toBe('r2');
  expect(assessFactRun('C',events,probe).outputs[0]).toMatchObject({callId:'provider',result:{toolCallId:'host'}});
 });
 it('does not treat missing transcript, an active follow-up or a mere read call as completion',()=>{
  expect(finalReply([created(1,'r1'),done(2,'r1','')])?.complete).toBe(false);
  expect(finalReply([created(1,'r1'),done(2,'r1','答复'),created(3,'r2')])).toBeNull();
  expect(assessFactRun('A',[event(1,'direct-end',{name:'read_element',result:{ok:true,executionFact:'executed',content:[{text:'别的字段'}]}})],{...probe,value:'星河',writes:['星河']}).postActionRead).toBe('FAIL');
 });
});

it('read_page transport observe_page is covered by the read failure injector',()=>{
 expect(isPageRead('observe_page')).toBe(true);expect(isPageRead('snapshot')).toBe(true);
 expect(isPageRead('fill')).toBe(false);expect(isPageRead('get_active_tab')).toBe(false);
});
it('measures from the final VAD stop when a single synthetic utterance is segmented',()=>{
 const events=[event(1,'provider-in',{type:'input_audio_buffer.speech_stopped'}),event(2,'extension-out',{name:'observe_page'}),
  event(4,'provider-in',{type:'input_audio_buffer.speech_stopped'}),event(5,'extension-out',{name:'fill'})];
 const timing=assessFactRun('C',events,probe).timing;
 expect(timing.firstActionMs).toBe(100);expect(timing.firstToolMs).toBe(-200);
});
it('allows real alternative reading after an injected failure without calling language automatically correct',()=>{
 const events=[created(1,'r1'),done(2,'r1','',[{type:'function_call',call_id:'failed',name:'read_page'}]),
  event(3,'provider-out',{item:{type:'function_call_output',call_id:'failed',output:JSON.stringify({ok:false,error:'TEST_INJECTED_READ_FAILURE: first read unavailable'})}}),
  created(4,'r2'),done(5,'r2','',[{type:'function_call',call_id:'fresh',name:'read_element'}]),
  event(6,'provider-out',{item:{type:'function_call_output',call_id:'fresh',output:JSON.stringify({ok:true,executionFact:'executed',content:[{text:'核对码：琥珀-731'}]})}}),
  created(7,'r3'),done(8,'r3','核对码是琥珀-731')];
 const result=assessFactRun('D',events,probe);
 expect(result.scenarioCoverage).toBe('PASS');expect(result.action).toBe('PASS');expect(result.language).toBe('NOT_JUDGED');
});

// Compact existing event shapes; shared transport/host IDs make the positive
// fixture's correlation explicit. Original captures do not have this bridge.
function readbackFixture(value='星河') {
 const field={tabId:7,target:'@6',documentId:'doc',value,tagName:'input'};
 const result={ok:true,executionFact:'executed',toolCallId:'read',content:[{type:'text',text:`<page-content untrusted tab=7>\n${JSON.stringify(field)}\n</page-content>`}]};
 return [
  event(1,'provider-in',{type:'response.function_call_arguments.done',response_id:'wr',call_id:'pw',name:'fill',arguments:'{}'}),
  event(2,'direct-start',{callId:'pw',name:'fill',args:{target:'@6'}}),
  event(3,'extension-out',{type:'tool_call',id:'write',name:'fill',params:{tabId:7,target:'@6',documentId:'doc'}}),
  event(4,'extension-in',{type:'tool_result',id:'write',ok:true,executionFact:'executed',data:{filled:true}}),
  event(5,'direct-end',{callId:'pw',name:'fill',result:{ok:true,toolCallId:'write',executionFact:'executed'}}),
  event(6,'provider-out',{item:{type:'function_call_output',call_id:'pw',output:JSON.stringify({ok:true,toolCallId:'write',executionFact:'executed'})}}),
  event(7,'provider-in',{type:'response.function_call_arguments.done',response_id:'rr',call_id:'pr',name:'read_element',arguments:'{}'}),
  event(8,'direct-start',{callId:'pr',name:'read_element',args:{target:'@6'}}),
  event(9,'extension-out',{type:'tool_call',id:'read',name:'read_element',params:{tabId:7,target:'@6',documentId:'doc'}}),
  event(10,'extension-in',{type:'tool_result',id:'read',ok:true,executionFact:'executed',data:field}),
  event(11,'direct-end',{callId:'pr',name:'read_element',result}),
  event(12,'provider-out',{item:{type:'function_call_output',call_id:'pr',output:JSON.stringify(result)}}),
  created(13,'final'),done(14,'final','核查完毕'),
 ];
}
const row=(events:FactEvent[],seq:number)=>events.find(e=>e.seq===seq)!;
describe('correlated post-action readback',()=>{
 it.each(['tabId','target'] as const)('A: rejects another %s even with the expected text',key=>{
  const events=readbackFixture();row(events,9).data.params[key]=key==='tabId'?8:'@9';
  expect(assessFactRun('A',events,probe).postActionRead).toBe('FAIL');
 });
 it('B: rejects a pre-write read that returns late',()=>{
  const events=readbackFixture();row(events,8).seq=2.5;row(events,9).seq=3.5;
  expect(assessFactRun('A',events,probe).postActionRead).toBe('FAIL');
 });
 it.each(['missing','late'] as const)('C/D: %s output cannot support the final answer',mode=>{
  const events=readbackFixture().filter(e=>mode!=='missing'||e.seq!==12);
  if(mode==='late')row(events,12).seq=13.5;
  expect(assessFactRun('A',events,probe)).toMatchObject({postActionRead:'PASS',readEvidenceDelivered:'FAIL'});
 });
 it.each(['','别的值'])('E: valid reading %j is distinct from meeting the target',value=>{
  expect(assessFactRun('A',readbackFixture(value),probe)).toMatchObject({postActionRead:'PASS',readEvidenceDelivered:'PASS',readValueMatches:'FAIL'});
 });
 it('F: accepts a fully linked, timely observation',()=>{
  expect(assessFactRun('A',readbackFixture(),probe)).toMatchObject({postActionRead:'PASS',readEvidenceDelivered:'PASS',readValueMatches:'PASS'});
 });
});


describe('readback evidence gaps and mismatched calls',()=>{
 it.each(['document','tab','target','returned-tab','returned-target','value','truncated'] as const)('leaves missing %s evidence undetermined',kind=>{
  const events=readbackFixture();
  if(kind==='document')delete row(events,3).data.params.documentId;
  if(kind==='tab')delete row(events,9).data.params.tabId;
  if(kind==='target')delete row(events,9).data.params.target;
  if(kind==='returned-tab')delete row(events,10).data.data.tabId;
  if(kind==='returned-target')delete row(events,10).data.data.target;
  if(kind==='value')delete row(events,10).data.data.value;
  if(kind==='truncated')row(events,10).data.data.truncated=true;
  expect(assessFactRun('A',events,probe).postActionRead).toBe('UNDETERMINED');
 });
 it.each(['host-id','provider-id','redacted'] as const)('does not infer a missing %s link from identical text',kind=>{
  const events=readbackFixture();
  if(kind==='host-id')row(events,11).data.result.toolCallId='another-host';
  if(kind==='provider-id')row(events,11).data.callId='another-provider';
  if(kind==='redacted') {
   const item=row(events,12).data.item;
   item.output=item.output.replace('doc','[redacted]');
  }
  expect(assessFactRun('A',events,probe)).toMatchObject({postActionRead:'PASS',readEvidenceDelivered:'UNDETERMINED'});
 });
 it('does not count expected text in title or error as the field value',()=>{
  const events=readbackFixture('');row(events,10).data.data.title='星河';row(events,10).data.data.error='expected 星河';
  expect(assessFactRun('A',events,probe)).toMatchObject({postActionRead:'PASS',readValueMatches:'FAIL'});
 });
 it('rejects a failed receipt even when the host reports success',()=>{
  const events=readbackFixture();row(events,10).data.ok=false;
  expect(assessFactRun('A',events,probe).postActionRead).toBe('FAIL');
 });
 it('does not choose among conflicting results for one transport ID',()=>{
  const events=readbackFixture();events.push(event(10.5,'extension-in',{type:'tool_result',id:'read',ok:false}));
  expect(assessFactRun('A',events,probe).postActionRead).toBe('UNDETERMINED');
 });
 it('uses dispatch target despite later active-tab changes',()=>{
  const events=readbackFixture();events.push(event(9.5,'host',{message:{type:'active_tab',tabId:99}}));
  expect(assessFactRun('A',events,probe).postActionRead).toBe('PASS');
 });
 it('does not allow output after response.create but before response.created',()=>{
  const events=readbackFixture();events.push(event(11.5,'provider-out',{type:'response.create'}));
  expect(assessFactRun('A',events,probe).readEvidenceDelivered).toBe('FAIL');
 });
 it('does not count a host read started before the write as a fresh observation',()=>{
  const events=readbackFixture();row(events,8).seq=2.5;
  expect(assessFactRun('A',events,probe).postActionRead).toBe('FAIL');
 });
});
