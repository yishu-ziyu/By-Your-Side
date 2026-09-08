import { beforeEach, describe, expect, it, vi } from "vitest";
const wire = vi.hoisted(() => ({ callbacks: null as any, sent: [] as any[] }));
vi.mock("../src/background/uplink.js", () => ({ Uplink: class {
 constructor(callbacks: unknown) { wire.callbacks = callbacks; }
 start() {} retry() {} sendClientMessage(msg: unknown) { wire.sent.push(msg); return true; }
} }));
function event() { const listeners: Function[] = []; return {addListener: (f: Function) => listeners.push(f), emit: (...args: any[]) => [...listeners].forEach(f => f(...args))}; }
async function settle() { for (let i=0; i<12; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 110)); }
let storage: Record<string, any>;
let connect: ReturnType<typeof event>;
function panel() { const p = { name: "sideagent-panel", onMessage: event(), onDisconnect: event(), postMessage: vi.fn() }; connect.emit(p); return p; }
beforeEach(async () => {
 vi.resetModules(); wire.sent = []; storage = {}; connect = event();
 const area = {get: async (key: string | null) => key === null ? {...storage} : {[key]:storage[key]}, set: async (data: object) => {Object.assign(storage, data);} };
 vi.stubGlobal("chrome", {
  storage:{session:area,local:area},
  runtime:{onConnect:connect,onMessage:event(),onInstalled:event()},
  tabs:{onRemoved:event(),onUpdated:event(),onActivated:event(),query:async()=>[],sendMessage:async()=>{}},
  debugger:{onDetach:event()},
  contextMenus:{onClicked:event(),removeAll:(cb:Function)=>cb(),create:()=>{}},
  commands:{onCommand:event()}, sidePanel:{setPanelBehavior:async()=>{},open:async()=>{}}
 });
 await import("../src/background/index.js"); await settle();
});
const summary = (id: string) => ({id,title:id,createdAt:1,updatedAt:1,state:"idle",mode:"act"});
describe("background conversation isolation", () => {
 it("routes late events and preserves prior turns while another conversation is selected", async () => {
  const p = panel();
  wire.callbacks.onServerMessage({type:"conversation_created",requestId:"b",conversation:summary("B")}); await settle();
  p.onMessage.emit({kind:"client",msg:{type:"user_message",text:"B first",conversationId:"B"}}); await settle();
  p.onMessage.emit({kind:"select_conversation",conversationId:"default"});
  p.onMessage.emit({kind:"client",msg:{type:"user_message",text:"A first",conversationId:"default"}}); await settle();
  wire.callbacks.onServerMessage({type:"agent_event",conversationId:"B",event:{kind:"text_delta",text:"B late"}}); await settle();
  p.onMessage.emit({kind:"client",msg:{type:"user_message",text:"A second",conversationId:"default"}}); await settle();
  expect(storage["history:default"].filter((e:any)=>e.item.kind==="user").map((e:any)=>e.item.text)).toEqual(["A first","A second"]);
  expect(JSON.stringify(storage["history:default"])).not.toContain("B late");
  expect(JSON.stringify(storage["history:B"])).toContain("B late");
  expect(wire.sent.filter(m=>m.type==="user_message").map(m=>m.conversationId)).toEqual(["B","default","default"]);
 });
 it("reopening a panel synchronizes the chosen conversation without resetting another runtime", async () => {
  let p = panel();
  wire.callbacks.onServerMessage({type:"conversation_created",requestId:"b",conversation:summary("B")}); await settle();
  p.onMessage.emit({kind:"client",msg:{type:"user_message",text:"keep B",conversationId:"B"}}); await settle();
  wire.callbacks.onServerMessage({type:"status",conversationId:"default",state:"running"}); await settle();
  p.onDisconnect.emit(); p = panel();
  p.onMessage.emit({kind:"sync",conversationId:"B",afterSeq:0}); await settle();
  const messages = p.postMessage.mock.calls.map(c=>c[0]);
  expect(messages.some(m=>m.kind==="history" && m.conversationId==="B" && JSON.stringify(m).includes("keep B"))).toBe(true);
  expect(storage.selectedConversationId).toBe("B");
  expect(wire.sent.some(m=>m.type==="abort")).toBe(false);
 });
});

describe("control and worker restart boundaries", () => {
 it("aborting B leaves A's stored control, messages, and live status unchanged", async () => {
  const p = panel();
  wire.callbacks.onServerMessage({type:"conversation_created",requestId:"b",conversation:summary("B")}); await settle();
  wire.callbacks.onServerMessage({type:"status",conversationId:"default",state:"running"}); await settle();
  p.onMessage.emit({kind:"client",msg:{type:"user_message",conversationId:"default",text:"A still running"}}); await settle();
  const before = JSON.stringify(storage["history:default"]);
  p.onMessage.emit({kind:"client",msg:{type:"abort",conversationId:"B"}}); await settle();
  expect(JSON.stringify(storage["history:default"])).toBe(before);
  expect(wire.sent.filter(m=>m.type==="abort")).toEqual([{type:"abort",conversationId:"B"}]);
  wire.callbacks.onServerMessage({type:"agent_event",conversationId:"default",event:{kind:"text_delta",text:"A completed"}}); await settle();
  expect(JSON.stringify(storage["history:default"])).toContain("A completed");
 });
 it("rehydrates each persisted history after service-worker module recreation", async () => {
  let p = panel();
  wire.callbacks.onServerMessage({type:"conversation_created",requestId:"b",conversation:summary("B")}); await settle();
  p.onMessage.emit({kind:"client",msg:{type:"user_message",conversationId:"B",text:"persist B"}}); await settle();
  p.onDisconnect.emit();
  connect = event(); (globalThis as any).chrome.runtime.onConnect = connect;
  vi.resetModules(); await import("../src/background/index.js"); await settle();
  p = panel(); p.onMessage.emit({kind:"sync",conversationId:"B",afterSeq:0}); await settle();
  expect(p.postMessage.mock.calls.map(c=>c[0]).some(m=>m.kind==="history" && m.conversationId==="B" && JSON.stringify(m).includes("persist B"))).toBe(true);
 });
});

describe("persisted runtime mode recovery", () => {
 it("does not overwrite restored teach mode with empty extension storage during hello", async () => {
  const p = panel();
  wire.callbacks.onServerMessage({type:"hello_ok",version:2}); await settle();
  wire.callbacks.onServerMessage({type:"conversation_list",conversations:[{...summary("default"),mode:"teach"},summary("B")]}); await settle();
  p.onMessage.emit({kind:"sync",conversationId:"default",afterSeq:0}); await settle();
  expect(wire.sent.filter(m=>m.type==="set_mode")).toEqual([]);
  expect(storage.agentMode).toBe("teach");
  expect(storage["agentMode:B"]).toBe("act");
  expect(p.postMessage.mock.calls.map(c=>c[0]).filter(m=>m.kind==="mode" && m.conversationId==="default").at(-1)?.mode).toBe("teach");
 });
 it("keeps an explicit user mode change scoped and persistent after restoration", async () => {
  const p = panel();
  wire.callbacks.onServerMessage({type:"conversation_list",conversations:[{...summary("default"),mode:"teach"},summary("B")]}); await settle();
  p.onMessage.emit({kind:"client",msg:{type:"set_mode",conversationId:"B",mode:"teach"}}); await settle();
  expect(storage.agentMode).toBe("teach");
  expect(storage["agentMode:B"]).toBe("teach");
  expect(wire.sent.filter(m=>m.type==="set_mode")).toEqual([{type:"set_mode",conversationId:"B",mode:"teach"}]);
 });
});

describe("mode hydration ordering", () => {
 it("keeps a runtime mode update when an older empty storage read finishes later", async () => {
  const {getMode, setMode} = await import("../src/background/mode.js");
  const session = (globalThis as any).chrome.storage.session;
  const originalGet = session.get;
  let release!: (value: object) => void;
  session.get = (key: string) => key === "agentMode:slow" ? new Promise(resolve => {release=resolve;}) : originalGet(key);
  const pending = getMode("slow");
  await setMode("teach", "slow");
  release({});
  expect(await pending).toBe("teach");
  expect(await getMode("slow")).toBe("teach");
  session.get = originalGet;
 });
});

describe("memory receipts and management routing", () => {
 it("keeps delayed memory receipts in their source history and management replies out of history", async () => {
  const p = panel();
  wire.callbacks.onServerMessage({type:"conversation_created",requestId:"b",conversation:summary("B")}); await settle();
  p.onMessage.emit({kind:"client",msg:{type:"memory_list",requestId:"memory-b",conversationId:"B"}}); await settle();
  p.onMessage.emit({kind:"select_conversation",conversationId:"default"}); await settle();
  const entry = {id:"memory-1",version:1,text:"会议摘要三条",scope:{kind:"all"},sourceConversationId:"B",createdAt:1,updatedAt:1};
  wire.callbacks.onServerMessage({type:"agent_event",conversationId:"B",event:{kind:"memory",action:"used",entries:[entry]}});
  wire.callbacks.onServerMessage({type:"memory_result",conversationId:"B",requestId:"memory-b",action:"list",ok:true,entries:[entry]});
  await settle();
  expect(wire.sent.filter(m=>m.type==="memory_list")).toEqual([{type:"memory_list",requestId:"memory-b",conversationId:"B"}]);
  expect(JSON.stringify(storage["history:B"])).toContain('"action":"used"');
  expect(JSON.stringify(storage["history:B"])).not.toContain("memory_result");
  expect(JSON.stringify(storage["history:default"]??[])).not.toContain("会议摘要三条");
  expect(p.postMessage.mock.calls.some(([m])=>m.kind==="server"&&m.msg.type==="memory_result"&&m.conversationId==="B")).toBe(true);
  expect(wire.sent.some(m=>m.type==="abort")).toBe(false);
 });
});
