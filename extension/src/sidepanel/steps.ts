/**
 * "执行步骤"聚合块的纯逻辑：工具人性化描述、步骤链、耗时格式化。
 * 与 DOM 解耦，便于单测；main.ts 负责渲染。
 */
import { displayNameFor, personFor } from "../../../shared/cast.js";
import { toolAction } from "../../../shared/user-facing.js";

export interface ToolAction {
  /** 步骤链里用的短动作名，如 "读取页面结构"。 */
  short: string;
  /** 工具卡标题，带得上关键参数就带，如 "点击「结算服务」"。 */
  full: string;
}

/** 工具名 → 中文动作；未登记的名称用共用的人话动作，不露原始名。 */
const ACTION_NAMES: Record<string, string> = {
  tabs: "标签页",
  // 合并前的旧名保留：历史会话回放里仍会出现。
  list_tabs: "列出标签页",
  get_active_tab: "定位当前页",
  open_tab: "打开标签页",
  switch_tab: "切换标签页",
  close_tab: "关闭标签页",
  navigate: "打开页面",
  snapshot: "读取页面结构",
  judge_browser_action: "判断页面操作",
  read_element: "读取完整内容",
  read_elements: "读回多个元素",
  click: "点击",
  double_click: "双击",
  drag: "拖动",
  upload_file: "上传文件",
  cdp: "调用浏览器",
  hover: "悬停",
  remember_user_preference: "记住偏好",
  browser_run: "连续操作",
  follow_route: "照上次的做法",
  route_check: "提交前核对",
  route_miss: "改为一步步看",
  wait_for: "等待元素",
  sleep: "等待",
  fill: "填写文本",
  page_operation: "填写并核对",
  page_translation: "翻译网页",
  share_tab: "安排同页协作",
  take_tab: "接管页面",
  type_text: "输入文本",
  press_key: "按键",
  scroll: "滚动页面",
  js: "执行脚本",
  screenshot: "截图",
  mark: "标注元素",
  clear_marks: "清除标注",
  arm_event: "准备接收页面事件",
  wait_event: "等待页面事件",
  spawn_worker: "请了人",
  list_workers: "名册",
  stop_worker: "停下",
  post: "投递工件",
  await_message: "等待工件",
};

function clip(text: string, max = 16): string {
  const t = text.trim();

  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string" || !url) {
    return null;
  }

  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host;
  }
  catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 工具调用 → 人性化动作描述。 */
export function describeTool(name: string, params: Record<string, unknown>): ToolAction {
  const short = ACTION_NAMES[name] ?? toolAction(name);

  switch (name) {
    case "page_translation": {
      const full = params.action === 'restore' ? '恢复网页原文'
        : params.action === 'display' ? [params.mode === 'translated' ? '只显示译文' : params.mode === 'bilingual' ? '显示双语' : '调整译文', typeof params.fontSize === 'number' ? `字号 ${params.fontSize}` : ''].filter(Boolean).join(' · ')
          : short;

      return { short: full, full };
    }

    case "tabs": {
      const action = str(params.action);

      if (action === "open") {
        const host = hostOf(params.url);

        return { short: "打开标签页", full: host ? `打开标签页 ${host}` : "打开标签页" };
      }

      const byAction: Record<string, string> = {
        list: "列出标签页",
        active: "定位当前页",
        switch: "切换标签页",
        close: "关闭标签页",
      };

      const full = action ? byAction[action] : undefined;

      return { short, full: full ?? short };
    }

    case "browser_run": {
      const label = str(params.label);

      return { short, full: label ? clip(label, 32) : short };
    }

    case "click":
    case "double_click":
    case "drag":
    case "hover": {
      const label = str(params.label);

      return { short, full: label ? `${short}「${clip(label)}」` : `${short}元素` };
    }

    case "arm_event":
      return params.type === "download" ? { short: "准备接收下载", full: "准备接收下载" } : { short, full: short };

    case "navigate": {
      const host = hostOf(params.url);

      return { short, full: host ? `打开页面 ${host}` : short };
    }

    case "open_tab": {
      const host = hostOf(params.url);

      return { short, full: host ? `打开标签页 ${host}` : short };
    }

    case "press_key": {
      const key = str(params.key);

      return { short, full: key ? `按键「${clip(key, 8)}」` : short };
    }

    case "mark": {
      if (params.clear === true) {
        return { short: "清除标注", full: "清除标注" };
      }

      const label = str(params.label);

      return { short, full: label ? `标注「${clip(label)}」` : short };
    }

    case "spawn_worker": {
      return { short, full: "安排助手" };
    }

    case "stop_worker": {
      const id = str(params.id);
      const name = id ? personFor(id)?.name : null;

      return { short, full: name ? `让 ${name} 停下` : short };
    }

    case "post": {
      const to = str(params.to);
      const who = to === "main" ? "主助手" : to ? displayNameFor(to) : null;

      return { short: "发送消息", full: who ? `发送消息给 ${who}` : "发送消息" };
    }

    case "await_message": {
      const from = str(params.from);

      return { short: "等待结果", full: from ? `等待 ${from === "main" ? "主助手" : displayNameFor(from)} 的消息` : "等待助手结果" };
    }

    default:
      return { short, full: short };
  }
}

/** 侧栏动作卡的一行字。点/填/看与页面光标旁的话同一套动词（content/cursor.ts renderActionLabel）。 */
const CURSOR_VERBS = new Map([
  ["click", { verb: "点", unnamed: "点这里" }],
  ["fill", { verb: "填", unnamed: "填这一栏" }],
  // 照上次的做法走时，选项这一步带着「日期 10 月 15 日」这样的名字（YIS-96）；模型直接调用时没有名字，仍写「选择选项」。
  ["select_option", { verb: "选", unnamed: "选择选项" }],
  ["hover", { verb: "看", unnamed: "看这里" }],
]);

export function actionCardLabel(name: string, params: Parameters<typeof describeTool>[1]): string {
  const words = CURSOR_VERBS.get(name);

  if (!words) return describeTool(name, params).full;
  const label = str(params.label);

  return label ? `${words.verb}「${clip(label)}」` : words.unnamed;
}

/**
 * 步骤链：相邻重复去重，超长时只保留最近几步（前缀 "…"）。
 * 例：思考 → 读取页面结构 → 思考 → 点击
 */
export class StepChain {
  private steps: string[] = [];
  push(label: string): void {
    if (this.steps[this.steps.length - 1] !== label) {
      this.steps.push(label);
    }
  }
  /** 最多保留最近 keep 步渲染；超出时前缀省略号。 */
  render(keep = 3): string {
    if (this.steps.length === 0) {
      return "";
    }

    const shown = this.steps.slice(-keep);
    const prefix = this.steps.length > keep ? "… → " : "";

    return prefix + shown.join(" → ");
  }
}

/** chip 状态：tool_end 前运行中；结束后按 isError 分完成/失败。 */
export type ChipState = "running" | "done" | "error";

export function chipState(ended: boolean, isError: boolean): ChipState {
  if (!ended) {
    return "running";
  }

  return isError ? "error" : "done";
}

/** 运行状态行的动作名：最近一个工具的中文动作，尚无工具时为"思考"。 */
export function loaderSubtitle(lastToolShort: string | null): string {
  return lastToolShort ?? "思考";
}

/** 耗时格式化：<10s 一位小数（"1.3s"），<60s 整数（"12s"），否则 "2m 28s"。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;

  if (s < 9.95) {
    return `${(Math.round(s * 10) / 10).toFixed(1)}s`;
  }

  if (s < 59.5) {
    return `${Math.round(s)}s`;
  }

  const m = Math.floor(s / 60);

  return `${m}m ${Math.round(s % 60)}s`;
}

/**
 * 工人事件该进哪一块执行步骤。
 * 全员 idle 时 finishRun 会清掉 currentRun；Pi 的 agent_end 紧随 idle 到达，
 * 若再 ensureRun 就会留下一块没人关掉的「处理中」。
 */
export type WorkerEventRunPolicy = "current" | "new" | "reuse-last" | "drop";

export function workerEventRunPolicy(input: {
  hasCurrentRun: boolean;
  graphRunning: boolean;
  hasLastRun: boolean;
}): WorkerEventRunPolicy {
  if (input.hasCurrentRun) {
    return "current";
  }

  if (input.graphRunning) {
    return "new";
  }

  if (input.hasLastRun) {
    return "reuse-last";
  }

  return "drop";
}

/** Legacy history has no reliable clock; never use replay wall time for it. */
export function historyEventTime(applyingHistory: boolean, occurredAt?: number): number {
  if (applyingHistory) {
    if (typeof occurredAt === "number" && Number.isFinite(occurredAt)) {
      return occurredAt;
    }

    return Number.NaN;
  }

  return Date.now();
}

/** 结束后的过程行用中文读数：「15 秒」「1 分 53 秒」。 */
export function spokenDuration(start: number, end: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const s = Math.max(1, Math.round((end - start) / 1000));

  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 过程行标题：做了几件事，以及失败/停止。 */
export function finishedRunTitle(steps: number, outcome: "failed" | "stopped" | "completed"): string {
  const done = steps > 0 ? `做了 ${steps} 件事` : "查看执行过程";

  if (outcome === "failed") return `${done}，有一件没成功`;

  if (outcome === "stopped") return `已停止 · ${done}`;

  return done;
}

export function recordedDuration(start: number, end: number): string | null {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? formatDuration(end - start) : null;
}

/** 执行中过程窗是否钉在底部；程序滚动不要走这条，只认人滚。 */
export const LIVE_VIEWPORT_SLOP_PX = 12;

export function isLiveViewportPinned(scrollTop: number, scrollHeight: number, clientHeight: number, slop = LIVE_VIEWPORT_SLOP_PX): boolean {
  return scrollHeight - scrollTop - clientHeight < slop;
}

export function liveViewportOverflows(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight + 1;
}

/** 过程灰字拆成动词与对象：「填写「出发日期」」→ 填写 / 「出发日期」；没有对象就整句当动词。 */
export function splitAction(text: string): { verb: string; object: string } {
  const quote = text.indexOf("「");
  const space = text.indexOf(" ");
  const at = quote > 0 ? quote : space > 0 ? space : -1;

  return at < 0 ? { verb: text, object: "" } : { verb: text.slice(0, at).trim(), object: text.slice(at).trim() };
}

/** 准备动作：看清页面、等它就绪。回执不计数、展开不列；读过的页面在回答下面的「来源」里。 */
const PREP_TOOLS = new Set(["list_tabs", "get_active_tab", "snapshot", "read_element", "read_elements", "screenshot", "wait_for", "sleep", "scroll", "arm_event", "wait_event", "disarm_event", "judge_browser_action", "clear_marks"]);

export function isPrepTool(name: string, params: Parameters<typeof describeTool>[1]): boolean {
  if (name === "tabs") return params.action !== "open" && params.action !== "close";

  return PREP_TOOLS.has(name);
}

/** 回执与步骤前的图标种类。 */
export type ActionKind = "open" | "fill" | "click" | "other";

export function actionKind(name: string, params: Parameters<typeof describeTool>[1]): ActionKind {
  if (name === "navigate" || name === "open_tab" || (name === "tabs" && params.action === "open")) return "open";

  if (name === "fill" || name === "type_text" || name === "page_operation" || name === "upload_file") return "fill";

  if (name === "click" || name === "double_click" || name === "press_key" || name === "drag") return "click";

  return "other";
}

/** 只做了一件事时，回执就写这件事：「打开了 whirl.chat」「点了「查询车票」」。 */
export function pastAction(name: string, params: Parameters<typeof describeTool>[1]): string {
  if (actionKind(name, params) === "open") {
    const host = hostOf(params.url);

    return host ? `打开了 ${host.replace(/^www\./, "")}` : "打开了一个网页";
  }

  const words = CURSOR_VERBS.get(name);
  const label = str(params.label);

  if (words && label) return `${words.verb}了「${clip(label)}」`;

  return describeTool(name, params).full;
}

/**
 * 打开页面这一步的结果里取页面标题（#102：步骤名写「Lumen 光子 · 公司资料」，不写 127.0.0.1:53623）。
 * 程序里的 navigate 结果是 JSON（可能被截断），单独的 navigate 是「Navigation result: 网址 — 标题; document: …」。
 * 取不到、是空白或就是网址时返回 null，调用方沿用域名。
 */
export function openedPageTitle(resultText: string): string | null {
  const json = /"title":"((?:[^"\\]|\\.)*)"/.exec(resultText);
  const line = json ? null : /^Navigation result: (\S+) — (.+?); document:/m.exec(resultText);
  let title = "";

  if (json) {
    try {
      title = String(JSON.parse(`"${json[1]}"`));
    } catch {
      return null;
    }
  } else if (line) {
    title = line[2] ?? "";
  }

  title = title.trim();

  if (!title || /^https?:\/\//.test(title)) return null;

  return title.length > 30 ? `${title.slice(0, 29)}…` : title;
}

export interface TrailStep { text: string; dur: string; failed: boolean; /** 照走时控件对不上、改为一步步看的那一行。 */ miss?: boolean }

/** 进行中标题下方只露最近 3 步，更早的只计数（「+ 前面 N 步」）。 */
export interface RecentSteps { shown: TrailStep[]; earlier: number }

export function recentSteps(done: TrailStep[]): RecentSteps {
  const shown = done.slice(-3);

  return { shown, earlier: done.length - shown.length };
}

/** 照上次的做法走时的说明行（核对、对不上）：在侧栏留一行字，不算「做了几件事」（YIS-96）。 */
export const ROUTE_NOTES = new Set(["route_check", "route_miss"]);

/** 照走的子步骤带着 route: { step, of }：标题写「照上次的做法 第 N/M 步」。 */
export function routeProgressTitle(params: Parameters<typeof describeTool>[1]): string | null {
  const at = params.route;

  if (!(at instanceof Object) || !("step" in at) || !("of" in at)) return null;

  return Number.isInteger(at.step) && Number.isInteger(at.of) ? `照上次的做法 第 ${String(at.step)}/${String(at.of)} 步` : null;
}

/** 一步做完、下一步还没开始时的标题：做过事就带上进度，不退回光秃秃的「正在思考」。 */
export function betweenStepsTitle(doneCount: number): string {
  return doneCount > 0 ? `正在思考 · 已做 ${doneCount} 件事` : "正在思考";
}
