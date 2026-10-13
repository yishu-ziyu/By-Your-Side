/**
 * 过程行心跳（#263）。只发 V3：四个墨点在 4 点与十字之间收合，标题轮换当前工具/阶段的中文。
 * Claude Code 用星号呼吸 + 轮换动词 + 扫光；这里不用别人的商标，也不造假动作。
 */
const THINK = ["想想怎么说", "理一理", "看看下一步"] as const;
const PAGE = ["翻翻页面", "打开看看"] as const;
const LOOK = ["对一下", "查一查"] as const;
const TAP = ["点一点"] as const;
const WAIT = ["等一等"] as const;

export const THINK_VERBS: readonly string[] = THINK;
export const VERB_MS = 2_400;

export function activityVerbs(tool: string | undefined, title: string): readonly string[] {
  if (title.includes("思考")) return THINK;
  const name = tool ?? "";

  if (name === "tabs" || name === "navigate" || name === "open_tab" || name === "snapshot" || /打开|标签页|读页/.test(title)) return PAGE;
  if (name === "js" || name === "fetch" || /抓取|读出|查/.test(title)) return LOOK;
  if (name === "click" || name === "double_click" || /^正在点/.test(title)) return TAP;
  if (name === "wait_for" || name === "sleep" || /等你|等待/.test(title)) return WAIT;

  return THINK;
}

export function heartbeatTitle(semantic: string, tool: string | undefined, tick: number, reduced: boolean): string {
  if (!semantic.startsWith("正在")) return semantic;
  const verbs = activityVerbs(tool, semantic);

  return (reduced ? verbs[0] : verbs[tick % verbs.length]) ?? semantic;
}

export function paintBeatMark(el: HTMLElement): void {
  el.replaceChildren();
  for (let i = 0; i < 4; i += 1) el.append(document.createElement("i"));
}

export function isThinkingVerb(title: string): boolean {
  return title === "正在思考" || (THINK as readonly string[]).includes(title);
}
