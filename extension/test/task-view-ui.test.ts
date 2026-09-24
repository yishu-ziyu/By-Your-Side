/**
 * T03 任务条：界面事实、材料入口与控制文案。
 *
 * 这里检查的是「界面说的是不是真的」——组件只消费真实事实（task_view / 实际发出的请求 / 回执），
 * 所以断言重点是：没有收到证据就不升级事实（A03-01）、材料与实际送入一致（A03-02）、
 * 作用页不跟随当前标签页（A03-03）、控制区分请求中与已生效（A03-04）、
 * 不制造进度（A03-05）、切会话与重放不串（A03-06）、控件可键盘到达（A03-07 的结构面）。
 * 320px 窄栏、帧级时序与真人可读性在 scripts/acceptance/task-bar-*.mts 里单列。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskView } from "../../shared/task-view.js";
import type { TaskReceipt } from "../../shared/task-actions.js";
import { TaskProgress } from "../../agent/src/task-progress.js";
import { projectTaskView } from "../../shared/task-view.js";
import { parseServerMessage } from "../../shared/protocol.js";
import {
  CONTROL_PENDING_TIMEOUT_MS,
  TaskBar,
  activityText,
  buildTaskBarModel,
  controlCopy,
  pageLabelOf,
  stateHeadline,
  waitingCopy,
  type ControlState,
  type TaskBarInputs,
} from "../src/sidepanel/task-bar.js";

// ── 最小 DOM：只实现任务条真正用到的那一部分 ───────────────────────
type Listener = (event: { target: FakeElement; type: string }) => void;

class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  className = "";
  id = "";
  hidden = false;
  listeners = new Map<string, Listener[]>();
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return this.children.length ? this.children.map((child) => child.textContent).join("") : this.text;
  }
  set textContent(value: string) {
    this.text = value ?? "";

    for (const child of this.children) child.parent = null;
    this.children = [];
  }

  /** 真实 DOM 里 title/type 会反映到属性上，假 DOM 照做，避免测出假差异。 */
  get type(): string { return this.attributes.get("type") ?? ""; }
  set type(value: string) { this.attributes.set("type", value); }
  get title(): string { return this.attributes.get("title") ?? ""; }
  set title(value: string) { this.attributes.set("title", value); }

  append(...nodes: FakeElement[]): void { for (const node of nodes) this.appendChild(node); }
  appendChild(node: FakeElement): FakeElement { node.parent = this; this.children.push(node);

 return node; }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  /** 冒泡派发：任务条在根节点上监听 click。 */
  dispatch(type: string, target: FakeElement = this): void {
    let node: FakeElement | null = target;

    while (node) {
      for (const listener of node.listeners.get(type) ?? []) listener({ target, type });
      node = node.parent;
    }
  }
  private matches(selector: string): boolean {
    const attrMatch = /^([a-z]*)\[([^=\]]+)(?:=([^\]]+))?\]$/i.exec(selector);

    if (attrMatch) {
      const [, tag, name, value] = attrMatch;

      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const actual = this.getAttribute(name!);

      if (actual === null) return false;

      return value === undefined || actual === value.replace(/^["']|["']$/g, "");
    }

    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));

    if (selector.startsWith("#")) return this.id === selector.slice(1);

    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];

    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };

    walk(this);

    return found;
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): FakeElement | null {
    const walk = (node: FakeElement | null): FakeElement | null => {
      if (node === null) return null;

      if (node.matches(selector)) return node;

      return walk(node.parent);
    };

    return walk(this);
  }
}

function fakeDocument() {
  return {
    createElement: (tag: string) => new FakeElement(tag),
  } as unknown as Document;
}

// ── 事实夹具 ───────────────────────────────────────────────────────
const CONV = "conv-a";

function view(overrides: Partial<TaskView> = {}): TaskView {
  return {
    conversationId: CONV,
    runId: "run-1",
    controlVersion: 0,
    observedAt: 1_000,
    state: "running",
    goal: "把报名表里的电话补齐",
    revisions: [],
    page: { tabId: 7, urlHash: "hash-a" },
    active: [{ member: "main", action: "读取页面", since: 1_000 }],
    lastAction: { action: "读取页面", failed: false, at: 1_000 },
    waiting: null,
    results: [],
    outstanding: [],
    latestDelivery: null,
    resumable: false,
    ...overrides,
  };
}

function receipt(overrides: Partial<TaskReceipt> = {}): TaskReceipt {
  return {
    requestId: "req-1",
    conversationId: CONV,
    source: "text",
    action: "start",
    runId: "run-1",
    text: "把报名表里的电话补齐",
    targetTitle: "新会话",
    status: "accepted",
    message: "已接收新任务",
    updatedAt: 2_000,
    ...overrides,
  };
}

const idleControl = (): ControlState => ({
  takeover: { pending: false, since: null, failReason: null },
  stop: { pending: false, since: null, accepted: false, failReason: null },
});

function inputs(overrides: Partial<TaskBarInputs> = {}): TaskBarInputs {
  return {
    view: view(),
    draft: null,
    sending: [],
    taskMaterials: null,
    control: idleControl(),
    pageLabel: "报名表（forms.example）",
    activeTabId: 7,
    pageTabId: 7,
    now: 1_500,
    ...overrides,
  };
}

function mount(options: Partial<ConstructorParameters<typeof TaskBar>[0]> = {}) {
  const root = new FakeElement("div");
  const removeDraftAttachment = vi.fn();
  const removeDraftSelection = vi.fn();
  const onRetryControl = vi.fn();

  const bar = new TaskBar({
    root: root as unknown as HTMLElement,
    resolvePage: async () => ({ title: "报名表", url: "https://forms.example/edit" }),
    getActiveTabId: async () => 7,
    removeDraftAttachment,
    removeDraftSelection,
    onRetryControl,
    currentConversationId: () => CONV,
    now: () => 1_500,
    doc: fakeDocument(),
    ...options,
  });

  const text = () => root.querySelector(".task-bar")!.textContent;

  return { root, bar, removeDraftAttachment, removeDraftSelection, onRetryControl, text, element: () => root.querySelector(".task-bar")! };
}

describe("任务条文案：真实原因，不合并成含糊状态", () => {
  it("重建面板和宿主检查点后恢复本 run 材料，拒绝的补充不进入材料", () => {
    const progress = new TaskProgress(CONV);
    progress.request('读选区与附件', { tabId: 7, title: '活动说明', url: 'https://forms.example/edit?token=secret', selection: { text: '退票说明原文' } }, [
      { type: 'image', id: 'image-1', name: '参考截图.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' },
    ]);
    const revoke = progress.recordRequirement('未接受补充', undefined, [{ type: 'image', id: 'rejected-image', name: '未接受.png', mimeType: 'image/png', dataBase64: 'd29ybGQ=' }]);
    revoke();
    const restored = new TaskProgress(CONV);
    restored.restoreResults(JSON.parse(JSON.stringify(progress.snapshot())));
    const message = parseServerMessage(JSON.stringify({ type: 'task_view', conversationId: CONV, view: projectTaskView(restored.snapshot()) }));

    if (message?.type !== 'task_view') throw new Error('材料未通过协议');
    const h = mount();
    h.bar.updateView(message.view);
    expect(h.text()).toContain('退票说明原文');
    expect(h.text()).toContain('参考截图.png');
    expect(h.text()).not.toContain('未接受.png');
    expect(JSON.stringify(message.view)).not.toContain('token=secret');
    h.bar.updateView({ ...message.view, conversationId: 'other' });
    expect(h.text()).toContain('参考截图.png');
    restored.abort();
    restored.request('新任务');
    h.bar.updateView(projectTaskView(restored.snapshot()));
    expect(h.text()).not.toContain('参考截图.png');
    h.bar.dispose();
  });
  it("阻塞原因逐条可读，未知原因不吞掉原文", () => {
    expect(waitingCopy("human_control", null).text).toBe("页面已交给你，Agent 暂停等待");
    expect(waitingCopy("failure_limit", null).text).toContain("连续失败");
    expect(waitingCopy("readback_required", null).text).toBe("Agent 尚需核对页面结果");
    expect(waitingCopy("unknown_with_baseline", null).text).toContain("结果未知");
    expect(waitingCopy("restart_checkpoint", "host_restart").detail).toContain("伴随进程");
    expect(waitingCopy("runtime_error", null).text).toBe("运行出错");
    expect(waitingCopy("some_new_reason", "raw detail")).toEqual({ text: "some_new_reason", detail: "raw detail" });
  });

  it("状态层说清现在该谁行动", () => {
    expect(stateHeadline("running")).toBe("正在执行");
    expect(stateHeadline("paused")).toContain("页面归你");
    expect(stateHeadline("interrupted")).toContain("可继续");
    expect(stateHeadline("aborted")).toBe("已停止");
    expect(stateHeadline("none")).toBe("");
  });

  it("活动行只在有真实活动时出现，worker 带名字", () => {
    expect(activityText(view())).toBe("读取页面");
    expect(activityText(view({ active: [{ member: "worker-2", action: "核对字段", since: 1 }] }))).toContain("核对字段");
    expect(activityText(view({ active: [] }))).toBeNull();
  });

  it("页面标签用标题＋域名，缺标题时退回域名", () => {
    expect(pageLabelOf({ title: "报名表", url: "https://forms.example/edit" })).toBe("报名表（forms.example）");
    expect(pageLabelOf({ url: "https://forms.example/edit" })).toBe("forms.example");
    expect(pageLabelOf({})).toBe("页面");
  });
});

describe("A03-04 控制请求：请求中 / 已生效 / 未生效三阶段分开", () => {
  const control = (over: Partial<ControlState> = {}): ControlState => ({ ...idleControl(), ...over });

  it("请求中只写请求中，不说已停手", () => {
    const note = controlCopy(control({ stop: { pending: true, since: 1_000, accepted: false, failReason: null } }), "running", 1_500);
    expect(note?.phase).toBe("requested");
    expect(note?.text).toContain("等 Agent 收手");
    expect(note?.text).not.toContain("已停止");
  });

  it("回执已受理但状态未变：写「已受理…正在停」，仍不宣布停手", () => {
    const note = controlCopy(control({ stop: { pending: true, since: 1_000, accepted: true, failReason: null } }), "running", 1_500);
    expect(note?.phase).toBe("requested");
    expect(note?.text).toContain("已受理");
  });

  it("状态已经不在 running：控制行让位给状态层", () => {
    expect(controlCopy(control({ stop: { pending: true, since: 1_000, accepted: true, failReason: null } }), "aborted", 1_500)).toBeNull();
    expect(controlCopy(control({ takeover: { pending: true, since: 1_000, failReason: null } }), "paused", 1_500)).toBeNull();
  });

  it("超时未确认：如实说没得到确认，并给出重试入口", () => {
    const note = controlCopy(control({ takeover: { pending: true, since: 1_000, failReason: null } }), "running", 1_000 + CONTROL_PENDING_TIMEOUT_MS + 1);
    expect(note?.phase).toBe("unconfirmed");
    expect(note?.tone).toBe("fail");
    expect(note?.retry).toBe("takeover");
    expect(note?.text).toContain("还没得到确认");
  });

  it("失败原因保留并指出可再试", () => {
    const note = controlCopy(control({ takeover: { pending: false, since: null, failReason: "页面控制没有生效" } }), "running", 1_500);
    expect(note?.tone).toBe("fail");
    expect(note?.text).toContain("页面控制没有生效");
  });

  it("控制状态由 task_view 权威收敛：接管成功、停止结束都不再显示请求中", () => {
    const { bar } = mount();
    bar.noteControlRequested("takeover");
    expect(bar.getModel()?.control?.phase).toBe("requested");
    bar.noteControlRequested("stop");
    bar.updateView(view({ state: "paused" }));
    expect(bar.getModel()?.control).toBeNull();
    bar.updateView(view({ state: "running" }));
    bar.updateView(view({ state: "aborted" }));
    expect(bar.getModel()?.control).toBeNull();
  });

  it("失败后点「再试」走真实控制入口", () => {
    const { bar, element, onRetryControl } = mount();
    bar.noteControlResult("takeover", false, "页面控制没有生效");
    const retry = element().querySelector(".tb-control-retry")!;
    expect(retry.tagName).toBe("BUTTON");
    expect(retry.getAttribute("type")).toBe("button");
    retry.dispatch("click");
    expect(onRetryControl).toHaveBeenCalledWith("takeover");
  });
});

describe("A03-01 本地反馈：没有 accepted 证据不写已接收", () => {
  it("刚发出：材料只说发送中，界面任何位置都不出现已接收/百分比/剩余", () => {
    const { bar, text } = mount();
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    expect(text()).toContain("发送中，尚未确认接收");
    expect(text()).not.toContain("已接收");
    expect(text()).not.toContain("已随任务送入");
    expect(text()).not.toMatch(/%|％|剩余/);
  });

  it("回执 accepted 才升级为「已随任务送入」，并带上 run", () => {
    const { bar, text } = mount();
    bar.updateView(view());
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    bar.noteReceipt(receipt());
    expect(text()).toContain("已随任务送入");
    expect(text()).not.toContain("发送中");
  });

  it("中间态 queued 不改口径，unknown 如实说未知", () => {
    const { bar, text } = mount();
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    bar.noteReceipt(receipt({ status: "queued" }));
    expect(text()).toContain("发送中");
    bar.noteReceipt(receipt({ status: "unknown", message: "回执不明" }));
    expect(text()).toContain("接收状态未知");
    expect(text()).not.toContain("已接收");
  });

  it("被拒绝：写明未接收，不留下发送中", () => {
    const { bar, text } = mount();
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    bar.noteReceipt(receipt({ status: "rejected", message: "连接尚未恢复" }));
    expect(text()).toContain("未接收");
    expect(text()).not.toContain("发送中");
  });

  it("还没拿到页面快照的普通发送：先只有「发送中」，不因为没行就整块消失", () => {
    const { bar, text } = mount();
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: null, attachments: [] });
    expect(text()).toContain("发送中，尚未确认接收");
    expect(bar.getModel()?.visible).toBe(true);
    expect(bar.getModel()?.materials?.rows).toEqual([]);
  });

  it("发送时补上的页面材料也算这一次的材料", () => {
    const { bar, text } = mount();
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: null, attachments: [] });
    bar.noteRequestPage("req-1", { tabId: 7, title: "报名表", url: "https://forms.example/edit" });
    expect(text()).toContain("报名表（forms.example）");
  });
});

describe("A03-02 材料入口：界面与实际送入一致，草稿可移除", () => {
  it("草稿列出页面/选区/附件，只有能移除的项有移除按钮", () => {
    const { bar, text, element } = mount();
    bar.setDraft({
      page: { tabId: 7, title: "报名表", url: "https://forms.example/edit" },
      selection: "只保留前三行",
      attachments: [{ id: "att-1", name: "截图.png" }],
    });
    expect(text()).toContain("待发送材料 · 3 项");
    expect(text()).toContain("只保留前三行");
    expect(text()).toContain("截图.png");
    const removable = element().querySelectorAll(".tb-remove").map((button) => button.getAttribute("data-remove-key"));
    expect(removable).toEqual(["draft:sel", "draft:att:att-1"]);

    for (const button of element().querySelectorAll(".tb-remove")) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("aria-label")).toContain("移除");
    }
  });

  it("草稿没有别的材料、也没写正文时不占位", () => {
    const { bar } = mount();
    bar.setDraft({ page: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, selection: null, attachments: [] });
    expect(bar.getModel()?.visible).toBe(false);
    bar.setDraft({ page: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, selection: null, attachments: [] }, true);
    expect(bar.getModel()?.visible).toBe(true);
    expect(bar.getModel()?.materials?.rows.map((row) => row.kind)).toEqual(["page"]);
  });

  it("移除走真实入口：附件按 id、选区走引用条", () => {
    const { bar, element, removeDraftAttachment, removeDraftSelection } = mount();
    bar.setDraft({
      page: { tabId: 7, title: "报名表", url: "https://forms.example/edit" },
      selection: "只保留前三行",
      attachments: [{ id: "att-1", name: "截图.png" }, { id: "att-2", name: "表格.png" }],
    });
    element().querySelector("button[data-remove-key=\"draft:att:att-2\"]")!.dispatch("click");
    expect(removeDraftAttachment).toHaveBeenCalledWith("att-2");
    element().querySelector("button[data-remove-key=\"draft:sel\"]")!.dispatch("click");
    expect(removeDraftSelection).toHaveBeenCalled();
  });

  it("被移除的材料不会再出现在送给任务的材料里", () => {
    const { bar, text } = mount();
    bar.updateView(view({ page: null }));
    // 用户移除了附件 att-2：发送时快照里就没有它
    bar.setDraft({
      page: { tabId: 7, title: "报名表", url: "https://forms.example/edit" },
      selection: "只保留前三行",
      attachments: [{ id: "att-1", name: "截图.png" }],
    });
    bar.noteRequestSent({
      requestId: "req-1",
      action: "start",
      context: { tabId: 7, title: "报名表", url: "https://forms.example/edit", selection: { text: "只保留前三行" } },
      attachments: [{ id: "att-1", name: "截图.png" } as never],
    });
    bar.setDraft(null);
    bar.noteReceipt(receipt({ requestId: "req-1" }));
    expect(text()).toContain("截图.png");
    expect(text()).not.toContain("表格.png");
    expect(text()).toContain("只保留前三行");
    expect(text()).toContain("报名表（forms.example）");
  });

  it("运行中补发的插话和原任务材料并排展示，且标明还有多少项在等回执", () => {
    const { bar, text } = mount();
    bar.updateView(view());
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    bar.noteReceipt(receipt({ requestId: "req-1" }));
    bar.noteRequestSent({ requestId: "req-2", action: "steer", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit", selection: { text: "电话列也补上" } }, attachments: [] });
    expect(text()).toContain("已随任务送入");
    expect(text()).toContain("另有 2 项材料待确认");
    expect(text()).toContain("发送中，尚未确认接收");
    expect(text()).toContain("电话列也补上");
  });

  it("运行中材料不给移除按钮（改材料必须走输入框插话）", () => {
    const { bar, element } = mount();
    bar.updateView(view());
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit", selection: { text: "只保留前三行" } }, attachments: [{ id: "att-1", name: "截图.png" } as never] });
    bar.noteReceipt(receipt({ requestId: "req-1" }));
    expect(element().querySelectorAll(".tb-remove")).toHaveLength(0);
  });

  it("任务结束后顶部不留任务条：结论在回答里，已送入的材料不再常驻", () => {
    const { bar } = mount();
    bar.updateView(view());
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    bar.noteReceipt(receipt({ requestId: "req-1" }));
    expect(bar.getModel()?.visible).toBe(true);
    bar.updateView(view({ state: "idle", outstanding: [{ id: "r1", description: "填写邮箱", status: "pending" }], resumable: true }));
    expect(bar.getModel()?.visible).toBe(false);
  });
});

describe("A03-03 作用页：以任务绑定页为准，不跟随当前标签页", () => {
  it("任务页与当前页不同：明确提示任务仍作用于那一页，任务材料里没有当前页", () => {
    const model = buildTaskBarModel(inputs({
      activeTabId: 99,
      taskMaterials: { runId: "run-1", items: [{ key: "task:page", kind: "page", label: "报名表（forms.example）" }] },
    }));

    expect(model.page?.mismatch).toBe(true);
    expect(model.materials?.rows.map((row) => row.label)).toEqual(["报名表（forms.example）"]);
    const { bar, text } = mount({ getActiveTabId: async () => 99, resolvePage: async () => ({ title: "报名表", url: "https://forms.example/edit" }) });
    bar.updateView(view());
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    bar.noteReceipt(receipt({ requestId: "req-1" }));
    expect(text()).toContain("作用于：");
    expect(text()).not.toContain("别的页面");
  });

  it("没有可靠页面证据时不猜：page 为 null，界面不编页面", () => {
    const model = buildTaskBarModel(inputs({ view: view({ page: null }), pageTabId: null, pageLabel: null }));
    expect(model.page).toBeNull();
  });
});

describe("A03-05 不制造进度：没有新事实就不出现新数字", () => {
  it("运行中只显示真实活动与已运行时长，没有百分比/剩余时间", () => {
    const model = buildTaskBarModel(inputs());
    expect(model.headline).toBe("正在执行");
    expect(model.activity).toContain("读取页面");
    expect(model.activity).toContain("0.5");
    expect(JSON.stringify(model)).not.toMatch(/%|剩余/);
  });

  it("静默不到 15 秒不提示「距上次动作」，超过才如实显示", () => {
    const silent = view({ active: [], lastAction: { action: "读取页面", failed: false, at: 1_000 } });
    expect(buildTaskBarModel(inputs({ view: silent, now: 5_000 })).idleAge).toBeNull();
    expect(buildTaskBarModel(inputs({ view: silent, now: 20_000 })).idleAge).toContain("距上次动作");
  });

  it("非运行态不排动画/计时器，界面也不依赖动效", () => {
    vi.useFakeTimers();

    try {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const { bar, element } = mount();
      bar.updateView(view({ state: "paused" }));
      bar.updateView(view({ state: "idle", active: [] }));
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(element().querySelectorAll(".tb-spinner")).toEqual([]);
      expect(element().getAttribute("style")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("阻塞时露出真实原因，并保留可用控制入口", () => {
    const model = buildTaskBarModel(inputs({
      view: view({ state: "interrupted", waiting: { reason: "restart_checkpoint", detail: "host_restart" }, resumable: true }),
    }));

    expect(model.waiting?.text).toContain("检查点");
    expect(model.waiting?.detail).toContain("伴随进程");
    expect(model.headline).toContain("已中断");
  });
});

describe("A03-06 切会话与重放：身份一致、渲染幂等", () => {
  it("不属于当前会话的视图不改写任务条", () => {
    const { bar } = mount();
    bar.updateView(view({ conversationId: "conv-b", goal: "别人的任务" }));
    expect(bar.getModel()?.visible).toBe(false);
    bar.updateView(view());
    expect(bar.getModel()?.goal).toContain("报名表");
    bar.updateView(view({ conversationId: "conv-b", goal: "别人的任务" }));
    expect(bar.getModel()?.goal).toContain("报名表");
  });

  it("同一视图重复下发（重放/重连）不产生重复节点", () => {
    const { bar, element } = mount();
    bar.updateView(view());
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [{ id: "att-1", name: "截图.png" } as never] });
    bar.noteReceipt(receipt({ requestId: "req-1" }));
    const before = element().querySelectorAll(".tb-mat").length;
    const textBefore = element().textContent;

    for (let i = 0; i < 3; i += 1) bar.updateView(view());
    expect(element().querySelectorAll(".tb-mat")).toHaveLength(before);
    expect(element().querySelectorAll(".tb-remove")).toHaveLength(0);
    expect(element().textContent).toBe(textBefore);
  });

  it("切会话重置：旧任务、旧材料、旧控制态都不留", () => {
    const { bar, text } = mount();
    bar.updateView(view());
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    bar.noteReceipt(receipt({ requestId: "req-1" }));
    bar.noteControlResult("takeover", false, "页面控制没有生效");
    bar.reset();
    expect(bar.getModel()?.visible).toBe(false);
    expect(text()).not.toContain("已随任务送入");
    expect(text()).not.toContain("接管未生效");
    bar.updateView(view());
    expect(text()).not.toContain("已随任务送入");
  });

  it("换 run 不再展示上一个 run 的材料", () => {
    const { bar, text } = mount();
    bar.noteRequestSent({ requestId: "req-1", action: "start", context: { tabId: 7, title: "报名表", url: "https://forms.example/edit" }, attachments: [] });
    bar.noteReceipt(receipt({ requestId: "req-1" }));
    bar.updateView(view({ runId: "run-2" }));
    expect(text()).not.toContain("已随任务送入");
  });
});

describe("A03-07 可达性结构面：真实 button、屏幕阅读器有名字、键盘顺序确定", () => {
  it("控件都是 button[type=button]，状态行 aria-live，移除按钮有可读名字", () => {
    const { bar, element } = mount();
    bar.updateView(view());
    bar.setDraft({
      page: { tabId: 7, title: "报名表", url: "https://forms.example/edit" },
      selection: "只保留前三行",
      attachments: [{ id: "att-1", name: "截图.png" }],
    });
    bar.noteControlResult("takeover", false, "页面控制没有生效");
    const buttons = [...element().querySelector(".tb-materials")!.querySelectorAll("button"), element().querySelector(".tb-control-retry")!];
    expect(buttons.length).toBeGreaterThanOrEqual(3);

    for (const button of buttons) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("tabindex")).toBeNull();
    }

    expect(element().querySelector(".tb-status")!.getAttribute("role")).toBe("status");
    expect(element().querySelector(".tb-status")!.getAttribute("aria-live")).toBe("polite");
    expect(element().getAttribute("aria-label")).toBe("当前任务");
    // 屏幕阅读器所需的完整目标在 title 上保留，不受视觉截断影响
    const long = "把这份报名表里所有缺电话的行补齐，并在备注里写清楚每一条的来源和核对时间";
    bar.updateView(view({ goal: long }));
    expect(element().querySelector(".tb-goal")!.getAttribute("title")).toBe(long);
  });

  it("有目标就有目标行，没有目标也不留空标题", () => {
    const { bar, element } = mount();
    bar.updateView(view({ goal: null }));
    expect(element().querySelector(".tb-goal")!.textContent).toContain("目标未记录");
  });
});

describe("任务条生命周期", () => {
  it("dispose 之后不再改 DOM、不再定时", () => {
    vi.useFakeTimers();

    try {
      const { bar, text } = mount();
      bar.updateView(view());
      const before = text();
      bar.dispose();
      bar.updateView(view({ goal: "换了个目标" }));
      bar.noteControlRequested("stop");
      expect(text()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => vi.restoreAllMocks());
});
