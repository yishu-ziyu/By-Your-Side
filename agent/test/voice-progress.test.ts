import { describe, expect, it } from "vitest";
import { TaskProgress } from "../src/task-progress.js";
import { progressSpeech } from "../src/voice-receipt.js";
import { parseClientMessage, parseServerMessage } from "../../shared/protocol.js";

describe("task progress facts", () => {
  it('uses unique run identities even within one millisecond and preserves identity across pause',()=>{
    const p=new TaskProgress('A',()=>123);
    p.request('first');p.observe({type:'agent_event',event:{kind:'agent_start'}});const first=p.snapshot().runId;
    p.observe({type:'status',state:'user'});p.observe({type:'status',state:'running'});expect(p.snapshot().runId).toBe(first);
    p.observe({type:'agent_event',event:{kind:'agent_end'}});p.request('second');p.observe({type:'agent_event',event:{kind:'agent_start'}});
    expect(p.snapshot().startedAt).toBe(123);expect(p.snapshot().runId).not.toBe(first);
  });
  it("records actual tool state and never promotes idle/agent_end to verified success", () => {
    let now = 100;
    const p = new TaskProgress("A", () => now);
    expect(p.snapshot().state).toBe("none");
    p.request("找书桌");
    p.observe({ type: "agent_event", event: { kind: "agent_start" } });
    now = 200;
    p.observe({ type: "agent_event", event: { kind: "tool_start", toolCallId: "t1", name: "snapshot", params: { secret: "do not include params" } } });
    expect(p.snapshot()).toMatchObject({ state: "running", startedAt: 100, active: [{ action: "读取页面", since: 200 }] });
    expect(JSON.stringify(p.snapshot())).not.toContain("do not include");
    p.observe({ type: "agent_event", event: { kind: "tool_end", toolCallId: "t1", name: "snapshot", isError: false, resultText: "page content must not be sent" } });
    p.observe({ type: "agent_event", event: { kind: "agent_end" } });
    expect(p.snapshot()).toMatchObject({ state: "idle", active: [], successVerified: false });
  });
  it("separates workers, paused, aborted and new runs", () => {
    const p = new TaskProgress("A");
    p.request("A goal");
    p.observe({ type: "agent_event", event: { kind: "agent_start" } });
    p.observe({ type: "agent_event", sessionId: "worker", event: { kind: "agent_start" } });
    p.observe({ type: "agent_event", event: { kind: "agent_end" } });
    expect(p.snapshot().state).toBe("running");
    p.observe({ type: "status", sessionId: "worker", state: "user" });
    expect(p.snapshot().state).toBe("paused");
    p.abort();
    p.observe({ type: "agent_event", sessionId: "worker", event: { kind: "agent_end" } });
    expect(p.snapshot().state).toBe("aborted");
    p.request("B goal");
    p.observe({ type: "agent_event", event: { kind: "agent_start" } });
    expect(p.snapshot()).toMatchObject({ goal: "B goal", state: "running" });
  });
});
describe("bounded voice protocol", () => {
  it("rejects malformed audio, unknown commands, foreign identity and forged facts", () => {
    const m = { type: "voice", conversationId: "A", voiceId: "voice-1", command: { kind: "audio", turn: 1, data: "AAAA" } };
    expect(parseClientMessage(JSON.stringify(m))).not.toBeNull();
    for (const command of [{ kind: "audio", turn: 0, data: "AAAA" }, { kind: "audio", turn: 1, data: "x".repeat(70000) }, { kind: "execute", code: "click" }]) {
      expect(parseClientMessage(JSON.stringify({ ...m, command }))).toBeNull();
    }
    expect(parseClientMessage(JSON.stringify({ ...m, conversationId: {} }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "voice", voiceId: "v", event: { kind: "facts", turn: 1, snapshot: { successVerified: true } } }))).toBeNull();
  });
});

it('preserves a reported failure when the runtime settles to idle', () => {
  const p = new TaskProgress('A');
  p.request('读取页面');
  p.observe({type:'agent_event',event:{kind:'agent_start'}});
  p.observe({type:'agent_event',event:{kind:'error',message:'failed'}});
  p.observe({type:'status',state:'idle'});
  expect(p.snapshot().state).toBe('error');
});

it('语音进度与面板一样保留用户目标，不把成功动作当成已完成',async()=>{
 const p=new TaskProgress('voice');p.request('复制第一条评论到笔记');
 p.observe({type:'agent_event',event:{kind:'agent_start'}});
 p.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'click',name:'click',params:{target:'#editor'}}});
 p.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'click',name:'click',isError:false,executionFact:'executed',resultText:'clicked'}});
 p.observe({type:'agent_event',event:{kind:'agent_end'}});
 expect(progressSpeech(p.snapshot())).toContain('还有未完成的要求：复制第一条评论到笔记');
 expect(progressSpeech(p.snapshot())).not.toContain('需要你读回');
});

it('冲突的完成文案不能覆盖仍未完成的登记结果',()=>{
 const snapshot:any={conversationId:'default',runId:'run',state:'idle',observedAt:1,startedAt:1,goal:'先找再圈',active:[],lastAction:null,successVerified:false,results:[{id:'mark',description:'圈出Y',tool:'mark',target:'#y',status:'pending',evidence:null}],resultState:'pending',conversationContext:{recentTurns:[],latestResult:null,latestDelivery:{id:'d',conversationId:'default',runId:'run',kind:'finding',status:'played',composedAt:1,text:'全部完成了。'}}};
 const text=progressSpeech(snapshot);
 expect(text).toContain('圈出Y');
 expect(text).toMatch(/未完成|没有.*完成|尚未/);
 expect(text).not.toContain('全部完成了');
});

it('未知执行如实报告未知，并说明不会自动重做',()=>{
 const snapshot:any={conversationId:'default',runId:'run',state:'idle',observedAt:1,startedAt:1,goal:'先找再圈',active:[],lastAction:null,successVerified:false,results:[{id:'mark',description:'圈出Y',tool:'mark',target:'#y',status:'unknown',evidence:null}],resultState:'unknown',conversationContext:{recentTurns:[],latestResult:null,latestDelivery:null}};
 const text=progressSpeech(snapshot);
 expect(text).toMatch(/未知|无法确认/);
 expect(text).toMatch(/不会.*重做|不.*重放/);
});
