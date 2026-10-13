/**
 * "执行步骤"聚合块的纯逻辑：工具人性化描述、步骤链、耗时格式化。
 * 与 DOM 解耦；main.ts 负责渲染。
 */
import { displayNameFor, personFor } from "../../../shared/cast.js";
import { toolAction } from "../../../shared/user-facing.js";
import type { HeldReason } from "../../../shared/protocol.js";

export interface ToolAction {
  /** 步骤链里用的短动作名，如 "读页"。 */
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
  snapshot: "读页",
  judge_browser_action: "决定下一步操作",
  read_element: "读完整内容",
  read_elements: "读多处内容",
  click: "点击",
  double_click: "双击",
  drag: "拖动",
  upload_file: "上传文件",
  cdp: "直接操作浏览器",
  hover: "悬停",
  remember_user_preference: "存入记忆",
  fetch: "抓取",
  browser_run: "连续操作",
  wait_for: "等页面内容出现",
  check: "核验页面",
  assert: "核验页面状态",
  sleep: "等待",
  fill: "填写文本",
  page_operation: "填写并核验",
  page_translation: "翻译页面",
  share_tab: "共享这个标签页",
  take_tab: "接手标签页",
  type_text: "输入文本",
  press_key: "按键",
  scroll: "滚动页面",
  js: "在页面里运行代码",
  screenshot: "截图",
  mark: "圈出内容",
  clear_marks: "清除圈画",
  arm_event: "准备等页面变化",
  wait_event: "等页面变化",
  spawn_worker: "安排助手",
  list_workers: "查看助手列表",
  stop_worker: "中止助手的任务",
  post: "发送结果",
  await_message: "等待结果",
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
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.replace(/^www\./, "");
    const name = host.replace(/:\d+$/, "").toLowerCase();

    // 本机地址不当域名写给用户。
    if (name === "localhost" || name === "0.0.0.0" || name === "[::1]" || name.startsWith("127.") || /^(\d{1,3}\.){3}\d{1,3}$/.test(name)) return null;

    return host;
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
      const full = params.action === 'restore' ? '恢复页面原文'
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

      return { short, full: label ? `${short}「${clip(label)}」` : `${short}内容` };
    }

    case "js": {
      const purpose = str(params.purpose);

      return { short, full: purpose ? clip(purpose, 32) : short };
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

    case "fetch": {
      const host = hostOf(params.url);

      return { short: host ? `抓取 ${host}` : "抓取", full: host ? `抓取 ${host}` : "抓取" };
    }

    case "press_key": {
      const key = str(params.key);

      return { short, full: key ? `按键「${clip(key, 8)}」` : short };
    }

    case "mark": {
      if (params.clear === true) {
        return { short: "清除圈画", full: "清除圈画" };
      }

      const words = Array.isArray(params.text) ? params.text.filter((w): w is string => typeof w === "string") : [];

      if (words.length) return { short, full: `圈出「${clip(words.join("、"))}」` };
      const label = str(params.label);

      return { short, full: label ? `圈出「${clip(label)}」` : short };
    }

    case "guide_step": {
      const say = str(params.say);

      if (!say) return { short, full: short };

      return { short, full: typeof params.step === "number" ? `第 ${params.step} 步：${clip(say, 24)}` : clip(say, 24) };
    }

    case "spawn_worker": {
      return { short, full: "安排助手" };
    }

    case "stop_worker": {
      const id = str(params.id);
      const name = id ? personFor(id)?.name : null;

      return { short, full: name ? `让 ${name} 中止任务` : short };
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
  ["click", { verb: "点", unnamed: "点击" }],
  ["fill", { verb: "填", unnamed: "填写" }],
  ["select_option", { verb: "选", unnamed: "选择选项" }],
  ["hover", { verb: "看", unnamed: "查看" }],
]);

export function actionCardLabel(name: string, params: Parameters<typeof describeTool>[1], plate?: string): string {
  const words = CURSOR_VERBS.get(name);

  if (!words) return describeTool(name, params).full;
  const label = (plate || str(params.label) || "").trim();

  return label ? `${words.verb}「${clip(label)}」` : words.unnamed;
}

/**
 * 步骤链：相邻重复去重，超长时只保留最近几步（前缀 "…"）。
 * 例：思考 → 读页 → 思考 → 点击
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

/** 过程行标题：做了几步，以及没做成/中止。放得下时 main.ts 在后面接短名链（#263）。 */
export function finishedRunTitle(steps: number, outcome: "failed" | "stopped" | "completed", failed = 1): string {
  const done = steps > 0 ? `做了 ${steps} 步` : "查看执行过程";

  if (outcome === "failed") return `${done} · 有 ${Math.max(failed, 1)} 步没做成`;

  if (outcome === "stopped") return `已中止 · ${done}`;

  return done;
}

/**
 * 因为用户没执行的那一步：按扩展给出的原因说一句人话，不当成失败（docs/evals/20261009-send-confirm.md R2）。
 * 只看原因，不读给助手的文字：改写给助手的话不会让侧栏说错。
 */
export const HELD_TEXT: Record<HeldReason, string> = {
  // 付款按钮：助手不点，留给用户（docs/evals/20261009-pay-stop.md）。
  pay: "停在付款前，等你自己点",
  stopped: "没发：你中止了任务",
  left: "没发：你离开了这个页面",
  timeout: "没发：2 分钟没确认",
  declined: "你没让发，草稿还在",
  repeat: "你没让发，草稿还在",
  busy: "没发：前一个确认还在等你",
  // 教学一步没完成（docs/evals/20261011-guided-teaching.md）：照实说，不画成失败。
  guide_stopped: "你中止了，这一步没做完",
  guide_left: "你离开了这个页面，这一步没做完",
  guide_no_change: "点了两次，页面都没有变化",
  guide_timeout: "2 分钟没点，这一步先放着",
};

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

/** 回执与步骤前的图标种类：每种动作都有自己的图标，认不出的工具用扳手（10-07 用户：不要有的有图标、有的只有一个点）。 */
export type ActionKind = "open" | "fill" | "click" | "key" | "script" | "run" | "look" | "pick" | "mark" | "tab" | "close" | "translate" | "download" | "team" | "remember" | "other";

const KIND_OF_TOOL: Record<string, ActionKind> = {
  navigate: "open", open_tab: "open",
  fill: "fill", type_text: "fill", page_operation: "fill", upload_file: "fill",
  click: "click", double_click: "click", drag: "click",
  press_key: "key",
  js: "script", cdp: "script",
  browser_run: "run",
  hover: "look",
  select_option: "pick",
  mark: "mark", guide_step: "mark",
  switch_tab: "tab", worker_tabs: "tab", share_tab: "tab", take_tab: "tab",
  close_tab: "close",
  page_translation: "translate",
  download_url: "download",
  spawn_worker: "team", list_workers: "team", stop_worker: "team", post: "team", await_message: "team",
  remember_user_preference: "remember",
};

export function actionKind(name: string, params: Parameters<typeof describeTool>[1]): ActionKind {
  if (name === "tabs") return params.action === "open" ? "open" : params.action === "close" ? "close" : "tab";

  return KIND_OF_TOOL[name] ?? "other";
}

/** 只做了一件事时，回执就写这件事：「打开了 whirl.chat」「点了「查询车票」」。 */
export function pastAction(name: string, params: Parameters<typeof describeTool>[1]): string {
  if (actionKind(name, params) === "open") {
    const host = hostOf(params.url);

    return host ? `打开了 ${host.replace(/^www\./, "")}` : "打开了一个页面";
  }

  const words = CURSOR_VERBS.get(name);
  const label = str(params.label);

  if (words && label) return `${words.verb}了「${clip(label)}」`;

  if (name === "js" && str(params.purpose)) return clip(str(params.purpose)!, 32);

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

/**
 * 回执里的短名，四五个字（#263）：「打开 Studio Gh…」「点作品」「圈出 11 处」。
 * 有中文时最多 6 个字（英文字母算半个），纯英文最多 14 个字符，超出加「…」。
 * pageTitle：打开页面这一步结束后取到的标题，没有时用域名。
 */
export function shortAction(name: string, params: Parameters<typeof describeTool>[1], pageTitle?: string | null): string {
  const label = str(params.label);
  let text: string;

  if (actionKind(name, params) === "open") {
    const page = pageTitle ?? hostOf(params.url)?.replace(/^www\./, "") ?? "页面";

    text = `打开${/^[\x00-\x7f]/.test(page) ? " " : ""}${page}`;
  }
  else if (CURSOR_VERBS.has(name)) text = label ? `${CURSOR_VERBS.get(name)!.verb}${label}` : CURSOR_VERBS.get(name)!.unnamed;
  else if (name === "type_text") text = label ? `填${label}` : "输入文字";
  else if (name === "js") text = str(params.purpose) ?? "运行代码";
  else if (name === "fetch") text = `抓取 ${hostOf(params.url) ?? "接口"}`;
  else if (name === "browser_run") text = label ?? "连续操作";
  else if (name === "press_key") text = str(params.key) ? `按${str(params.key)}` : "按键";
  else if (name === "mark" && params.clear !== true) {
    const words = Array.isArray(params.text) ? params.text.length : 0;

    text = words > 1 ? `圈出 ${words} 处` : label ? `圈出${label}` : "圈出内容";
  } else text = describeTool(name, params).short;

  return shortClip(text);
}

function shortClip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();

  if (!/[\u3400-\u9fff]/.test(t)) return t.length > 14 ? `${t.slice(0, 13)}…` : t;
  let units = 0;

  for (let i = 0; i < t.length; i++) {
    units += /[\x00-\x7f]/.test(t[i]!) ? 0.5 : 1;

    if (units > 6) return `${t.slice(0, i)}…`;
  }

  return t;
}
