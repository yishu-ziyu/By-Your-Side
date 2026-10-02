import {describe, expect, it} from 'vitest';
import {ActivationConsent} from '../src/background/activation-consent.js';

describe('strict execution consent', () => {
  it('no approval means no grant; exact request may be approved once', async () => {
    const frames: any[] = [];
    const broker = new ActivationConsent(message => frames.push(message));
    const pending = broker.request({conversationId:'a',runId:'r',controlVersion:1,goal:'buy',tool:'click',target:'#buy',value:'{"target":"#buy"}'}, async () => 'same');
    expect(frames).toHaveLength(1);
    const id = frames[0].request.id;
    expect(broker.decide(id, false)).toBe(true);
    expect(await pending).toBe(false);
    expect(broker.decide(id, true)).toBe(false);
    const next = broker.request({conversationId:'a',runId:'r',controlVersion:1,goal:'buy',tool:'click',target:'#buy',value:'{"target":"#buy"}'}, async () => 'same');
    const nextId = frames.at(-1).request.id;
    expect(nextId).not.toBe(id);
    broker.decide(nextId, true);
    expect(await next).toBe(true);
    expect(broker.decide(nextId, true)).toBe(false);
  });
  it('context change and timeout fail closed', async () => {
    const frames: any[] = [];
    let context = 'original';
    const broker = new ActivationConsent(message => frames.push(message), 10);
    const input = {conversationId:'a',runId:'r',controlVersion:1,goal:'buy',tool:'click',target:'#buy',value:'{}',context:'original'};
    const pending = broker.request(input, async () => context);
    context = 'changed';
    broker.decide(frames[0].request.id, true);
    expect(await pending).toBe(false);
    expect(await broker.request(input, async () => 'same')).toBe(false);
  });
  it('new user instruction or disconnection cancels all approvals', async () => {
    const broker = new ActivationConsent(() => {});
    const pending = broker.request({conversationId:'a',runId:'r',controlVersion:1,goal:'buy',tool:'click',target:'#buy',value:'{}'}, async () => 'same');
    broker.cancel();
    expect(await pending).toBe(false);
  });
});

it('cancellation during context capture cannot resurrect an old request',async()=>{const frames:any[]=[];const broker=new ActivationConsent(message=>frames.push(message));const version=broker.version;broker.cancel();expect(await broker.request({conversationId:'a',runId:'r',controlVersion:1,goal:'buy',tool:'click',target:'#buy',value:'{}',cancellationVersion:version},async()=> 'same')).toBe(false);expect(frames).toHaveLength(0);});

it('denial during asynchronous approval validation wins and cannot be revived',async()=>{
  const frames:any[]=[];
  const broker=new ActivationConsent(message=>frames.push(message));
  let finishRead!:(context:string)=>void;
  const pending=broker.request({conversationId:'a',runId:'r',controlVersion:1,goal:'buy',tool:'click',target:'#buy',value:'{}'},()=>new Promise(resolve=>{finishRead=resolve;}));
  const id=frames[0].request.id;
  expect(broker.decide(id,true)).toBe(true);
  expect(broker.decide(id,false)).toBe(true);
  finishRead('same');
  expect(await pending).toBe(false);
  await Promise.resolve();
  expect(frames.filter(message=>message.type==='consent_result').map(message=>message.status)).toEqual(['cancelled']);
  expect(broker.decide(id,true)).toBe(false);
  expect(broker.list()).toEqual([]);
});

it('cancellation during asynchronous validation cannot grant after the context resolves',async()=>{
  const frames:any[]=[];
  const broker=new ActivationConsent(message=>frames.push(message));
  let finishRead!:(context:string)=>void;
  const pending=broker.request({conversationId:'a',runId:'r',controlVersion:1,goal:'buy',tool:'click',target:'#buy',value:'{}'},()=>new Promise(resolve=>{finishRead=resolve;}));
  const id=frames[0].request.id;
  broker.decide(id,true);
  broker.cancel();
  finishRead('same');
  expect(await pending).toBe(false);
  await Promise.resolve();
  expect(frames.filter(message=>message.type==='consent_result').map(message=>message.status)).toEqual(['cancelled']);
  expect(broker.decide(id,true)).toBe(false);
});
