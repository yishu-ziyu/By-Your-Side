import { describe, it, expect, vi } from 'vitest';
import { ReadingRequests } from '../src/reading.js';
import { parseClientMessage, parseServerMessage } from '../../shared/protocol.js';
import type { ReadingEvent, ReadingTranscript } from '../../shared/reading.js';
import { ConversationManager } from '../src/conversation-manager.js';

const transcript = (threadId = 'reading-a'): ReadingTranscript => ({threadId, source:{text:'const n = 3;\n  return n;', surrounding:'A nearby explanation', truncated:false, tabId:1, title:'Article', url:'https://example.com'},turns:[{question:'解释',answer:'',state:'pending'}]});

const deferred = () => {let resolve!: (s: string) => void; const promise = new Promise<string>(r => resolve=r);

 return {promise,resolve};};

describe('reading identity and cancellation', () => {
  it('replacement ignores late output and completion from the old generation', async () => {
    const service = new ReadingRequests(), events: ReadingEvent[] = [];
    const a = deferred(), b = deferred();
    let late!: (text:string)=>void;

    const old = service.run('old', transcript(), async (_t,_s,onText) => {late=onText;onText('old partial');

return a.promise;}, e => events.push(e));

    const next = service.run('new', transcript(), async (_t,_s,onText) => {onText('new partial');

return b.promise;}, e => events.push(e));

    late('old late'); a.resolve('old final'); await old;
    b.resolve('new final'); await next;
    expect(events.filter(e=>e.requestId==='old').map(e=>e.text)).toEqual(['','old partial']);
    expect(events.at(-1)).toMatchObject({requestId:'new',state:'done',text:'new final'});
  });
  it('stop is scoped to both thread and request; other pages finish normally', async () => {
    const service=new ReadingRequests(), events:ReadingEvent[]=[]; const a=deferred(),b=deferred();
    let signal!:AbortSignal;

    const first=service.run('r1',transcript('a'),async(_t,s,onText)=>{signal=s;onText('kept');await new Promise((resolve,reject)=>{s.addEventListener('abort',()=>reject(new Error('cancel')));void a.promise.then(resolve);});

return 'done';},e=>events.push(e));

    const second=service.run('r2',transcript('b'),async()=>b.promise,e=>events.push(e));
    service.cancel('a','wrong');expect(signal.aborted).toBe(false);
    service.cancel('a','r1');await first;b.resolve('second answer');await second;
    expect(events.find(e=>e.state==='stopped')).toMatchObject({threadId:'a',text:'kept'});
    expect(events.at(-1)).toMatchObject({threadId:'b',state:'done',text:'second answer'});
  });
  it('failure preserves partial text and duplicate in-flight request does not generate twice', async () => {
    const service=new ReadingRequests(), events:ReadingEvent[]=[]; const wait=deferred();
    const generate=vi.fn(async(_t,_s,onText)=>{onText('partial');await wait.promise;throw Error('network');});
    const first=service.run('same',transcript(),generate,e=>events.push(e));
    await service.run('same',transcript(),generate,e=>events.push(e));
    wait.resolve('');await first;
    expect(generate).toHaveBeenCalledTimes(1);expect(events.at(-1)).toMatchObject({state:'error',text:'partial'});
  });
});

it('wire validation rejects oversized or malformed transcripts and accepts exact whitespace',()=>{
  const request={type:'reading_request',requestId:'r',transcript:transcript()};
  expect(parseClientMessage(JSON.stringify(request))).toEqual(request);
  expect(parseClientMessage(JSON.stringify({...request,transcript:{...transcript(),turns:[]}}))).toBeNull();
  expect(parseClientMessage(JSON.stringify({...request,transcript:{...transcript(),source:{...transcript().source,text:'x'.repeat(8001)}}}))).toBeNull();
  expect(parseClientMessage(JSON.stringify({type:'conversation_create',requestId:'r',reading:{}}))).toBeNull();
  expect(parseServerMessage(JSON.stringify({type:'reading_event',threadId:'a',requestId:'r',state:'done',text:'ok'}))).not.toBeNull();
  expect(parseServerMessage(JSON.stringify({type:'reading_event',threadId:'a',requestId:'r',state:'tool',text:'ok'}))).toBeNull();
});

it('reading and handoff do not send, steer or abort the main task, and transfer imports only once', async()=>{
  const events:any[]=[];const runtimes:any[]=[];

  const factory=vi.fn(async()=>{const runtime={session:{modelName:()=> 'test/model', answerReading:vi.fn(async(t:ReadingTranscript,_s:AbortSignal,onText:(s:string)=>void)=>{expect(t.turns[0]?.question).toBe('解释');onText('answer');

return 'answer';}),importReading:vi.fn(async()=>{}),startTask:vi.fn(),abort:vi.fn()},fleet:{teamView:()=>null},handleMessage:vi.fn()};

runtimes.push(runtime);

return runtime;});

  const manager=new ConversationManager(factory as never,e=>events.push(e));await manager.ensureDefault();
  await manager.handleMessage({type:'reading_request',requestId:'r',transcript:transcript()});
  expect(runtimes[0].handleMessage).not.toHaveBeenCalled();expect(runtimes[0].session.startTask).not.toHaveBeenCalled();expect(runtimes[0].session.abort).not.toHaveBeenCalled();
  const saved=transcript();saved.turns[0]={question:'解释',answer:'answer',state:'done'};
  await manager.handleMessage({type:'conversation_create',requestId:'transfer',reading:saved});
  await manager.handleMessage({type:'conversation_create',requestId:'transfer',reading:saved});
  expect(runtimes[1].session.importReading).toHaveBeenCalledExactlyOnceWith(saved);
  expect(runtimes[1].session.startTask).not.toHaveBeenCalled();
  expect(events.filter(e=>e.type==='reading_event').at(-1)).toMatchObject({state:'done',text:'answer'});
});

it('handoff survives restart before any sidebar assistant response, without synthesizing one',async()=>{
  const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {ConversationStore}=await import('../src/conversation-store.js');
  const directory=mkdtempSync(join(tmpdir(),'reading-store-test-'));

  try {
    const store=new ConversationStore(directory);store.sessionManager('handoff');
    const reading=transcript();reading.turns[0]={question:'我的实验别名是什么',answer:'蓝桉四十七',state:'done'};
    store.saveReading('handoff',reading);
    const restored=new ConversationStore(directory).sessionManager('handoff').getBranch();
    const entry=restored.find(e=>e.type==='custom_message'&&e.customType==='reading-handoff');
    expect(entry).toBeDefined();expect(JSON.stringify(entry)).toContain('蓝桉四十七');
    expect(restored.filter(e=>e.type==='message')).toHaveLength(0);
  }finally {rmSync(directory,{recursive:true,force:true});}
});
