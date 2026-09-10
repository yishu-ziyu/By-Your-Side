// Independent S1 contract: user outcomes/ownership are frozen in docs/evals/20260909-harness-capability-continuity.md.
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ConversationManager} from '../src/conversation-manager.js';
import type {ServerMessage} from '../../shared/protocol.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).forEach(fn=>fn()));
function setup(action='observe') {
 const messages:ServerMessage[]=[];let emit:(m:ServerMessage)=>void=()=>{};let streaming=false;let held=false;
 const startTask=vi.fn(()=>{streaming=true;emit({type:'agent_event',event:{kind:'agent_start',deliveryMode:'explicit'}});});
 const answerVoiceObservation=vi.fn(async()=> '我只能看页面，不能圈画。');
 const composeUserDelivery=vi.fn(async()=> '我不能在页面圈画。');
 const session:any={available:true,modelName:()=> 'fixture',isHeld:()=>held,isStreaming:()=>streaming, startTask,abort:vi.fn(),classifyVoiceInput:vi.fn(async()=>({steps:[{action,text:'ignored classifier paraphrase',target:null}]})),answerVoiceObservation,composeUserDelivery,bindDeliveryRun:vi.fn(),bindConversationContext:vi.fn()};
 const rpc={rejectAll:vi.fn(),call:vi.fn(async()=>({tabId:7,url:'https://fixture.test',title:'当前页面',text:'X对象',imageBase64:'AQ==',documentId:'doc-7',capturedAt:123,scope:'viewport'}))};
 const manager=new ConversationManager(async(_id,sink)=>{emit=sink;return {session,rpc,fleet:{teamView:()=>null,isGroupHeld:()=>held,reset:vi.fn(),abortTeam:vi.fn()},handleMessage:vi.fn(),dispose:()=>{}} as any;},m=>messages.push(m));cleanup.push(()=>manager.dispose());
 const route=(text:string,stillCurrent=()=>true)=>manager.routeVoiceInput('default',text,null,stillCurrent,{requestId:'request-one',voiceId:'voice-one',turn:1,runId:manager.getTaskProgress('default')?.runId??null,input:{context:{tabId:7,url:'https://fixture.test',title:'当前页面'},observation:{token:'test-grant',tabId:7}}});
 return {manager,session,rpc,messages,route,emit:(event:any)=>emit({type:'agent_event',event}),held:()=>{held=true;},finish:()=>{streaming=false;emit({type:'agent_event',event:{kind:'agent_end'}});}};
}
describe('S1: ordinary voice reaches the capable execution session',()=>{
 for(const action of ['observe','chat','steer'])it(`an idle ${action} classification cannot trap a request in a tool-less answer`,async()=>{
  const h=setup(action);await h.manager.ensureDefault();const text=action==='observe'?'找到当前页的X并圈出来。':'你可以圈出来的。';
  const result:any=await h.route(text);
  expect(h.session.startTask).toHaveBeenCalledTimes(1);
  expect(h.session.startTask.mock.calls[0][0]).toBe(text);
  expect(h.session.answerVoiceObservation).not.toHaveBeenCalled();expect(h.session.composeUserDelivery).not.toHaveBeenCalled();
  expect(result).toMatchObject({kind:'action',ok:true,awaitDelivery:true});
  expect(h.manager.getTaskProgress('default')!.goal).toBe(text);
 });
 it('does not execute a stale voice request',async()=>{const h=setup();await h.manager.ensureDefault();await h.route('圈出来',()=>false).catch(()=>{});expect(h.session.startTask).not.toHaveBeenCalled();});
 it('a held conversation does not start browser work through the new entry',async()=>{const h=setup();await h.manager.ensureDefault();h.held();await h.route('圈出来').catch(()=>{});expect(h.session.startTask).not.toHaveBeenCalled();});
 it('binds the same conversation context to its real execution session',async()=>{const h=setup();await h.manager.ensureDefault();expect(h.session.bindConversationContext).toHaveBeenCalledTimes(1);});
 it('does not replay an already accepted ordinary voice request',async()=>{const h=setup('chat');await h.manager.ensureDefault();await h.route('帮我标出X');await h.route('帮我标出X');expect(h.session.startTask).toHaveBeenCalledTimes(1);});
 it('speech/display lifecycle cannot independently verify a task outcome',async()=>{const h=setup('chat');await h.manager.ensureDefault();await h.route('标出X');const runId=h.manager.getTaskProgress('default')!.runId!;h.emit({kind:'user_delivery',delivery:{conversationId:'default',runId,id:'d',kind:'finding',text:'已找到X。',composedAt:123,status:'composed'}});h.finish();h.manager.markDeliveryPlayback('default','d','played');expect(h.manager.getTaskProgress('default')!.successVerified).toBe(false);});
});
