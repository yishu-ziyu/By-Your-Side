import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserTools, modelToolOf } from "../src/tools.js";
import { createTaskResultsTool, createVerifyUnknownResultTool } from "../src/task-results.js";
import { createSendUserMessageTool } from "../src/user-delivery.js";
import { createArtifactsTool } from "../src/artifacts-tool.js";
import { createTakeTabTool, TabControl } from "../src/tab-control.js";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "./fixtures/file-document.js";
import { PROBE_PATTERN, scriptedModels, type ScriptedInput } from "./fixtures/scripted-loop.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import { TaskProgress } from "../src/task-progress.js";
import { ToolRpc } from "../src/rpc.js";

const rpc = () => ({ call: vi.fn(async () => ({})), ensureToolCall() {}, markCallRejected() {}, noteToolFact() {} });

const execute = (tools: { name: string; execute: Function }[], name: string, params: unknown) =>
  tools.find((t) => t.name === name)!.execute("call-1", params, undefined, undefined, {}) as Promise<{ content: { text: string }[]; details: unknown }>;

describe("组件工具语义（非真实会话清单）", () => {
  it("浏览器工具没有重名，不含已删除的工具", () => {
    const names = createBrowserTools(rpc() as never).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("page_translation");
    expect(names).toContain("mark");

    for (const gone of ["page_operation", "ask_user_to_point", "cdp", "drag", "html5_drag", "wheel", "mouse_down", "mouse_up", "key_down", "key_up", "release_held_inputs", "download_stat", "download_cancel", "download_delete", "file_chooser_set_files", "paste", "download_save_as"]) {
      expect(names, gone).not.toContain(gone);
    }
  });

  it("read_elements 的模型参数上限与扩展执行器一致（1-200）", () => {
    const tool = createBrowserTools(rpc() as never).find((t) => t.name === "read_elements")!;
    const limit = (tool.parameters as { properties?: { limit?: { minimum?: number; maximum?: number } } }).properties?.limit;
    // extension/src/background/exec/read-elements.ts 的 parseLimit：1-200 整数，越界报错。
    expect(limit?.minimum).toBe(1);
    expect(limit?.maximum).toBe(200);
  });

  it("系统提示词不超过 16,000 字符", () => {
    // 2026-09-18 用户裁决上调：当时的恢复确认指引（+170）在旧 15,000 上越线至 15168。
    // 新值保留头部空间，但模型面仍是有界预算；继续加提示词内容需在此预算内裁剪仲裁。
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(16_000);
  });
});

/**
 * 真实来源清单：按生产装配（conversation-runtime.ts 的 customTools + session.ts 的主会话专属工具）
 * 调用同一批工厂，用来核对真实 active 清单有没有漏挂或多挂。任一侧新增工具都会与真实清单对不上，
 * 失败信息会点名具体工具。
 */
function sourceInventory(): string[] {
  const browser = createBrowserTools(
    rpc() as never,
    undefined,
    async () => ({}),
    () => true,
    { epoch: () => 0, canWrite: () => true } as never,
    (async () => ({})) as never,
  ).map((t) => t.name);

  const lead = [
    createTaskResultsTool({ getSnapshot: () => ({} as never), register: () => {} }),
    createVerifyUnknownResultTool({ getSnapshot: () => ({} as never), read: async () => ({}), verify: () => ({ ok: false }) }),
    createSendUserMessageTool({ conversationId: "default", getRunId: () => null, emit: () => {} }),
    createArtifactsTool({ emit: () => {} }),
    createTakeTabTool(new TabControl(rpc() as never)),
  ].map((t) => t.name);

  // 只取工具名，不需要真实存储。
  const memory = new MemoryRuntime({} as never, "default", () => {}).tools().map((t) => t.name);

  return [...browser, ...lead, ...memory].sort();
}

describe("真实会话 active 清单（BrowserAgentSession 注册）", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("真实清单等于生产来源", async () => {
    const { createConversationRuntime } = await import("../src/conversation-runtime.js");
    const dir = mkdtempSync(join(tmpdir(), "bys-tool-surface-"));
    tempDirs.push(dir);
    const runtime = await createConversationRuntime("default", () => {}, PROBE_PATTERN, { loop: { models: scriptedModels(), cwd: "/tmp" }, memoryStore: new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE)) });

    try {
      const inner = (runtime.session as unknown as { session: { getActiveToolNames(): string[] } }).session;
      const active = inner.getActiveToolNames().slice().sort();
      const inventory = sourceInventory();
      expect(inventory.filter((name) => !active.includes(name)), "真实清单漏挂来源工具").toEqual([]);
      expect(active.filter((name) => !inventory.includes(name)), "真实清单有来源未覆盖的工具").toEqual([]);
      expect(new Set(active).size, "工具名不得重复").toBe(active.length);
      expect(active).toContain("take_tab");
      expect(active).toContain("send_user_message");
    } finally {
      runtime.dispose();
    }
  }, 30_000);
});

/** Real Pi lifecycle and registered tools; a local finite model only captures model inputs. */
async function taskSurfaceSession() {
  const { BrowserAgentSession } = await import('../src/session.js');
  const replies:Array<(input:ScriptedInput)=>any[]> = [];
  const models = scriptedModels(replies, null);
  const inputs = models.inputs;
  const progress = new TaskProgress('default');
  const wire = new ToolRpc(), frames:Array<{name:string}>=[];
  wire.setPageTarget(undefined,7);
  wire.setSend(frame=>{frames.push(frame);wire.handleResult(frame.id,frame.name!=='fill',
    {tabId:7,value:'星河'},frame.name==='fill'?'receipt lost':undefined,frame.name==='fill'?'unknown':'executed');});

  const host = await BrowserAgentSession.create(wire, {
    emit:event=>progress.observe({type:'agent_event',event}),setStatus:()=>{},
  }, {conversationId:'default',loop:{models,cwd:'/tmp'},modelPattern:PROBE_PATTERN,customTools:createBrowserTools(wire,
    undefined,undefined,undefined,{epoch:()=>host.executionEpoch(),canWrite:id=>host.canWriteCurrentInput(id),
      assertCall:(name,params,id)=>host.assertTaskResultExecution(name,params,id)})});

  expect(host.available).toBe(true);
  host.bindConversationContext(()=>progress.snapshot());
  host.bindTaskResults({getSnapshot:()=>progress.snapshot(),
    register:items=>progress.registerResults(items),verify:input=>progress.verifyUnknownResult(input)});
  const inner = (host as unknown as {session:{prompt(text:string):Promise<void>}}).session;

  return {host,progress,inputs,replies,frames,prompt:()=>inner.prompt('检查本轮工具契约'),
    close:()=>{host.dispose();}};
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

  it('每次输入按当前 run 收起手工入口，重新拼装工具不重新暴露',async()=>{
    const h=await taskSurfaceSession();

    try {
      expect(h.host.isToolActive('record_task_results')).toBe(true);
      h.progress.request('把代号填成星河，不要保存或提交');
      await h.prompt();
      const input=h.inputs.at(-1)!;
      expect(input.tools?.map(t=>t.name)).not.toContain('record_task_results');
      expect(input.tools?.map(t=>t.name)).toEqual(expect.arrayContaining(['resolve_unknown_result','send_user_message']));
      expect(input.tools?.map(t=>t.name)).not.toEqual(expect.arrayContaining(['task_goals']));
      expect(input.tools?.map(t=>t.name)).not.toEqual(expect.arrayContaining(['capture_page_material']));
      expect(input.systemPrompt).not.toContain('record_task_results');
      expect(input.tools?.find(t=>t.name==='resolve_unknown_result')?.description).not.toContain('record_task_results');

      expect(h.host.isToolActive('record_task_results')).toBe(false);

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
