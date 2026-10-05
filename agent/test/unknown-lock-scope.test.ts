/**
 * 结果不确定时只拦可能重复造成后果的操作（docs/evals/20261001-unknown-lock-scope.md 标准 1、2、4 的宿主一侧）。
 * 来源：GitHub #22（只读调用、未执行的点击、navigate、开标签页被「当前写入已暂停」拦下，full-1 共 53 条）、
 * #23（关弹窗被锁拦下）、#27（「元素不可填充」后上锁）；10-01 用户裁决：看网页、打开新页面、关弹窗照常，
 * 不确定刷卡成没成就不让它再点付款（以及提交、发送、删除）。
 *
 * 走生产装配（createConversationRuntime + 真实 TaskProgress 账本），每一步经 browser_run 程序发出（#22 的 BYS-076/090 即此路径，
 * 每步都有执行事实与账本记录），扩展一侧用假回执；只看对外结果：调用有没有发到扩展、账本里有没有「结果不确定」。
 *
 * 失败方式（先列，每条对应下面一个断言）：
 * L1 付款点击结果不确定后，读页、滚动、圈画、导航、开/切标签页、GET 取数、确认或关闭原生弹窗仍被拦（没发到扩展）；
 * L2 反向过宽：结果不确定后，点击、填写、按键、页面脚本、带 body 的 POST 仍发了出去（可能重复付款/提交）；
 * L3 反向过宽：同一个不确定的付款按钮被自动再点一次；
 * L4 放行这些步骤时把那条不确定悄悄抹掉（不再是 unknown），等于跳过核查；
 * L5 扩展回「未执行」（目标被覆盖、元素不可填充）的点击/填写仍被记成结果不确定，锁住下一次点击；
 * L6 GET 取数超时（扩展回执结果未知）被记成结果不确定，锁住下一次点击；
 * L7 断连/超时后扩展补报「未执行」，这一步仍保持不确定、继续上锁；
 * L8 确认原生弹窗本身结果不确定（它可能就是「确定付款」那一下），之后的点击不再受保护；
 * L9 声明 readonly:true 的页面脚本超时：记失败、不上锁，下一次点击照常发出（#22 BYS-109/090）；
 * L10 反向过宽：没声明 readonly 的页面脚本超时仍上锁（脚本可能改了页面）；
 * L11 反向过宽：真正结果不确定的提交点击仍上锁。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, ToolExecutionFact } from "../../shared/protocol.js";
import { TaskProgress } from "../src/task-progress.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "./fixtures/file-document.js";
import { PROBE_PATTERN, scriptedModels } from "./fixtures/scripted-loop.js";

const dirs: string[] = [];

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Frame = Extract<ServerMessage, { type: "tool_call" }>;

type Reply = { ok: true; data: unknown } | { ok: false; error: string; fact: ToolExecutionFact } | "silent";

const page = { tabId: 7, title: "结账", url: "http://shop.test/checkout" };

/** 一步程序的参数：目标、网址、标签页号、滚动距离、要填的值等，都是字符串或数字。 */
type StepParams = Record<string, string | number | boolean>;

/** 扩展一侧的假回执：special 先挑，其余按工具给一条已执行的回执。 */
async function lead(special: (frame: Frame) => Reply | null = () => null) {
  const { createConversationRuntime } = await import("../src/conversation-runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "bys-lock-scope-"));
  dirs.push(dir);
  const progress = new TaskProgress("default");
  const frames: Frame[] = [];
  let reply: ((frame: Frame) => void) | undefined;

  /** 伴随进程发往扩展的出口：调用帧交给假扩展，其余消息喂给任务进度。 */
  const sink = (msg: ServerMessage) => {
    if (msg.type === "tool_call") {
      frames.push(msg);
      queueMicrotask(() => reply?.(msg));
    } else progress.observe(msg);
  };

  const runtime = await createConversationRuntime("default", sink, PROBE_PATTERN, { loop: { models: scriptedModels(), cwd: "/tmp" }, memoryStore: new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE)) });

  reply = frame => {
    const scripted = special(frame);

    if (scripted === "silent") return;

    if (scripted) {
      if (scripted.ok) runtime.rpc.handleResult(frame.id, true, scripted.data, undefined, "executed");
      else runtime.rpc.handleResult(frame.id, false, undefined, scripted.error, scripted.fact);

      return;
    }

    const data = new Map<string, object>(Object.entries({
      snapshot: { text: "button \"付款\" button \"取消\"", tabId: 7, url: page.url },
      read_element: { textContent: "订单待支付", tabId: 7 },
      navigate: { url: "http://shop.test/orders", title: "我的订单", readiness: "complete" },
      open_tab: { tabId: 9, url: "http://shop.test/help", title: "帮助" },
      switch_tab: { tabId: 7, url: page.url, title: page.title },
      fetch: { url: String(frame.params.url), status: 200, ok: true, contentType: "application/json", bytes: 2, truncated: false, text: "{}" },
      accept_dialog: { accepted: true, dialog: { type: "confirm", message: "确定付款？", tabId: 7 } },
      dismiss_dialog: { dismissed: true, dialog: { type: "confirm", message: "确定付款？", tabId: 7 } },
      worker_tabs: { tabIds: [7], workers: [] },
      click: { clicked: true },
      fill: { filled: true },
      scroll: { scrolled: true },
      mark: { marked: true },
    }));

    runtime.rpc.handleResult(frame.id, true, data.get(frame.name) ?? {}, undefined, "executed");
  };

  runtime.session.bindConversationContext(() => progress.snapshot());
  progress.request("帮我付款，然后去订单页看看", page);
  progress.observe({ type: "agent_event", event: { kind: "agent_start" } });
  const inner = runtime.session["session"];

  if (!inner) throw new Error("会话没有建成");

  const browserRun = inner.getToolDefinition("browser_run");

  if (!browserRun) throw new Error("没有 browser_run");

  /** 模型写的一步程序：browser.<工具>(参数)。SAFETY: browser_run 的 execute 不读取 ctx 参数。 */
  const tool = (name: string, params: StepParams = {}) =>
    browserRun.execute(`call-${name}-${Math.random()}`, { code: `return await browser.${name}(${JSON.stringify(params)});` } as never, undefined, undefined, {} as never) as Promise<Awaited<ReturnType<ToolDefinition["execute"]>>>;

  const unknown = () => (progress.snapshot().results ?? []).filter(item => item.status === "unknown").map(item => `${item.tool} ${item.target ?? ""}`.trim());
  const sent = (name: string) => frames.filter(frame => frame.name === name).length;

  /** 断连后重新接上同一个出口（与 createConversationRuntime 接线时一致）。 */
  const reconnect = () => runtime.rpc.setSend(frame => sink({ ...frame, conversationId: "default" }));

  return { runtime, progress, frames, tool, unknown, sent, reconnect };
}

const PAY_TIMES_OUT = (frame: Frame): Reply | null =>
  frame.name === "click" && frame.params.target === "#pay" ? { ok: false, error: 'Tool call "click" timed out after 30000ms', fact: "unknown" } : null;

describe("付款结果不确定之后", () => {
  it("L1/L4 看页、换页、GET 取数、处理原生弹窗照常发到扩展，那条不确定仍保留待核查", async () => {
    const h = await lead(PAY_TIMES_OUT);

    try {
      await expect(h.tool("click", { target: "#pay", label: "付款" })).rejects.toThrow(/timed out/);
      expect(h.unknown()).toEqual(["click #pay"]);

      const proceed: Array<[string, StepParams, string]> = [
        ["snapshot", {}, "snapshot"],
        ["read_element", { target: "#status" }, "read_element"],
        ["scroll", { dy: 400 }, "scroll"],
        ["mark", { target: "#status", label: "看这里" }, "mark"],
        ["navigate", { url: "http://shop.test/orders" }, "navigate"],
        ["open_tab", { url: "http://shop.test/help" }, "open_tab"],
        ["switch_tab", { tabId: 7 }, "switch_tab"],
        ["fetch", { url: "http://shop.test/api/orders" }, "fetch"],
        ["accept_dialog", {}, "accept_dialog"],
        ["dismiss_dialog", {}, "dismiss_dialog"],
      ];

      for (const [name, params, rpcName] of proceed) {
        const before = h.sent(rpcName);
        await h.tool(name, params);
        expect(h.sent(rpcName), `${name} ${JSON.stringify(params)}`).toBe(before + 1);
      }

      expect(h.unknown()).toEqual(["click #pay"]);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("L2/L3 可能重复付款或提交的操作都不发到扩展，付款按钮也不会被再点", async () => {
    const h = await lead(PAY_TIMES_OUT);

    try {
      await expect(h.tool("click", { target: "#pay", label: "付款" })).rejects.toThrow(/timed out/);
      const before = h.frames.length;
      await expect(h.tool("click", { target: "#pay", label: "付款" })).rejects.toThrow(/不能自动重做/);
      await expect(h.tool("click", { target: "#confirm-order" })).rejects.toThrow(/当前写入已暂停/);
      await expect(h.tool("fill", { target: "#coupon", value: "SAVE10" })).rejects.toThrow(/当前写入已暂停/);
      await expect(h.tool("press_key", { key: "Enter" })).rejects.toThrow(/当前写入已暂停/);
      await expect(h.tool("js", { code: "(() => document.forms[0].submit())()" })).rejects.toThrow(/当前写入已暂停/);
      await expect(h.tool("fetch", { url: "http://shop.test/api/pay", method: "POST", body: "{}" })).rejects.toThrow(/当前写入已暂停/);
      expect(h.frames.length).toBe(before);
      expect(h.unknown()).toEqual(["click #pay"]);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("L8 确认原生弹窗本身结果不确定时也上锁：它可能就是「确定付款」那一下", async () => {
    const h = await lead(frame => (frame.name === "accept_dialog" ? { ok: false, error: "Extension disconnected", fact: "unknown" } : null));

    try {
      await h.tool("click", { target: "#pay", label: "付款" });
      await expect(h.tool("accept_dialog", {})).rejects.toThrow(/disconnected/);
      expect(h.unknown()).toEqual(["accept_dialog"]);
      await expect(h.tool("click", { target: "#pay-again" })).rejects.toThrow(/当前写入已暂停/);
      // 弹窗本身照常可以再处理（例如关掉还开着的那个）。
      await h.tool("dismiss_dialog", {});
      expect(h.sent("dismiss_dialog")).toBe(1);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);
});

describe("确定没执行或只是取数失败的步骤不上锁", () => {
  it("L5 扩展回「目标被覆盖，操作未执行」「元素不可填充」：记为没执行，下一次点击照常发出", async () => {
    const h = await lead(frame => {
      if (frame.name === "click" && frame.params.target === "#state") return { ok: false, error: "目标被其他元素覆盖，操作未执行。请重新 snapshot 确认当前可点击目标。", fact: "not_executed" };

      if (frame.name === "fill" && frame.params.target === "@153") return { ok: false, error: "ref @153 填充失败（元素不可填充（非 input/textarea/select/contenteditable），操作未执行）", fact: "not_executed" };

      return null;
    });

    try {
      await expect(h.tool("click", { target: "#state" })).rejects.toThrow(/覆盖/);
      await expect(h.tool("fill", { target: "@153", value: "19:00" })).rejects.toThrow(/不可填充/);
      expect(h.unknown()).toEqual([]);
      await h.tool("click", { target: "#city" });
      await h.tool("fill", { target: "#delivery", value: "19:00" });
      expect(h.sent("click")).toBe(2);
      expect(h.sent("fill")).toBe(2);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("L6 GET 取数超时只是取数失败：不记结果不确定，下一次点击照常发出", async () => {
    const h = await lead(frame => (frame.name === "fetch" ? { ok: false, error: 'Tool call "fetch" timed out after 30000ms', fact: "unknown" } : null));

    try {
      await expect(h.tool("fetch", { url: "http://export.arxiv.org/api/query?search_query=speech" })).rejects.toThrow(/timed out/);
      expect(h.unknown()).toEqual([]);
      await h.tool("click", { target: "#next" });
      expect(h.sent("click")).toBe(1);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("L7 断连后扩展补报这一下「未执行」：不再上锁，下一次点击照常发出", async () => {
    let lateFrame: Frame | null = null;
    const h = await lead(frame => (frame.name === "click" && frame.params.target === "#submit" ? (lateFrame = frame, "silent") : null));

    try {
      const pending = h.tool("click", { target: "#submit" });
      await new Promise(resolve => setTimeout(resolve, 10));
      h.runtime.rpc.setSend(null);
      await expect(pending).rejects.toThrow(/disconnected/);
      expect(h.unknown()).toEqual(["click #submit"]);
      h.reconnect();
      h.runtime.rpc.handleResult(lateFrame!.id, false, undefined, "原任务已停止或发生变化，操作未执行。", "not_executed");
      expect(h.unknown()).toEqual([]);
      await h.tool("click", { target: "#other" });
      expect(h.sent("click")).toBe(2);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);
});

describe("声明只读的页面脚本（#22）", () => {
  const SCAN = "(() => [...document.querySelectorAll('h3')].map(h => h.textContent))()";
  const jsTimesOut = (frame: Frame): Reply | null => (frame.name === "js" ? { ok: false, error: 'Tool call "js" timed out after 30000ms', fact: "unknown" } : null);

  it("L9 readonly:true 的脚本超时：不记结果不确定，下一次点击照常发出", async () => {
    const h = await lead(jsTimesOut);

    try {
      await expect(h.tool("js", { code: SCAN, readonly: true })).rejects.toThrow(/timed out/);
      expect(h.unknown()).toEqual([]);
      await h.tool("click", { target: "#next" });
      expect(h.sent("click")).toBe(1);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("L10 没声明 readonly 的脚本超时：仍记结果不确定，下一次点击被拦", async () => {
    const h = await lead(jsTimesOut);

    try {
      await expect(h.tool("js", { code: SCAN })).rejects.toThrow(/timed out/);
      expect(h.unknown()).toEqual(["js"]);
      await expect(h.tool("click", { target: "#next" })).rejects.toThrow(/当前写入已暂停/);
      expect(h.sent("click")).toBe(0);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);

  it("L11 提交点击结果不确定仍上锁", async () => {
    const h = await lead(frame => (frame.name === "click" && frame.params.target === "#submit" ? { ok: false, error: 'Tool call "click" timed out after 30000ms', fact: "unknown" } : null));

    try {
      await expect(h.tool("click", { target: "#submit", label: "提交" })).rejects.toThrow(/timed out/);
      expect(h.unknown()).toEqual(["click #submit"]);
      await expect(h.tool("click", { target: "#other" })).rejects.toThrow(/当前写入已暂停/);
    } finally {
      h.runtime.dispose();
    }
  }, 30_000);
});
