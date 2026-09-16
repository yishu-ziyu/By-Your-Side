import {afterEach, beforeEach, expect, it, vi, type Mock} from 'vitest';
import type { ClientMessage } from '../../shared/protocol.js';
import {installReading} from '../src/background/reading.js';
import type {ReadingSource} from '../../shared/reading.js';

let listener: (raw:any,sender:any,reply:(v:any)=>void)=>unknown;
let service: ReturnType<typeof installReading>;
let send: Mock<(message: ClientMessage) => boolean>;
const source:ReadingSource={text:'line 1\n  line 2',surrounding:'context',truncated:false,tabId:1,title:'page',url:'https://example.com/a'};
const sender={tab:{id:1,title:'page',url:source.url},url:source.url,documentId:'document-a',frameId:0};
const message=(raw:any,who=sender)=>new Promise<any>(resolve=>listener(raw,who,resolve));
beforeEach(()=>{
  vi.useFakeTimers();send=vi.fn(()=>true);
  vi.stubGlobal('chrome',{storage:{session:{get:vi.fn(async()=>({})),set:vi.fn(async()=>{})}},runtime:{onMessage:{addListener:(fn:any)=>listener=fn}},tabs:{sendMessage:vi.fn(async()=>{}),onRemoved:{addListener:vi.fn()},onUpdated:{addListener:vi.fn()}},sidePanel:{open:vi.fn(async()=>{})}});
  service=installReading({send,selected:()=> 'main-task',import:vi.fn(async()=>{}),select:vi.fn()});
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

it('routes only reading requests and rejects other documents using the same tab or thread',async()=>{
  const {record}=await message({type:'reading_open',source});
  const sent=await message({type:'reading_send',threadId:record.threadId,question:'解释'});
  expect(sent.ok).toBe(true);expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'reading_request',conversationId:'main-task'}));
  expect((await message({type:'reading_stop',threadId:record.threadId},{...sender,documentId:'different-document'})).ok).toBe(false);
  expect((await message({type:'reading_get',threadId:record.threadId},{...sender,tab:{...sender.tab,id:2}})).record).toBeUndefined();
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type:'steer'}));
});

it('stop freezes partial text; an offline retry retains it',async()=>{
  let {record}=await message({type:'reading_open',source});
  ({record}=await message({type:'reading_send',threadId:record.threadId,question:'解释'}));
  service.receive({type:'reading_event',threadId:record.threadId,requestId:record.requestId,state:'streaming',text:'保留这段'});
  await Promise.resolve();await message({type:'reading_stop',threadId:record.threadId});
  service.receive({type:'reading_event',threadId:record.threadId,requestId:record.requestId,state:'done',text:'迟到回答'});
  await Promise.resolve();
  expect((await message({type:'reading_get',threadId:record.threadId})).record.turns[0]).toMatchObject({state:'stopped',answer:'保留这段'});
  send.mockReturnValue(false);
  const retried=await message({type:'reading_send',threadId:record.threadId,question:'解释',retry:true});
  expect(retried.record.turns).toHaveLength(1);
  expect(retried.record.turns[0]).toMatchObject({state:'error',answer:'保留这段'});
  send.mockReturnValue(true);
  expect((await message({type:'reading_send',threadId:record.threadId,question:'解释'})).record.turns).toHaveLength(1);
});

it('SPA departure cancels by document identity even though the URL already changed',async()=>{
  let {record}=await message({type:'reading_open',source});
  ({record}=await message({type:'reading_send',threadId:record.threadId,question:'解释'}));
  await message({type:'reading_leave',threadId:record.threadId},{...sender,url:'https://example.com/b'});
  expect(send).toHaveBeenLastCalledWith({type:'reading_cancel',threadId:record.threadId,requestId:record.requestId});
});

it('opening reading bypasses fresh-session boot only for the handoff, and backend failure is visible',async()=>{
  const {record}=await message({type:'reading_open',source});
  const handoff=await message({type:'reading_handoff',threadId:record.threadId});
  expect(service.resumeOnOpen('main-task')).toBe(true);
  service.receive({type:'reading_event',threadId:record.threadId,requestId:handoff.record.handoffRequestId,state:'error',text:'',error:'导入失败'});
  await Promise.resolve();
  expect(service.resumeOnOpen('main-task')).toBe(false);
  expect((await message({type:'reading_get',threadId:record.threadId})).record.handoffError).toBe('导入失败');
});

it('returning to an existing selection also stops another reading that is still streaming',async()=>{
  const first=await message({type:'reading_open',source});
  const second=await message({type:'reading_open',source:{...source,text:'另一段文字'}});
  const running=await message({type:'reading_send',threadId:second.record.threadId,question:'解释'});
  const returned=await message({type:'reading_open',source});
  expect(returned.record.threadId).toBe(first.record.threadId);
  expect(send).toHaveBeenLastCalledWith({type:'reading_cancel',threadId:second.record.threadId,requestId:running.record.requestId});
});
