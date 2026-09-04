/**
 * "执行步骤"聚合块的纯逻辑：工具人性化描述、步骤链、耗时格式化。
 * 与 DOM 解耦，便于单测；main.ts 负责渲染。
 */
import { displayNameFor, personFor } from "../../../shared/cast.js";

export interface ToolAction {
  /** 步骤链里用的短动作名，如 "读取页面结构"。 */
  short: string;
  /** 工具卡标题，带得上关键参数就带，如 "点击「结算服务」"。 */
  full: string;
}

/** 工具名 → 中文动作；未知名称回退原始名。 */
const ACTION_NAMES: Record<string, string> = {
  list_tabs: "列出标签页",
  get_active_tab: "定位当前页",
  open_tab: "打开标签页",
  switch_tab: "切换标签页",
  close_tab: "关闭标签页",
  navigate: "打开页面",
  snapshot: "读取页面结构",
  click: "点击",
  fill: "填写文本",
  type_text: "输入文本",
  press_key: "按键",
  scroll: "滚动页面",
  js: "执行脚本",
  screenshot: "截图",
  mark: "标注元素",
  clear_marks: "清除标注",
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
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 工具调用 → 人性化动作描述。 */
export function describeTool(name: string, params: Record<string, unknown>): ToolAction {
  const short = ACTION_NAMES[name] ?? name;
  switch (name) {
    case "click": {
      const label = str(params.label);
      return { short, full: label ? `点击「${clip(label)}」` : "点击元素" };
    }
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
      const label = str(params.label);
      return { short, full: label ? `标注「${clip(label)}」` : short };
    }
    case "spawn_worker": {
      const id = str(params.id);
      const name = id ? personFor(id)?.name : null;
      return { short, full: name ? `请了 ${name}` : short };
    }
    case "stop_worker": {
      const id = str(params.id);
      const name = id ? personFor(id)?.name : null;
      return { short, full: name ? `让 ${name} 停下` : short };
    }
    case "post": {
      const kind = str(params.kind);
      const to = str(params.to);
      const who = to ? displayNameFor(to) : null;
      if (kind && who && who !== to) return { short, full: `投递 ${clip(kind)} → ${who}` };
      if (kind && to) return { short, full: `投递 ${clip(kind)} → ${clip(to, 12)}` };
      return { short, full: short };
    }
    case "await_message": {
      const kind = str(params.kind);
      return { short, full: kind ? `等待「${clip(kind)}」` : short };
    }
    default:
      return { short, full: short };
  }
}

/**
 * 步骤链：相邻重复去重，超长时只保留最近几步（前缀 "…"）。
 * 例：思考 → 读取页面结构 → 思考 → 点击
 */
export class StepChain {
  private steps: string[] = [];

  push(label: string): void {
    if (this.steps[this.steps.length - 1] !== label) this.steps.push(label);
  }

  /** 最多保留最近 keep 步渲染；超出时前缀省略号。 */
  render(keep = 3): string {
    if (this.steps.length === 0) return "";
    const shown = this.steps.slice(-keep);
    const prefix = this.steps.length > keep ? "… → " : "";
    return prefix + shown.join(" → ");
  }
}

/** chip 状态：tool_end 前运行中；结束后按 isError 分完成/失败。 */
export type ChipState = "running" | "done" | "error";

export function chipState(ended: boolean, isError: boolean): ChipState {
  if (!ended) return "running";
  return isError ? "error" : "done";
}

/** 像素格 loader 副标题：最近一个工具的中文动作名，尚无工具时为"思考"。 */
export function loaderSubtitle(lastToolShort: string | null): string {
  return lastToolShort ?? "思考";
}

/** 像素格相位波纹延迟（秒）：(x+y)*0.12，x/y 为格在 size×size 阵列中的坐标。 */
export function pixelDelay(index: number, size = 5): number {
  const x = index % size;
  const y = Math.floor(index / size);
  return (x + y) * 0.12;
}

/** 耗时格式化：<10s 一位小数（"1.3s"），<60s 整数（"12s"），否则 "2m 28s"。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 9.95) return `${(Math.round(s * 10) / 10).toFixed(1)}s`;
  if (s < 59.5) return `${Math.round(s)}s`;
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
  if (input.hasCurrentRun) return "current";
  if (input.graphRunning) return "new";
  if (input.hasLastRun) return "reuse-last";
  return "drop";
}
