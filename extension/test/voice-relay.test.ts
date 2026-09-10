import { afterEach, expect, it, vi } from "vitest";
import { VoiceRelay } from "../src/background/voice-relay.js";

afterEach(()=>vi.unstubAllGlobals());
function panel() {
  let message: (m: any) => void = () => {}; let disconnected = () => {};
  const port = { postMessage: vi.fn(), onMessage: { addListener: (f: typeof message) => { message = f; } }, onDisconnect: { addListener: (f: typeof disconnected) => { disconnected = f; } } };
  return { port: port as unknown as chrome.runtime.Port, received: port.postMessage, send: (m: any) => message(m), close: () => disconnected() };
}
it("binds one panel and conversation; selection/disconnect stop only voice, never task", () => {
  const send = vi.fn((_msg: unknown) => true); let selected = "A";
  const relay = new VoiceRelay(send, () => selected); const a = panel(), b = panel();
  relay.attach(a.port); relay.attach(b.port);
  const start = { kind: "client", msg: { type: "voice", voiceId: "v1", conversationId: "A", command: { kind: "start" } } };
  a.send(start); a.send(start); expect(send).toHaveBeenCalledTimes(1);
  b.send({ ...start, msg: { ...start.msg, command: { kind: "stop" } } });
  expect(send).toHaveBeenCalledTimes(1);
  relay.server({ type: "voice", voiceId: "v1", conversationId: "A", event: { kind: "state", state: "ready" } });
  expect(a.received).toHaveBeenCalledTimes(1); expect(b.received).not.toHaveBeenCalled();
  selected = "B"; relay.selectionChanged(selected);
  expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ type: "voice", conversationId: "A", command: { kind: "stop" } });
  relay.server({ type: "voice", voiceId: "v1", conversationId: "A", event: { kind: "state", state: "ready" } });
  expect(a.received).toHaveBeenCalledTimes(2);
  a.close(); expect(send).toHaveBeenCalledTimes(2);
});

it('snapshots committed context and drops a late commit after a new turn or selection',async()=>{
 vi.stubGlobal('chrome',{tabs:{query:vi.fn(async()=>[])}});
 const send=vi.fn((_message:unknown)=>true);let finish!:(v:any)=>void;
 const enrich=vi.fn(()=>new Promise<any>(r=>finish=r));
 const relay=new VoiceRelay(send,()=> 'A',enrich),p=panel();relay.attach(p.port);
 const command=(command:any)=>p.send({kind:'client',msg:{type:'voice',voiceId:'v1',conversationId:'A',command}});
 command({kind:'start'});command({kind:'interrupt',turn:1});command({kind:'commit',turn:1,input:{context:{tabId:1,title:'source',url:'https://example.com',selection:{text:'selected'}}}});
 command({kind:'interrupt',turn:2});finish({context:{tabId:1,title:'old',url:'https://example.com'}});await new Promise(r=>setTimeout(r,0));
 expect(send.mock.calls.some(([m]:any)=>m.command.kind==='commit')).toBe(false);
 command({kind:'commit',turn:2,input:{}});finish({context:{tabId:2,title:'fresh',url:'https://example.com/fresh'}});await new Promise(r=>setTimeout(r,0));
 expect(send.mock.calls.at(-1)?.[0]).toMatchObject({command:{kind:'commit',turn:2,input:{context:{tabId:2}}}});
 command({kind:'interrupt',turn:3});command({kind:'commit',turn:3});relay.selectionChanged('B');finish({});await new Promise(r=>setTimeout(r,0));
 expect(send.mock.calls.filter(([m]:any)=>m.command.kind==='commit')).toHaveLength(1);
});
it('invalidates page grants when a closed voice lease is replaced in the same conversation',async()=>{
 vi.stubGlobal('chrome',{tabs:{query:vi.fn(async()=>[{id:7,windowId:1,url:'https://page.test'}]),captureVisibleTab:vi.fn(async()=> 'data:image/png;base64,AQID')},scripting:{executeScript:vi.fn(async()=>[{frameId:0,documentId:'doc1',result:{text:'page',url:'https://page.test'}}])}});
 const send=vi.fn((_message:unknown)=>true),relay=new VoiceRelay(send,()=> 'A',async(_id,input)=>input),p=panel();relay.attach(p.port);
 const command=(voiceId:string,command:any)=>p.send({kind:'client',msg:{type:'voice',voiceId,conversationId:'A',command}});
 command('v1',{kind:'start'});command('v1',{kind:'interrupt',turn:1});command('v1',{kind:'commit',turn:1});await new Promise(r=>setTimeout(r,0));
 const sent=send.mock.calls.map(([m])=>m as any).find(m=>m.command.kind==='commit'),token=sent.command.input.observation.token;
 relay.server({type:'voice',voiceId:'v1',conversationId:'A',event:{kind:'state',state:'closed'}});command('v2',{kind:'start'});
 await expect(relay.observe('A',token)).rejects.toThrow('授权');
});
