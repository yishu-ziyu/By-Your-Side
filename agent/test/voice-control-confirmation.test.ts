import {afterEach, describe, expect, it, vi} from "vitest";
import type {Attachment, PageContext, ServerMessage} from "../../shared/protocol.js";
import type {TaskActionRequest, TaskReceipt} from "../../shared/task-actions.js";
import type {VoiceRouteResult} from "../../shared/voice.js";
import {TaskDispatcher} from "../src/task-dispatcher.js";
import {ConversationManager} from "../src/conversation-manager.js";
import {isControlConfirm, isControlReject} from "../src/voice-confirm.js";

/**
 * 真行为用例：走真实 ConversationManager + TaskDispatcher，只替身分类器和页面执行。
 * 目标：普通修改一次送达并保留原文/原页/附件/任务身份，具体控制保护仍生效。
 * 2026-09-16 用户否定了逐句读回策略，旧的两轮修改用例由直接派发用例取代。
 */

type SteerRecord = {text: string; context?: PageContext; attachments?: Attachment[]};

type Plan = {steps: Array<{action: string; text: string; target: null}>};

/** 已落动作的那一支：steer/action 才有 ok/status。 */
const done = (result: VoiceRouteResult) => result as Extract<VoiceRouteResult, {kind: "steer" | "action"}>;

class RecordingDispatcher extends TaskDispatcher {
  readonly requests: TaskActionRequest[] = [];
  override dispatch(request: TaskActionRequest, title: string, execute: () => Promise<Pick<TaskReceipt, "status" | "message" | "runId">>): Promise<TaskReceipt> {
    this.requests.push(request);

    return super.dispatch(request, title, execute);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}

function setup() {
  const received: SteerRecord[] = [];
  const emitted: ServerMessage[] = [];
  const dispatcher = new RecordingDispatcher();
  let classifier = (text: string): Plan => ({steps: [{action: "steer", text, target: null}]});
  let running = false;
  let conversationEmit: (message: ServerMessage) => void = () => {};

  let session: {
    available: boolean; modelName: () => string; availableModels: () => Promise<never[]>; isHeld: () => boolean;
    isStreaming: () => boolean; classifyVoiceInput: (text: string) => Promise<Plan>;
    startTask: () => void; steerCurrentTask: (text: string, context?: PageContext, attachments?: Attachment[]) => Promise<void>;
    queueSteerForResume: () => void; persistTaskResults: () => void; abort: () => void;
  };

  const manager = new ConversationManager(async (_id, emitEvent) => {
    conversationEmit = emitEvent;
    session = {
      available: true,
      modelName: () => "fixture",
      availableModels: async () => [],
      isHeld: () => false,
      isStreaming: () => running,
      classifyVoiceInput: async (text: string) => classifier(text),
      startTask: () => { running = true; emitEvent({type: "agent_event", event: {kind: "agent_start"}} as ServerMessage); },
      steerCurrentTask: async (text: string, context?: PageContext, attachments?: Attachment[]) => { received.push({text, context, attachments}); },
      queueSteerForResume: () => {},
      persistTaskResults: () => {},
      abort: () => { running = false; },
    };

    return {
      session,
      fleet: {isGroupHeld: () => false, reset: () => {}, teamView: () => null, list: () => []},
      rpc: {rejectAll: () => {}},
      handleMessage: (message: ServerMessage) => { if ((message as {type: string}).type === "abort") session.abort(); },
      dispose: () => {},
    } as never;
  }, (message) => { emitted.push(message); }, undefined, undefined, undefined, dispatcher);

  return {
    manager, dispatcher, received, emitted,
    setClassifier: (next: (text: string) => Plan) => { classifier = next; },
    endRun: () => { running = false; conversationEmit({type: "agent_event", conversationId: "default", event: {kind: "agent_end"}} as ServerMessage); },
  };
}

const context = (tabId: number, title: string, url: string): PageContext => ({tabId, title, url});

const image = (id: string, name: string, dataBase64 = "AAAA"): Attachment => ({id, type: "image", name, dataBase64, mimeType: "image/png"});

async function runningTask(manager: ConversationManager, requestId = "text-start", expectedRunId: string | null = null) {
  const started = await manager.dispatchTaskAction({requestId, conversationId: "default", source: "text", action: "start", expectedRunId, text: "在网页上查看内容"});
  expect(started.status).toBe("accepted");
  const snapshot = manager.getTaskProgress("default")!;

  return {runId: snapshot.runId!, controlVersion: snapshot.controlVersion ?? 0};
}

function routeFor(manager: ConversationManager, runId: string, controlVersion: number, over: Record<string, unknown> = {}) {
  return {
    requestId: "voice-1", voiceId: "voice-a", turn: 1, runId, controlVersion,
    targets: manager.voiceTargets(), ...over,
  } as never;
}

afterEach(() => { vi.useRealTimers(); });

describe("语音修改直接送达", () => {
  it.each(["只留下一文就可以了。", "呃，是的，是只留下翻译之后的，只有留下译文。", "然后我需要字体改成宋体。", "对，是苏州，但是不要点确认。", "是的，确认，但是不要保存"])("%s 不要求再确认，保留完整原话与页面资料", async text => {
    const {manager,dispatcher,received}=setup();await manager.ensureDefault();
    const {runId,controlVersion}=await runningTask(manager);
    const originalContext=context(101,"当前页面","https://example.invalid/a");
    const attachments=[image('attach-a','a.png')];
    const result=await manager.routeVoiceInput('default',text,null,()=>true,routeFor(manager,runId,controlVersion,{input:{context:originalContext,attachments,observation:{token:'read-only',tabId:101}}}));
    expect(result).toMatchObject({kind:'steer',ok:true,status:'accepted'});
    expect(received).toEqual([{text,context:originalContext,attachments}]);
    const request=dispatcher.requests.find(r=>r.action==='steer')!;
    expect(request).toMatchObject({expectedRunId:runId,expectedControlVersion:controlVersion,source:'voice'});
    expect(request).not.toHaveProperty('observation');
    expect((result as {message?:string}).message).not.toContain('你是说');
  });

  it('连续两句各自直接送达；同一请求重放不重复',async()=>{
    const {manager,received}=setup();await manager.ensureDefault();
    const {runId,controlVersion}=await runningTask(manager);
    const firstRoute=routeFor(manager,runId,controlVersion);
    await manager.routeVoiceInput('default','只留下译文',null,()=>true,firstRoute);
    await manager.routeVoiceInput('default','只留下译文',null,()=>true,firstRoute);
    await manager.routeVoiceInput('default','字体改成宋体',null,()=>true,routeFor(manager,runId,controlVersion,{requestId:'voice-2',turn:2}));
    expect(received.map(r=>r.text)).toEqual(['只留下译文','字体改成宋体']);
  });

  it('纯应答不消费不存在的待确认，不重新执行原修改',async()=>{
    const {manager,received,setClassifier}=setup();await manager.ensureDefault();
    const {runId,controlVersion}=await runningTask(manager);
    await manager.routeVoiceInput('default','只留下译文',null,()=>true,routeFor(manager,runId,controlVersion));
    setClassifier(text=>({steps:[{action:'chat',text,target:null}]}));
    const answer=await manager.routeVoiceInput('default','对对，没错',null,()=>true,routeFor(manager,runId,controlVersion,{requestId:'voice-2',turn:2}));
    expect(answer.kind).toBe('none');expect(received).toHaveLength(1);
  });

  it.each(['ended','replaced','control-changed','old-voice'])('原任务 %s 不把要求送到旧执行；缺少续接页面时保留原任务',async mode=>{
    const {manager,received,endRun}=setup();await manager.ensureDefault();
    const {runId,controlVersion}=await runningTask(manager);

    if(mode==='ended'||mode==='replaced')endRun();

    if(mode==='replaced')await runningTask(manager,'next-run',runId);

    if(mode==='control-changed')await manager.handleMessage({type:'takeover',requestId:'takeover',conversationId:'default'});
    const call=manager.routeVoiceInput('default','改为宋体',null,()=>mode!=='old-voice',routeFor(manager,runId,controlVersion));

    if(mode==='old-voice')await expect(call).rejects.toThrow();
    else {const result=await call;expect(done(result).ok).not.toBe(true);}

    expect(received).toHaveLength(0);
  });

  it('查询和闲聊不变成修改',async()=>{
    const {manager,received,setClassifier}=setup();await manager.ensureDefault();
    const {runId,controlVersion}=await runningTask(manager);
    setClassifier(text=>({steps:[{action:'chat',text,target:null}]}));
    const result=await manager.routeVoiceInput('default','宋体是什么字体',null,()=>true,routeFor(manager,runId,controlVersion));
    expect(result.kind).toBe('none');expect(received).toHaveLength(0);
  });
});

describe('保留终止任务读回',()=>{
  it("终止句沿用原确认规则：确认后按原调度下发，且不扩大页面输入", async () => {
    const {manager, dispatcher, received, emitted, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    setClassifier((text) => ({steps: [{action: "abort", text, target: null}]}));

    const first = await manager.routeVoiceInput("default", "停下", null, () => true, routeFor(manager, runId, controlVersion, {
      input: {context: context(101, "A", "https://example.invalid/a"), attachments: [image("attach-a", "a.png")], observation: {token: "obs-secret", tabId: 101}},
    }));

    expect(first.kind).toBe("clarify");
    expect((first as {message: string}).message).toContain("停下");

    const confirming = manager.routeVoiceInput("default", "对", null, () => true, routeFor(manager, runId, controlVersion, {
      requestId: "voice-2", turn: 2, input: {context: context(202, "确认时另一页面", "https://example.invalid/b")},
    }));

    await waitFor(() => emitted.some((message) => (message as {type: string}).type === "task_control"));
    const control = emitted.find((message) => (message as {type: string}).type === "task_control") as unknown as {requestId: string; action: string; runId: string};
    await manager.handleMessage({type: "task_control_result", conversationId: "default", requestId: control.requestId, action: "abort", runId: control.runId, ok: true});
    const second = await confirming;
    expect(second.kind).toBe("action");
    expect(done(second).ok).toBe(true);
    expect(received).toHaveLength(0);
    const abortRequest = dispatcher.requests.find((request) => request.action === "abort")!;
    expect(abortRequest.text).toBe("停下");
    expect(abortRequest.context).toBeUndefined();
    expect(abortRequest.attachments).toBeUndefined();
    expect(abortRequest.expectedControlVersion).toBe(controlVersion);
  });

 });

describe("已保存的旧版另开会话提案仍能确认和拒绝", () => {
  it.each(["好的，另开会话", "算了，不用了", "不用了，谢谢"])("接住 %s，不再分类这句回应", async reply => {
    const {manager, dispatcher, setClassifier} = setup();
    await manager.ensureDefault();
    const {runId, controlVersion} = await runningTask(manager);
    const seen: string[] = [];
    setClassifier(text => { seen.push(text);

 return {steps:[{action:"start",text,target:null}]}; });
    // Compatibility with a proposal saved before independent requirements were queued automatically.
    const proposal={id:'voice-1',conversationId:'legacy-child',voiceId:'voice-a',turn:1,expiresAt:Date.now()+90000,text:'查另一个问题'};
    await (manager as any).voicePlans.run('default','voice-1',{},async()=>{(manager as any).voicePlans.update('default','voice-1',{proposal});

return {kind:'clarify',message:'要另开会话吗？'};});
    (manager as any).voiceConfirmations.set('default',proposal);
    const second = await manager.routeVoiceInput("default", reply, null, () => true, routeFor(manager, runId, controlVersion,{requestId:"voice-2",turn:2}));
    expect(seen).toEqual([]);
    const newStarts=dispatcher.requests.filter(r=>r.action==="start"&&r.conversationId!=="default");

    if(reply.startsWith("好的")) {
      expect(newStarts).toHaveLength(1);
      expect(newStarts[0]!.text).toBe("查另一个问题");
    } else {
      expect(newStarts).toHaveLength(0);
      expect(second).toMatchObject({kind:"clarify",message:"没有另开会话，原任务保持原状。"});
    }
  });
});

it.each(["不是不行", "不是不可以", "谢谢", "好了", "不对，城市改为南京"])("不把双重否定或新要求误作撤销：%s", text => {
  expect(isControlReject(text)).toBe(false);
});

it.each(['expired','rejected'])('终止确认 %s 不执行',async mode=>{
  vi.useFakeTimers({toFake:['Date']});
  const {manager,dispatcher,setClassifier}=setup();await manager.ensureDefault();
  const {runId,controlVersion}=await runningTask(manager);
  setClassifier(text=>({steps:[{action:'abort',text,target:null}]}));
  const first=await manager.routeVoiceInput('default','终止任务',null,()=>true,routeFor(manager,runId,controlVersion));
  expect(first.kind).toBe('clarify');

  if(mode==='expired')vi.setSystemTime(Date.now()+91000);
  const result=await manager.routeVoiceInput('default',mode==='expired'?'确认':'不用了',null,()=>true,routeFor(manager,runId,controlVersion,{requestId:'voice-2',turn:2}));
  expect(result.kind).toBe('clarify');
  expect(dispatcher.requests.filter(r=>r.action==='abort')).toHaveLength(0);
});

it('registers an independent request without asking the user to open another conversation',async()=>{
 const {manager,setClassifier}=setup();await manager.ensureDefault();
 const {runId,controlVersion}=await runningTask(manager);
 setClassifier(text=>({steps:[{action:'start',text,target:null}]}));
 const result=await manager.routeVoiceInput('default','同时打开B站',null,()=>true,routeFor(manager,runId,controlVersion));
 expect(result.kind).toBe('action');
 expect(manager.getTaskProgress('default')?.runId).toBe(runId);
 expect(manager.voiceTargets().some(t=>t.title==='同时打开B站')).toBe(true);
});
