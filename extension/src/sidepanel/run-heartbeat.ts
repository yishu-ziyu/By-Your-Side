/** 过程行心跳（#263）：四个墨点在 4 点与十字之间收合。标题只写正在做的事，不轮换思考动词。 */
export function paintBeatMark(el: HTMLElement): void {
  el.replaceChildren();
  for (let i = 0; i < 4; i += 1) el.append(document.createElement("i"));
}

/** 回答还没出字时占住回答位置的三行骨架。显隐和淡出全由样式按它后面有没有东西决定；收尾时 main.ts 拿掉。 */
export function answerSkeleton(): HTMLElement {
  const el = document.createElement("div");
  el.className = "answer-skeleton";
  el.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) el.append(document.createElement("i"));

  return el;
}
