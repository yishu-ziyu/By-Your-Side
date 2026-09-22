import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserTools, modelToolOf } from "../src/tools.js";
import { createFleetTools } from "../src/fleet.js";
import { createConfirmBlockedWriteTool, createTaskResultsTool, createVerifyUnknownResultTool } from "../src/task-results.js";
import { createSendUserMessageTool } from "../src/user-delivery.js";
import { createCapturePageMaterialTool, createTaskGoalsTool } from "../src/task-goal-tool.js";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { MemoryStore } from "../src/memory-store.js";
import { SYSTEM_PROMPT, workerSystemPrompt } from "../src/prompt.js";
import { LEAD_SESSION_ID } from "../../shared/protocol.js";
import { TEAM_COORDINATION_TOOLS } from "../../shared/control.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TaskProgress } from "../src/task-progress.js";
import { ToolRpc } from "../src/rpc.js";

const rpc = () => ({ call: vi.fn(async () => ({})), ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} });
const fleetStub = () => ({ mailbox: {}, list: () => [], get: () => undefined, takeTab: async () => ({}), spawn: async () => ({}) }) as never;
const execute = (tools: { name: string; execute: Function }[], name: string, params: unknown) =>
  tools.find((t) => t.name === name)!.execute("call-1", params, undefined, undefined, {}) as Promise<{ content: { text: string }[]; details: unknown }>;

/**
 * 合成组件范围：只拼接组件工厂的输出（浏览器 + 账本/交付/记忆 + 团队），
 * 不含 session.ts 按会话挂载的 Lead 专属工具（capture_page_material/task_goals/confirm_blocked_write 等）。
 * 它只守组件级预算，不代表真实会话 active 清单——真实清单见本文件「真实会话 active 清单」用例。
 */
function componentSurface(workerCount: number): string[] {
  const browser = createBrowserTools(rpc() as never)
    .map((t) => t.name)
    .filter((name) => workerCount > 0 || name !== "page_operation");
  const ledger = ["record_task_results", "resolve_unknown_result"];
  const delivery = ["send_user_message"];
  const memory = ["user_memory"];
  const team = createFleetTools(fleetStub(), "main")
    .map((t) => t.name)
    .filter((name) => workerCount > 0 || name === "spawn_worker");
  return [...browser, ...ledger, ...delivery, ...memory, ...team];
}

describe("合成组件范围预算（非真实会话清单）", () => {
  it("组件拼接：无 worker ≤23、有 worker ≤29", () => {
    const idle = componentSurface(0);
    const team = componentSurface(1);
    // 2026-09-21: read_elements（宿主按选择器读回多元素，供圈注等 condition 目标核验取证）新增一个只读工具，见 docs/evals/20260921-1441-repair.md。
    // 合成清单里无 worker 23 个，仍在原 23 上限内，不上调；只有有 worker 的合成清单因这一个新工具从 28 到 29，故只调这一处。
    // 本用例只守组件拼接范围；真实会话 active 清单为 27/28/32/33（browser_loop 开关 × 无/有 worker），基线见下。
    expect(idle.length).toBeLessThanOrEqual(23);
    // User-requested in-page translation adds one tool; no extra display tools.
    expect(team.length).toBeLessThanOrEqual(29);
    expect(idle).toContain("page_translation");
    expect(idle).not.toContain("await_message");
    expect(team).toContain("await_message");
    expect(idle).not.toContain("page_operation");
    expect(team).toContain("page_operation");
    for (const name of TEAM_COORDINATION_TOOLS) expect(idle).not.toContain(name);
  });

  it("read_elements 的模型参数上限与扩展执行器一致（1-200）", () => {
    const tool = createBrowserTools(rpc() as never).find((t) => t.name === "read_elements")!;
    const limit = (tool.parameters as { properties?: { limit?: { minimum?: number; maximum?: number } } }).properties?.limit;
    // extension/src/background/exec/read-elements.ts 的 parseLimit：1-200 整数，越界报错。
    expect(limit?.minimum).toBe(1);
    expect(limit?.maximum).toBe(200);
  });

  it("系统提示词不超过 16,000 字符", () => {
    // 2026-09-18 用户裁决上调：P0 confirm_blocked_write 指引（+170）在旧 15,000 上越线至 15168。
    // 新值保留头部空间，但模型面仍是有界预算；继续加提示词内容需在此预算内裁剪仲裁。
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(16_000);
  });

  it("worker 只拿到自己的工具（浏览器 + 投递/等待）,没有 spawn_worker", () => {
    const names = createFleetTools(fleetStub(), "w1").map((t) => t.name);
    expect(names).toEqual(["post", "await_message"]);
    expect(workerSystemPrompt({ id: "w", peers: [], tabId: 1 })).toContain("expected current value");
  });
});

/**
 * 真实来源清单：按生产装配（conversation-runtime.ts 的 customTools + session.ts 的 Lead 专属工具）
 * 调用同一批工厂，用来核对真实 active 清单有没有漏挂或多挂。任一侧新增工具都会与真实清单对不上，
 * 失败信息会点名具体工具，避免再出现「合成清单漏掉 take_tab/task_goals/... 却仍算通过」。
 */
function sourceInventory(loopEnabled: boolean, workerMounted: boolean): string[] {
  process.env.SIDEAGENT_GENERAL_BROWSER_LOOP = loopEnabled ? "1" : "0";
  const browser = createBrowserTools(
    rpc() as never,
    undefined,
    async () => ({}),
    () => true,
    { goal: () => "goal", reserveDecision: () => {}, epoch: () => 0, canWrite: () => true } as never,
    (async () => ({})) as never,
  ).map((t) => t.name);
  const lead = [
    createCapturePageMaterialTool(() => ({} as never)),
    createTaskGoalsTool(() => ({} as never)),
    createTaskResultsTool({ getSnapshot: () => ({} as never), register: () => {} }),
    createVerifyUnknownResultTool({ getSnapshot: () => ({} as never), read: async () => ({}), verify: () => ({ ok: false }) }),
    createConfirmBlockedWriteTool({
      getSnapshot: () => ({} as never),
      read: async () => ({}),
      confirm: async () => ({ allowed: false }),
      executeWrite: async () => {},
      record: () => null,
      persist: () => {},
      emit: () => {},
    }),
    createSendUserMessageTool({ conversationId: "default", getRunId: () => null, emit: () => {} }),
  ].map((t) => t.name);
  // 只取工具名，不需要真实存储。
  const memory = new MemoryRuntime({} as never, "default", () => {}).tools().map((t) => t.name);
  const team = createFleetTools(fleetStub(), LEAD_SESSION_ID).map((t) => t.name);
  const names = [...browser, ...lead, ...memory, ...team];
  const visible = workerMounted
    ? names
    : names.filter((name) => !TEAM_COORDINATION_TOOLS.has(name) && name !== "page_operation");
  return visible.sort();
}

/**
 * 真实会话 active 清单基线：2026-09-21 用 createConversationRuntime('default', …, {memoryStore}) 实测，
 * 证据与完整清单见 docs/evals/20260921-tool-surface-reconcile.md。这里记录真实数量，不沿用合成清单的 23/29 上限。
 */
const REAL_SURFACE_BASELINE = {
  loopOff: {
    solo: {
      count: 27,
      names: ["browser_run", "capture_page_material", "click", "confirm_blocked_write", "fetch", "fill", "hover", "js", "mark", "navigate", "network", "page_translation", "press_key", "read_element", "read_elements", "record_task_results", "resolve_unknown_result", "screenshot", "scroll", "send_user_message", "snapshot", "spawn_worker", "tabs", "take_tab", "task_goals", "type_text", "user_memory"],
    },
    team: {
      count: 32,
      names: ["await_message", "browser_run", "capture_page_material", "click", "confirm_blocked_write", "fetch", "fill", "hover", "js", "list_workers", "mark", "navigate", "network", "page_operation", "page_translation", "post", "press_key", "read_element", "read_elements", "record_task_results", "resolve_unknown_result", "screenshot", "scroll", "send_user_message", "snapshot", "spawn_worker", "stop_worker", "tabs", "take_tab", "task_goals", "type_text", "user_memory"],
    },
  },
  loopOn: {
    solo: {
      count: 28,
      names: ["browser_loop", "browser_run", "capture_page_material", "click", "confirm_blocked_write", "fetch", "fill", "hover", "js", "mark", "navigate", "network", "page_translation", "press_key", "read_element", "read_elements", "record_task_results", "resolve_unknown_result", "screenshot", "scroll", "send_user_message", "snapshot", "spawn_worker", "tabs", "take_tab", "task_goals", "type_text", "user_memory"],
    },
    team: {
      count: 33,
      names: ["await_message", "browser_loop", "browser_run", "capture_page_material", "click", "confirm_blocked_write", "fetch", "fill", "hover", "js", "list_workers", "mark", "navigate", "network", "page_operation", "page_translation", "post", "press_key", "read_element", "read_elements", "record_task_results", "resolve_unknown_result", "screenshot", "scroll", "send_user_message", "snapshot", "spawn_worker", "stop_worker", "tabs", "take_tab", "task_goals", "type_text", "user_memory"],
    },
  },
} as const;

describe("真实会话 active 清单（BrowserAgentSession 注册）", () => {
  const originalLoopEnv = process.env.SIDEAGENT_GENERAL_BROWSER_LOOP;
  const tempDirs: string[] = [];
  afterAll(() => {
    if (originalLoopEnv === undefined) delete process.env.SIDEAGENT_GENERAL_BROWSER_LOOP;
    else process.env.SIDEAGENT_GENERAL_BROWSER_LOOP = originalLoopEnv;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  for (const loopEnabled of [false, true]) {
    it(`browser_loop ${loopEnabled ? "开" : "关"}：无/有 worker 的真实清单等于来源清单并匹配实测基线`, async () => {
      process.env.SIDEAGENT_GENERAL_BROWSER_LOOP = loopEnabled ? "1" : "0";
      const { createConversationRuntime } = await import("../src/conversation-runtime.js");
      const dir = mkdtempSync(join(tmpdir(), "bys-tool-surface-"));
      tempDirs.push(dir);
      const runtime = await createConversationRuntime("default", () => {}, undefined, { memoryStore: new MemoryStore(dir) });
      try {
        const inner = (runtime.session as unknown as { session: { getActiveToolNames(): string[] } }).session;
        const baseline = loopEnabled ? REAL_SURFACE_BASELINE.loopOn : REAL_SURFACE_BASELINE.loopOff;
        for (const scenario of [
          { name: "无 worker", key: "solo" as const, mounted: false },
          { name: "有 worker", key: "team" as const, mounted: true },
        ]) {
          // 有 worker 走生产同一回调：conversation-runtime.ts 把 fleet.onMembersChange 接到 setTeamToolsMounted。
          if (scenario.mounted) runtime.fleet.onMembersChange?.(1);
          const active = inner.getActiveToolNames().slice().sort();
          const inventory = sourceInventory(loopEnabled, scenario.mounted);
          expect(inventory.filter((name) => !active.includes(name)), `${scenario.name}：真实清单漏挂来源工具`).toEqual([]);
          expect(active.filter((name) => !inventory.includes(name)), `${scenario.name}：真实清单有来源未覆盖的工具`).toEqual([]);
          expect(active.length, `${scenario.name}：真实数量基线`).toBe(baseline[scenario.key].count);
          expect(active, `${scenario.name}：真实清单基线`).toEqual([...baseline[scenario.key].names]);
        }
      } finally {
        runtime.dispose();
      }
    }, 30_000);
  }
});

describe("单人页不挂载 page_operation", () => {
  it("setTeamToolsMounted(false) 从模型清单拿掉 page_operation，请来人后再挂上", async () => {
    const { BrowserAgentSession } = await import("../src/session.js");
    const names = ["fill", "snapshot", "page_operation", "post", "await_message", "spawn_worker", "take_tab"];
    let active = [...names];
    const session = {
      getActiveToolNames: () => active,
      getAllTools: () => names.map((name) => ({ name })),
      setActiveToolsByName: (next: string[]) => { active = [...next]; },
    };
    const wrapper: { setTeamToolsMounted: (mounted: boolean) => void } = new (BrowserAgentSession as unknown as new (...args: unknown[]) => { setTeamToolsMounted: (mounted: boolean) => void })(
      session, null, { emit() {}, setStatus() {} }, null, null,
    );
    wrapper.setTeamToolsMounted(false);
    expect(active).not.toContain("page_operation");
    expect(active).not.toContain("post");
    expect(active).toContain("fill");
    expect(active).toContain("spawn_worker");
    wrapper.setTeamToolsMounted(true);
    expect(active).toContain("page_operation");
    expect(active).toContain("post");
  });
});

/** Real Pi lifecycle and registered tools; a local finite provider only captures model inputs. */
async function taskSurfaceSession() {
  const { BrowserAgentSession } = await import('../src/session.js');
  const dir = mkdtempSync(join(tmpdir(), 'bys-result-surface-'));
  const modelRuntime = await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,
    modelsStorePath:join(dir,'models.json'),allowModelNetwork:false,refreshOnCreate:false});
  type Input = {systemPrompt?:string;tools?:{name:string;description:string}[];messages:unknown[]};
  const inputs:Input[] = [];
  const replies:Array<(input:Input)=>unknown[]> = [];
  const model = {id:'probe',name:'Local surface probe',api:'surface-probe',provider:'surface-probe',
    baseUrl:'http://127.0.0.1',reasoning:false,input:['text'],contextWindow:32000,maxTokens:1024,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const stream = (_model:unknown, context:Input) => {
    // Pi also keeps executor functions on context.tools; capture model-facing metadata only.
    inputs.push({systemPrompt:context.systemPrompt,tools:context.tools?.map(({name,description})=>({name,description})),
      messages:structuredClone(context.messages)});
    const content = replies.shift()?.(inputs.at(-1)!) ?? [];
    const reason = content.length ? 'toolUse' : 'stop';
    const message = {role:'assistant',content,api:model.api,provider:model.provider,model:model.id,
      stopReason:reason,timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,
        cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    return {async *[Symbol.asyncIterator]() {yield {type:'start',partial:message};yield {type:'done',reason,message};},
      result:async()=>message};
  };
  modelRuntime.registerNativeProvider({id:model.provider,name:model.name,
    auth:{apiKey:{name:'Local only',resolve:async()=>({auth:{}})}},getModels:()=>[model],stream,streamSimple:stream
  } as unknown as Parameters<ModelRuntime['registerNativeProvider']>[0]);
  const progress = new TaskProgress('default');
  const wire = new ToolRpc(), frames:Array<{name:string}>=[];
  wire.setPageTarget(undefined,7);
  wire.setSend(frame=>{frames.push(frame);wire.handleResult(frame.id,frame.name!=='fill',
    {tabId:7,value:'星河'},frame.name==='fill'?'receipt lost':undefined,frame.name==='fill'?'unknown':'executed');});
  const host = await BrowserAgentSession.create(wire, {
    emit:event=>progress.observe({type:'agent_event',event}),setStatus:()=>{},
  }, {conversationId:'default',modelRuntime,modelPattern:'surface-probe/probe',customTools:createBrowserTools(wire,
    undefined,undefined,undefined,{epoch:()=>host.executionEpoch(),canWrite:id=>host.canWriteCurrentInput(id),
      assertCall:(name,params,id)=>host.assertTaskResultExecution(name,params,id)})});
  expect(host.available).toBe(true);
  host.bindConversationContext(()=>progress.snapshot());
  host.bindTaskResults({getSnapshot:()=>progress.snapshot(),goals:progress.goals,
    register:items=>progress.registerResults(items),verify:input=>progress.verifyUnknownResult(input)});
  const inner = (host as unknown as {session:{prompt(text:string):Promise<void>}}).session;
  return {host,progress,inputs,replies,frames,prompt:()=>inner.prompt('检查本轮工具契约'),
    close:()=>{host.dispose();rmSync(dir,{recursive:true,force:true});}};
}

describe('新任务自动记账工具面（真实 Pi、本地模型、无浏览器）',()=>{
  it('模型后续输入拿到自动结果 ID，现有核查工具不依赖手工登记且不凭缺基线读数解除 unknown',async()=>{
    const h=await taskSurfaceSession();
    try {
      h.progress.request('填写星河，不提交');
      h.replies.push(()=>[{type:'toolCall',id:'actual-write',name:'fill',arguments:{target:'#code',value:'星河'}}]);
      h.replies.push(input=>{
        const texts=(input.messages as {content?:unknown}[]).map(message=>typeof message.content==='string'?message.content:
          Array.isArray(message.content)?message.content.map(part=>part.text??'').join(''): '');
        const text=texts.find(t=>t.startsWith('应用状态快照，不是新用户消息'))!;
        const projection=JSON.parse(text.slice(text.indexOf('{'),text.indexOf('。下一步由宿主计算')));
        const item=projection.results.find((r:{status:string})=>r.status==='unknown');
        expect(item.evidence.toolCallId).toBe('actual-write');
        return [{type:'toolCall',id:'check-result',name:'resolve_unknown_result',arguments:{id:item.id,target:'#code',expect:'星河',tabId:7}}];
      });
      await h.prompt();
      expect(h.inputs).toHaveLength(3);
      for(const input of h.inputs)expect(input.tools?.map(t=>t.name)).not.toContain('record_task_results');
      expect(h.frames.map(f=>f.name)).toEqual(['fill','read_element']);
      expect(h.progress.snapshot()).toMatchObject({executionState:'unknown',successVerified:false});
      expect(h.progress.snapshot().goalPlan?.goals[0]?.status).toBe('pending');
      expect(()=>h.host.assertTaskResultExecution('fill',{target:'#other',value:'星河'})).toThrow(/尚未确认结果/);
    } finally {h.close();}
  },15000);

  it('每次输入按当前 run 收起手工入口，模式与团队切换不重新暴露',async()=>{
    const h=await taskSurfaceSession();
    try {
      expect(h.host.isToolActive('record_task_results')).toBe(true);
      h.progress.request('把代号填成星河，不要保存或提交');
      await h.prompt();
      const input=h.inputs.at(-1)!;
      expect(input.tools?.map(t=>t.name)).not.toContain('record_task_results');
      expect(input.tools?.map(t=>t.name)).toEqual(expect.arrayContaining(['task_goals','capture_page_material','resolve_unknown_result','confirm_blocked_write','send_user_message']));
      expect(input.systemPrompt).not.toContain('record_task_results');
      expect(input.tools?.find(t=>t.name==='resolve_unknown_result')?.description).not.toContain('record_task_results');
      for(const mounted of [false,true,false]){
        h.host.setTeamToolsMounted(mounted);
        await h.host.setMode(mounted?'teach':'act');
        expect(h.host.isToolActive('record_task_results')).toBe(false);
        expect(h.host.isToolActive('page_operation')).toBe(mounted);
      }
      h.progress.request('下一项任务');
      await h.prompt();
      expect(h.inputs.at(-1)!.tools?.map(t=>t.name)).not.toContain('record_task_results');
    } finally {h.close();}
  },15000);

  it('旧检查点与已有手工槽位保留兼容，恢复后新建任务重新隐藏',async()=>{
    const h=await taskSurfaceSession();
    try {
      h.progress.request('旧任务');
      h.progress.registerResults([{id:'legacy-slot',description:'填写草稿',tool:'fill',target:null}]);
      await h.prompt();
      expect(h.host.isToolActive('record_task_results')).toBe(true);
      const saved=h.progress.snapshot();
      h.progress.restoreResults({...saved,state:'running'});
      expect(h.progress.snapshot().restartRecovery).toBe(true);
      await h.prompt();
      expect(h.inputs.at(-1)!.tools?.map(t=>t.name)).toContain('record_task_results');
      expect(h.progress.snapshot().results?.some(r=>r.id==='legacy-slot')).toBe(true);
      h.progress.request('全新任务');
      await h.prompt();
      expect(h.inputs.at(-1)!.tools?.map(t=>t.name)).not.toContain('record_task_results');
      h.progress.restoreResults({...saved,goalPlan:undefined,state:'idle',restartRecovery:undefined});
      await h.prompt();
      expect(h.inputs.at(-1)!.tools?.map(t=>t.name)).toContain('record_task_results');
    } finally {h.close();}
  },15000);

  it.each(['restart','no-plan','manual-blocked','auto-unknown'] as const)('兼容条件独立生效：%s',async kind=>{
    const h=await taskSurfaceSession();
    try {
      h.progress.request('原任务');
      const saved=h.progress.snapshot();
      if(kind==='restart')h.progress.restoreResults({...saved,state:'running'});
      if(kind==='no-plan')h.progress.restoreResults({...saved,goalPlan:undefined,state:'idle'});
      if(kind==='manual-blocked')h.progress.restoreResults({...saved,state:'idle',results:[
        {id:'legacy',description:'旧执行方法',tool:'click',target:'#old',status:'blocked',evidence:null},
      ]});
      if(kind==='auto-unknown'){
        h.progress.observe({type:'agent_event',event:{kind:'tool_start',name:'fill',toolCallId:'unknown-write',params:{target:'#code',value:'星河'}}});
        h.progress.observe({type:'agent_event',event:{kind:'tool_end',name:'fill',toolCallId:'unknown-write',isError:true,executionFact:'unknown',resultText:'timeout'}});
      }
      await h.prompt();
      expect(h.inputs.at(-1)!.tools?.some(tool=>tool.name==='record_task_results')).toBe(kind!=='auto-unknown');
      if(kind==='auto-unknown')expect(h.progress.snapshot().results![0]!.status).toBe('unknown');
    } finally {h.close();}
  },15000);
});

describe("合并工具的行为", () => {
  it("tabs 的每个 action 落到对应 RPC 名；switch/close 仍是同一模型工具", async () => {
    const call = vi.fn(async (name: string) => {
      if (name === "list_tabs") return { tabs: [{ id: 1, title: "t", url: "https://x/", active: true, working: false }] };
      if (name === "get_active_tab") return { tab: { id: 1, title: "t", url: "https://x/", active: true, working: false } };
      if (name === "open_tab") return { tabId: 2, title: "", url: "https://y/", readiness: "interactive" };
      if (name === "switch_tab") return { tabId: 2 };
      return { closed: true };
    });
    const tools = createBrowserTools({ call, ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} } as never);
    await execute(tools, "tabs", { action: "list" });
    await execute(tools, "tabs", { action: "active" });
    await execute(tools, "tabs", { action: "open", url: "https://y/" });
    await execute(tools, "tabs", { action: "switch", tabId: 2 });
    await execute(tools, "tabs", { action: "close", tabId: 2 });
    expect(call.mock.calls.map((c) => c[0])).toEqual(["list_tabs", "get_active_tab", "open_tab", "switch_tab", "close_tab"]);
  });

  it("tabs action:switch 缺 tabId 时不发 RPC", async () => {
    const call = vi.fn(async () => ({}));
    const tools = createBrowserTools({ call, ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} } as never);
    await expect(execute(tools, "tabs", { action: "switch" })).rejects.toThrow(/需要 tabId/);
    expect(call).not.toHaveBeenCalled();
  });

  it("mark 画标注与清除走同一个模型工具、两个 RPC 名", async () => {
    const call = vi.fn(async (_name: string) => ({ marked: true }));
    const tools = createBrowserTools({ call, ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} } as never);
    await execute(tools, "mark", { target: "#x", label: "看这里" });
    await execute(tools, "mark", { clear: true });
    expect(call.mock.calls.map((c) => c[0])).toEqual(["mark", "clear_marks"]);
    await expect(execute(tools, "mark", {})).rejects.toThrow(/clear:true/);
  });

  it("RPC 名到模型名的映射覆盖合并的五个标签页工具与标注工具", () => {
    for (const name of ["list_tabs", "get_active_tab", "open_tab", "switch_tab", "close_tab"]) expect(modelToolOf(name)).toBe("tabs");
    expect(modelToolOf("clear_marks")).toBe("mark");
    expect(modelToolOf("worker_tabs")).toBe("take_tab");
    expect(modelToolOf("click")).toBe("click");
  });
});
