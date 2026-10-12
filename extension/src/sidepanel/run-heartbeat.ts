/**
 * 过程行心跳三种画法（#263）。Claude Code 用星号呼吸 + 轮换动词 + 扫光；
 * 这里只用 BYS 自己的墨点和从真实动作来的中文，不造假动作、不用别人的商标。
 *
 *   v1 四个墨点呼吸、收成十字再张开
 *   v2 按当前工具/阶段轮换动词，标题沿用原来的扫光
 *   v3 v1 + v2
 *
 * 开发开关：localStorage sideagent.heartbeat，或 documentElement.dataset.heartbeat，或 chrome.storage inproc_heartbeat。
 */
export type HeartbeatVariant = "v1" | "v2" | "v3";

const THINK = ["想想怎么说", "理一理", "看看下一步"] as const;
const PAGE = ["翻翻页面", "打开看看"] as const;
const LOOK = ["对一下", "查一查"] as const;
const TAP = ["点一点"] as const;
const WAIT = ["等一等"] as const;

export const THINK_VERBS: readonly string[] = THINK;
export const VERB_MS = 2_400;

export function currentHeartbeatVariant(): HeartbeatVariant {
  try {
    const fromDom = document.documentElement.dataset.heartbeat;
    if (fromDom === "v1" || fromDom === "v2" || fromDom === "v3") return fromDom;
    const saved = localStorage.getItem("sideagent.heartbeat");
    if (saved === "v1" || saved === "v2" || saved === "v3") return saved;
  } catch { /* 读不到就用默认 */ }

  return "v3";
}

export function activityVerbs(tool: string | undefined, title: string): readonly string[] {
  if (title.includes("思考")) return THINK;
  const name = tool ?? "";

  if (name === "tabs" || name === "navigate" || name === "open_tab" || name === "snapshot" || /打开|标签页|读页/.test(title)) return PAGE;
  if (name === "js" || name === "fetch" || /抓取|读出|查/.test(title)) return LOOK;
  if (name === "click" || name === "double_click" || /^正在点/.test(title)) return TAP;
  if (name === "wait_for" || name === "sleep" || /等你|等待/.test(title)) return WAIT;

  return THINK;
}

export function heartbeatTitle(variant: HeartbeatVariant, semantic: string, tool: string | undefined, tick: number, reduced: boolean): string {
  if (variant === "v1" || !semantic.startsWith("正在")) return semantic;
  const verbs = activityVerbs(tool, semantic);

  return (reduced ? verbs[0] : verbs[tick % verbs.length]) ?? semantic;
}

export function paintBeatMark(el: HTMLElement, variant: HeartbeatVariant): void {
  el.dataset.variant = variant;
  el.replaceChildren();
  if (variant === "v2") return;
  for (let i = 0; i < 4; i += 1) el.append(document.createElement("i"));
}

export function isThinkingVerb(title: string): boolean {
  return title === "正在思考" || (THINK as readonly string[]).includes(title);
}
