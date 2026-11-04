export function answerSkeleton(): HTMLElement {
  const el = document.createElement("div");
  el.className = "answer-skeleton";
  el.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) el.append(document.createElement("i"));

  return el;
}
