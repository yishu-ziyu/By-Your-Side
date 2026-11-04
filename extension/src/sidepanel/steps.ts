import { displayNameFor, personFor } from "../../../shared/cast.js";
import { extractSearchQuery } from "../../../shared/request-confirm.js";
import { toolAction } from "../../../shared/user-facing.js";
import type { HeldReason } from "../../../shared/protocol.js";

interface ToolAction {
  short: string;
  full: string;
}

const ACTION_NAMES: Record<string, string> = {
  tabs: "标签页",
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
  read_attachment: "读附件",
  cdp: "直接操作浏览器",
  hover: "悬停",
  remember_user_preference: "存入记忆",
  fetch: "读取网页数据",
  browser_run: "连续操作",
  learned_operation: "技能",
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
      const query = extractSearchQuery(str(params.body) ?? undefined, str(params.url) ?? undefined);
      if (query) return { short: `搜索「${clip(query, 16)}」`, full: `搜索「${clip(query, 24)}」` };
      if (/(search|query|graphql|gql)/i.test(str(params.url) ?? "")) return { short: "搜索", full: "搜索" };
      return { short: "读取网页数据", full: "读取网页数据" };
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

const CURSOR_VERBS = new Map([
  ["click", { verb: "点", unnamed: "点击" }],
  ["fill", { verb: "填", unnamed: "填写" }],
  ["select_option", { verb: "选", unnamed: "选择选项" }],
  ["hover", { verb: "看", unnamed: "查看" }],
]);

const REF_ONLY = /^@?[a-z]?\d+$/i;

export function actionCardLabel(name: string, params: Parameters<typeof describeTool>[1], plate?: string): string {
  const words = CURSOR_VERBS.get(name);

  if (!words) return describeTool(name, params).full;
  const label = [plate, str(params.label)].map(v => (v ?? "").trim()).find(v => v && !REF_ONLY.test(v)) ?? "";

  return label ? `${words.verb}「${clip(label)}」` : words.unnamed;
}

export class StepChain {
  private steps: string[] = [];
  push(label: string): void {
    if (this.steps[this.steps.length - 1] !== label) {
      this.steps.push(label);
    }
  }
  render(keep = 3): string {
    if (this.steps.length === 0) {
      return "";
    }

    const shown = this.steps.slice(-keep);
    const prefix = this.steps.length > keep ? "… → " : "";

    return prefix + shown.join(" → ");
  }
}

type ChipState = "running" | "done" | "error";

export function chipState(ended: boolean, isError: boolean): ChipState {
  if (!ended) {
    return "running";
  }

  return isError ? "error" : "done";
}

export function loaderSubtitle(lastToolShort: string | null): string {
  return lastToolShort ?? "思考";
}

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

export function historyEventTime(applyingHistory: boolean, occurredAt?: number): number {
  if (applyingHistory) {
    if (typeof occurredAt === "number" && Number.isFinite(occurredAt)) {
      return occurredAt;
    }

    return Number.NaN;
  }

  return Date.now();
}

export function spokenDuration(start: number, end: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const s = Math.max(1, Math.round((end - start) / 1000));

  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function skillStepText(skill: { name: string; outcome: "saved" | "used" | "unused" }): string {
  const name = `「${clip(skill.name, 24)}」`;

  if (skill.outcome === "saved") return `存成技能${name}`;

  if (skill.outcome === "used") return `用了技能${name}`;

  return `技能${name}这次没用上，改用普通步骤`;
}

export function finishedRunTitle(steps: number, outcome: "failed" | "stopped" | "completed", failed = 1): string {
  const done = steps > 0 ? `做了 ${steps} 步` : "查看执行过程";

  if (outcome === "failed") return `${done} · 有 ${Math.max(failed, 1)} 步没做成`;

  if (outcome === "stopped") return `已中止 · ${done}`;

  return done;
}

export const HELD_TEXT: Record<HeldReason, string> = {
  pay: "停在付款前，等你自己点",
  stopped: "没发：你中止了任务",
  left: "没发：你离开了这个页面",
  timeout: "没发：2 分钟没确认",
  declined: "你选择不发送：草稿留在页面上，不会发出，要发时再跟我说",
  repeat: "你选择不发送：这次没再问，草稿留在页面上",
  busy: "没发：前一个确认还在等你",
  send_changed: "没发：确认后的内容、收件人或目标已变化",
  send_unverified: "没发：无法核对发送内容",
  guide_stopped: "你中止了，这一步没做完",
  guide_left: "你离开了这个页面，这一步没做完",
  guide_no_change: "点了两次，页面都没有变化",
  guide_timeout: "2 分钟没点，这一步先放着",
};

export function recordedDuration(start: number, end: number): string | null {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? formatDuration(end - start) : null;
}

const LIVE_VIEWPORT_SLOP_PX = 12;

export function isLiveViewportPinned(scrollTop: number, scrollHeight: number, clientHeight: number, slop = LIVE_VIEWPORT_SLOP_PX): boolean {
  return scrollHeight - scrollTop - clientHeight < slop;
}

export function liveViewportOverflows(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight + 1;
}

export function splitAction(text: string): { verb: string; object: string } {
  const quote = text.indexOf("「");
  const space = text.indexOf(" ");
  const at = quote > 0 ? quote : space > 0 ? space : -1;

  return at < 0 ? { verb: text, object: "" } : { verb: text.slice(0, at).trim(), object: text.slice(at).trim() };
}

const PREP_TOOLS = new Set(["list_tabs", "get_active_tab", "snapshot", "read_element", "read_elements", "screenshot", "wait_for", "sleep", "scroll", "arm_event", "wait_event", "disarm_event", "judge_browser_action", "clear_marks"]);

export function isPrepTool(name: string, params: Parameters<typeof describeTool>[1]): boolean {
  if (name === "tabs") return params.action !== "open" && params.action !== "close";

  return PREP_TOOLS.has(name);
}

export type ActionKind = "open" | "fill" | "click" | "key" | "script" | "run" | "look" | "pick" | "mark" | "tab" | "close" | "translate" | "download" | "team" | "remember" | "other";

const KIND_OF_TOOL: Record<string, ActionKind> = {
  navigate: "open", open_tab: "open",
  fill: "fill", type_text: "fill", page_operation: "fill", upload_file: "fill",
  click: "click", double_click: "click", drag: "click",
  press_key: "key",
  js: "script", cdp: "script",
  browser_run: "run",
  learned_operation: "run",
  hover: "look", read_attachment: "look",
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
  else if (name === "fetch") {
    const query = extractSearchQuery(str(params.body) ?? undefined, str(params.url) ?? undefined);
    text = query ? `搜索「${clip(query, 12)}」` : /(search|query|graphql|gql)/i.test(str(params.url) ?? "") ? "搜索" : "读取网页数据";
  }
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
