// Boss-owned frozen-contract acceptance. Implementers must not edit.
import {describe,it,expect} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
import {parseServerMessage} from '../../shared/protocol.js';
import {isTaskProgressSnapshot} from '../../shared/voice.js';
const facts='内部工作记录：竹海工作坊活动邀请；星浦研究访谈邀请。仅读标题，未打开正文。';
const speech='竹海工作坊发来活动邀请，星浦研究发来访谈邀请。我目前只看了标题，还没打开正文。';
function harness(){const p=new TaskProgress('default',()=>100);p.request('看看最近邮件，先不打开正文');const runId=p.snapshot().runId!;const emit=(event:any,extra:any={})=>p.observe({type:'agent_event',conversationId:'default',runId,event,...extra});emit({kind:'agent_start'});const delivery=(extra:any={})=>({conversationId:'default',id:'delivery-one',runId,kind:'finding',text:speech,composedAt:100,status:'composed',...extra});return {p,runId,emit,delivery};}
describe('explicit user delivery boundary',()=>{
 it('retains raw evidence but does not label it a delivered answer',()=>{const h=harness();h.emit({kind:'text_delta',delta:facts});h.emit({kind:'agent_end'});const c:any=h.p.snapshot().conversationContext;expect(c.latestResult.text).toBe(facts);expect(c.latestDelivery??null).toBeNull();expect(c.recentTurns.some((t:any)=>t.role==='assistant'&&t.text===facts)).toBe(false);});
 it('accepts one explicit same-run delivery, deduplicates replay and retains independent facts',()=>{const h=harness();h.emit({kind:'text_delta',delta:facts});h.emit({kind:'user_delivery',delivery:h.delivery()});h.emit({kind:'user_delivery',delivery:h.delivery()});h.emit({kind:'agent_end'});const c:any=h.p.snapshot().conversationContext;expect(c.latestDelivery).toMatchObject({id:'delivery-one',text:speech,kind:'finding'});expect(c.latestResult.text).toBe(facts);expect(c.recentTurns.filter((t:any)=>t.role==='assistant'&&t.text===speech)).toHaveLength(1);});
 it('does not accept another worker, conversation or run as the lead delivery',()=>{const h=harness();for(const [record,extra] of [[h.delivery(),{sessionId:'worker-1'}],[h.delivery({conversationId:'other'}),{}],[h.delivery({runId:'stale-run'}),{}]])h.emit({kind:'user_delivery',delivery:record},extra);expect((h.p.snapshot().conversationContext as any).latestDelivery??null).toBeNull();});
 it('a new run cannot consume a late delivery from the completed one',()=>{const h=harness();const old=h.delivery();h.emit({kind:'agent_end'});h.p.request('新的地图任务');h.p.observe({type:'agent_event',conversationId:'default',runId:h.p.snapshot().runId,event:{kind:'user_delivery',delivery:old}} as any);expect((h.p.snapshot().conversationContext as any).latestDelivery??null).toBeNull();});
 it('ack is distinguishable from the result a task still owes',()=>{const h=harness();h.emit({kind:'user_delivery',delivery:h.delivery({kind:'ack',text:'收到，我先看标题。'})});const c:any=h.p.snapshot().conversationContext;expect(c.latestDelivery?.kind).toBe('ack');expect(c.latestResult).toBeNull();});
});
describe('delivery protocol',()=>{
 it('accepts a bounded explicit delivery record',()=>{const h=harness(),d=h.delivery();expect(parseServerMessage(JSON.stringify({type:'agent_event',conversationId:'default',event:{kind:'user_delivery',delivery:d}}))).not.toBeNull();expect(isTaskProgressSnapshot({...h.p.snapshot(),conversationContext:{recentTurns:[],latestResult:null,latestDelivery:d}})).toBe(true);});
 it.each([{text:''},{text:'x'.repeat(2001)},{id:''},{kind:'verified_success'},{status:'heard_by_human'},{runId:42},{composedAt:'yesterday'}])('rejects malformed delivery %j',(extra)=>{const h=harness(),d=h.delivery(extra);expect(parseServerMessage(JSON.stringify({type:'agent_event',conversationId:'default',event:{kind:'user_delivery',delivery:d}}))).toBeNull();expect(isTaskProgressSnapshot({...h.p.snapshot(),conversationContext:{recentTurns:[],latestResult:null,latestDelivery:d}})).toBe(false);});
 it('rejects a server record routed into another conversation',()=>{const h=harness();expect(parseServerMessage(JSON.stringify({type:'agent_event',conversationId:'other',event:{kind:'user_delivery',delivery:h.delivery()}}))).toBeNull();});
});

import {VoiceService} from '../src/voice-service.js';
import {progressSpeech,receiptSpeech} from '../src/voice-receipt.js';
it('old finding cannot override pause, abort or error status',()=>{
 const h=harness();for(const [state,word] of [['paused','暂停'],['aborted','终止'],['error','问题']]){
  const snapshot:any={...h.p.snapshot(),state,conversationContext:{recentTurns:[],latestResult:{runId:h.runId,text:facts,observedAt:100,source:'assistant_output'},latestDelivery:h.delivery()}};
  expect(progressSpeech(snapshot)).toContain(word);
  expect(receiptSpeech({kind:'none',resumeReadOnly:'status',snapshot,spokenText:progressSpeech(snapshot)})).toContain(word);
 }
});
it('delivery identity drives one result announcement, not status or duplicate events',async()=>{
 const h=harness();let current:any={...h.p.snapshot(),state:'idle',conversationContext:{recentTurns:[],latestResult:{runId:h.runId,text:facts,observedAt:100,source:'assistant_output'},latestDelivery:null}};
 const notified:any[]=[];const service=new VoiceService(()=>current,()=>{},async()=> 'synthetic',()=>({start(){},command(){},close(){},notify(s:any){notified.push(s);}} as any));
 try{
  await service.handle('default',{type:'voice',voiceId:'voice-first',command:{kind:'start'}});
  expect(notified).toHaveLength(0);current={...current,conversationContext:{...current.conversationContext,latestDelivery:h.delivery()}};
  const event:any={type:'agent_event',conversationId:'default',event:{kind:'user_delivery',delivery:h.delivery()}};
  service.observe(event);service.observe(event);expect(notified).toHaveLength(1);
  current={...current,conversationContext:{...current.conversationContext,latestDelivery:h.delivery({status:'played'})}};service.observe({...event,event:{kind:'user_delivery',delivery:current.conversationContext.latestDelivery}});expect(notified).toHaveLength(1);
  await service.handle('default',{type:'voice',voiceId:'voice-first',command:{kind:'stop'}});await service.handle('default',{type:'voice',voiceId:'voice-second',command:{kind:'start'}});expect(notified).toHaveLength(1);
 }finally{service.close();}
});
it('a finding composed before agent_end is announced once when execution becomes idle',async()=>{
 const h=harness();let current:any={...h.p.snapshot(),state:'running',conversationContext:{recentTurns:[],latestResult:null,latestDelivery:null}};
 const notifications:any[]=[];const service=new VoiceService(()=>current,()=>{},async()=> 'synthetic',()=>({start(){},command(){},close(){},notify(s:any){notifications.push(s);}} as any));
 try{await service.handle('default',{type:'voice',voiceId:'voice-running',command:{kind:'start'}});current={...current,conversationContext:{...current.conversationContext,latestDelivery:h.delivery()}};service.observe({type:'agent_event',conversationId:'default',event:{kind:'user_delivery',delivery:h.delivery()}} as any);current={...current,state:'idle',conversationContext:{...current.conversationContext,latestResult:{runId:h.runId,text:facts,observedAt:101,source:'assistant_output'}}};service.observe({type:'status',conversationId:'default',state:'idle'});service.observe({type:'agent_event',conversationId:'default',event:{kind:'agent_end'}});expect(notifications).toHaveLength(1);expect(notifications[0].conversationContext.latestDelivery.id).toBe('delivery-one');}finally{service.close();}
});
