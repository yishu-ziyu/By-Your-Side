/**
 * Ticket 5: voice display modifications must reuse the same runtime path as typed text.
 *
 * Classification is the only voice-specific step; dispatch, execution, run identity,
 * receipts and speech all come from the shared implementation. No microphone claims.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';

vi.mock('../src/display-fast-path.js',()=>({
  displayFastPathEnabled:()=>true,
  displaySteerFastPathEnabled:vi.fn(()=>true),
  decideDisplay:vi.fn(),
}));

vi.mock('../src/run-trace.js',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('../src/run-trace.js')>();

 return {...actual,RunTrace:class{begin(){}correlate(){}record(){}event(){}stage(){return{end(){}}}}};
});

import {decideDisplay} from '../src/display-fast-path.js';
import {receiptSpeech} from '../src/voice-receipt.js';
import {candidate,context,managerHarness} from './fixtures/display-steering-harness.js';
import type {ServerMessage} from '../../shared/protocol.js';

async function voiceHarness(){
 const base=await managerHarness();
 const {h,manager,emitted}=base;
 h.wrapper.canPrepareVoiceTurn=()=>false;
 h.wrapper.classifyVoiceInput=vi.fn(async(text:string)=>({steps:[{action:/停止|终止/.test(text)?'abort':'steer',text,target:null}]}));
 const progress=()=>manager.getTaskProgress('default')!;

 const route=(over:Record<string,unknown>={})=>({
  requestId:'voice-1',voiceId:'voice-a',turn:1,
  runId:progress().runId,controlVersion:progress().controlVersion??0,
  targets:manager.voiceTargets(),
  input:{context},
  ...over,
 } as never);

 return {...base,route,progress};
}

beforeEach(()=>{vi.mocked(decideDisplay).mockReset();});

describe('语音运行中显示修改',()=>{
 it('reuses the shared runtime path and speaks the verified page fact once',async()=>{
  const {h,manager,emitted,route}=await voiceHarness();
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  const result=await manager.routeVoiceInput('default','把译文改成宋体',null,()=>true,route());
  expect(result).toMatchObject({kind:'steer',ok:true,status:'applied'});
  expect(h.pageState.fontFamily).toBe('songti');
  expect(h.translationCalls).toHaveLength(1);
  expect(h.steers).toHaveLength(1);
  expect(h.steers[0]).toContain('译文已改成宋体');
  expect(receiptSpeech(result)).toContain('已直接应用并核对');
  const spoken=emitted.filter((message:ServerMessage)=>message.type==='agent_event'&&(message as never as {event:{kind:string;message?:string}}).event?.kind==='notice'&&String((message as never as {event:{message?:string}}).event.message).includes('已直接应用'));
  expect(spoken).toHaveLength(1);
  // 原任务保持运行；它自己的交付不被这条修改吞掉。
  expect(manager.getTaskProgress('default')!.state).toBe('running');
  (h.wrapper as any).callbacks.emit({kind:'user_delivery',delivery:{id:'finding-1',conversationId:'default',runId:manager.getTaskProgress('default')!.runId,kind:'finding',text:'原任务读完了。',createdAt:Date.now()}});
  expect(emitted.some((message:ServerMessage)=>message.type==='agent_event'&&(message as never as {event:{kind:string;delivery?:{text:string}}}).event?.kind==='user_delivery'&&(message as never as {event:{delivery:{text:string}}}).event.delivery.text==='原任务读完了。')).toBe(true);
 });

 it('produces the same page result for the same words through text and voice',async()=>{
  const typed=await managerHarness();
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  const typedReceipt=await typed.manager.dispatchTaskAction({requestId:'typed-1',conversationId:'default',source:'text',action:'steer',expectedRunId:typed.manager.getTaskProgress('default')!.runId??null,text:'把译文改成宋体',context});
  const voice=await voiceHarness();
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  const voiceResult=await voice.manager.routeVoiceInput('default','把译文改成宋体',null,()=>true,voice.route());
  expect(typedReceipt.status).toBe('applied');
  expect(voiceResult).toMatchObject({kind:'steer',status:'applied'});
  expect(voice.h.pageState).toEqual(typed.h.pageState);
  expect(voice.h.translationCalls).toHaveLength(typed.h.translationCalls.length);
 });

 it('keeps two consecutive voice requirements in order without extra confirmations',async()=>{
  const {h,manager,route}=await voiceHarness();
  vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({mode:'bilingual'}));
  const first=await manager.routeVoiceInput('default','切回双语',null,()=>true,route({requestId:'voice-1',turn:1}));
  vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({mode:'translated'}));
  const second=await manager.routeVoiceInput('default','还是只显示译文',null,()=>true,route({requestId:'voice-2',turn:2}));
  expect(first).toMatchObject({kind:'steer',status:'applied'});
  expect(second).toMatchObject({kind:'steer',status:'applied'});
  expect(h.pageState.mode).toBe('translated');
  expect(h.translationCalls).toHaveLength(2);
  expect(h.steers).toHaveLength(2);
 });

 it('replaying the same voice request does not change the page twice',async()=>{
  const {h,manager,route}=await voiceHarness();
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  const same=route();
  await manager.routeVoiceInput('default','把译文改成宋体',null,()=>true,same);
  await manager.routeVoiceInput('default','把译文改成宋体',null,()=>true,same);
  expect(h.translationCalls).toHaveLength(1);
  expect(h.steers).toHaveLength(1);
 });

 it('falls back to the model when the voice modification targets another page without translations',async()=>{
  const {h,manager,route}=await voiceHarness();
  const other={tabId:9,title:'别的页面',url:'https://fixture.test/b'};
  const original=h.rpc.call.getMockImplementation()!;
  h.rpc.call.mockImplementation(async(name:string,params:any,...rest:any[])=>{
   if(name==='snapshot'&&params?.tabId===9)return {text:'别的页面',tabId:9,translation:null};

   return original(name,params,...rest);
  });
  const result=await manager.routeVoiceInput('default','把译文改成宋体',null,()=>true,route({input:{context:other}}));
  expect(result).toMatchObject({kind:'steer',status:'accepted'});
  expect(h.translationCalls).toHaveLength(0);
  expect(h.steers[0]).toContain('把译文改成宋体');
  expect(h.steers[0]).toContain('tab 9');
 });

 it('keeps “别说了” silent without touching the page',async()=>{
  const {h,manager,route}=await voiceHarness();
  const result=await manager.routeVoiceInput('default','别说了',null,()=>true,route());
  expect(result).toMatchObject({kind:'silent',quiet:true});
  expect(h.translationCalls).toHaveLength(0);
  expect(h.steers).toHaveLength(0);
 });

 it('rejects an expired voice turn before any page write',async()=>{
  const {h,manager,route}=await voiceHarness();
  const confirmation=await manager.routeVoiceInput('default','停止任务',null,()=>true,route({requestId:'voice-abort',turn:1}));
  expect(confirmation).toMatchObject({kind:'clarify'});
  const expired=await manager.routeVoiceInput('default','把译文改成宋体',null,()=>true,route({requestId:'voice-late',turn:1}));
  expect(expired).toMatchObject({kind:'clarify',message:'这句回应已过期，当前待确认要求保持不变。'});
  expect(h.translationCalls).toHaveLength(0);
 });
});
