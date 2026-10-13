/** 过程行心跳（#263）：四个墨点在 4 点与十字之间收合。标题只写正在做的事，不轮换思考动词。 */
export function paintBeatMark(el: HTMLElement): void {
  el.replaceChildren();
  for (let i = 0; i < 4; i += 1) el.append(document.createElement("i"));
}
