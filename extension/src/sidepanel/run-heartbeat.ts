/**
 * 过程行心跳（#263）。只发 V3：四个墨点在 4 点与十字之间收合；想的时候标题轮换几个思考动词。
 * Claude Code 用星号呼吸 + 轮换动词 + 扫光；这里不用别人的商标，也不造假动作。
 */
const THINK = ["想想怎么说", "理一理", "看看下一步"] as const;

export const VERB_MS = 2_400;

/** 只在想的时候轮换动词；在做某个动作时标题写这个动作本身（打开哪页、点哪里），不换成泛泛的动词。先写原句，下一拍才开始轮换。 */
export function heartbeatTitle(semantic: string, tool: string | undefined, tick: number, reduced: boolean): string {
  if (tool || !semantic.includes("思考") || reduced || tick === 0) return semantic;

  return THINK[(tick - 1) % THINK.length] ?? semantic;
}

export function paintBeatMark(el: HTMLElement): void {
  el.replaceChildren();
  for (let i = 0; i < 4; i += 1) el.append(document.createElement("i"));
}
