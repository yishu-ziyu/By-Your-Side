/**
 * 回答里提到的按钮能在页面上指出来（对标 ChatGPT Atlas / Comet 在页面上高亮目标；虚线行内链接取自 Adil Mania）。
 * 只给「」括起、且读页时拿到过位置、现在还在页上的控件加虚线；找不到就不画线，不猜。
 * 第一次点：光标飞过去圈出来，回答下写一行灰字；再点一次：替用户发出「点「…」」，和自己打字发出一样，能看见、能停。
 */

/** 回答里「」括起的名字，按出现顺序去重。代码块、按钮、链接里的不算。 */
export function quotedNames(answer: HTMLElement): string[] {
  const names: string[] = [];

  for (const node of textNodes(answer)) {
    for (const match of node.data.matchAll(/「([^「」\n]{1,20})」/g)) {
      const name = match[1]!.trim();

      if (name && !names.includes(name)) names.push(name);
    }
  }

  return names;
}

function textNodes(answer: HTMLElement): Text[] {
  const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT, { acceptNode: node => (node.parentElement?.closest("pre,code,button,a,.page-ref,.answer-actions") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const out: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node instanceof Text) out.push(node);

  return out;
}

export interface PageRefDeps {
  /** 光标飞过去圈出；false 表示页面上已经没有它。 */
  point: (name: string) => Promise<boolean>;
  /** 替用户发出一句话。 */
  say: (text: string) => void;
}

/** 把 found 里的名字（只换「」里面的字）换成带虚线的按钮。 */
export function linkifyPageRefs(answer: HTMLElement, found: string[], deps: PageRefDeps): void {
  if (!found.length || answer.querySelector(".page-ref")) return;
  const wanted = new Set(found);

  for (const node of textNodes(answer)) {
    const parts = node.data.split(/(「[^「」\n]{1,20}」)/);

    if (!parts.some(part => wanted.has(part.slice(1, -1).trim()))) continue;
    const fragment = document.createDocumentFragment();

    for (const part of parts) {
      const name = part.startsWith("「") ? part.slice(1, -1).trim() : "";

      if (!name || !wanted.has(name)) { if (part) fragment.append(part);

 continue; }

      fragment.append("「", refButton(answer, name, deps), "」");
    }

    node.replaceWith(fragment);
  }
}

function refButton(answer: HTMLElement, name: string, deps: PageRefDeps): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "page-ref";
  button.dataset.name = name;
  button.textContent = name;
  button.title = "在页面上圈出";
  button.onclick = async () => {
    if (button.classList.contains("pointed")) {
      clearPointed(answer);
      deps.say(`点「${name}」`);

      return;
    }

    clearPointed(answer);
    button.classList.add("pointing");
    const ok = await deps.point(name);
    button.classList.remove("pointing");

    if (!ok) {
      unwrap(button);

      return;
    }

    button.classList.add("pointed");
    showHint(answer);
  };

  return button;
}

function clearPointed(answer: HTMLElement): void {
  for (const el of answer.querySelectorAll(".page-ref.pointed")) el.classList.remove("pointed");
  answer.querySelector(".page-ref-hint")?.remove();
}

function showHint(answer: HTMLElement): void {
  const hint = document.createElement("p");
  hint.className = "page-ref-hint";
  hint.setAttribute("role", "status");
  hint.textContent = "已在页面上圈出 · 再点一次可由我来点";
  const actions = answer.querySelector(".answer-actions");

  if (actions) actions.before(hint);
  else answer.append(hint);
}

/** 页面上已经找不到：虚线收掉，字留在原处。 */
function unwrap(button: HTMLButtonElement): void {
  const answer = button.closest<HTMLElement>(".msg");
  button.replaceWith(button.textContent ?? "");
  if (answer && !answer.querySelector(".page-ref.pointed")) answer.querySelector(".page-ref-hint")?.remove();
}
