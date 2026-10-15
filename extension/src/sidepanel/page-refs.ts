/**
 * 回答里提到的按钮能在页面上指出来（对标 ChatGPT Atlas / Comet 在页面上高亮目标；虚线行内链接取自 Adil Mania）。
 * 只给「」括起、整段粗体、"…" 引号括起，或助手这一页圈过（mark）的控件加虚线；都要读页时拿到过位置、现在还在页上。找不到就不画线，不猜。
 * 圈过的控件名在回答里常是平铺文字（「点绿色的 Code 按钮」）：后台把圈过的名字一并报回，这里按原字（区分大小写、英文要整词）找第一处。
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

  // 英文引号也常用来写按钮名（"Search the site"）。
  for (const node of textNodes(answer)) {
    for (const match of node.data.matchAll(/["“]([^"“”\n]{1,30})["”]/g)) {
      const name = match[1]!.trim();

      if (name && !names.includes(name)) names.push(name);
    }
  }

  // 真实模型多半把按钮名写成粗体（**Code**），很少用「」：整段粗体就是一个短名字时也算。
  for (const strong of boldNames(answer)) {
    const name = strong.textContent!.trim();

    if (!names.includes(name)) names.push(name);
  }

  return names;
}

/** 整段文字就是一个 1–20 字名字的粗体，不在代码块、按钮、链接里。 */
function boldNames(answer: HTMLElement): HTMLElement[] {
  return [...answer.querySelectorAll<HTMLElement>("strong,b")].filter(el => {
    const text = el.textContent?.trim() ?? "";

    return text.length >= 1 && text.length <= 20 && !/[\n「」]/.test(text) && !el.children.length && !el.parentElement?.closest("pre,code,button,a,.page-ref,.answer-actions");
  });
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

  for (const strong of boldNames(answer)) {
    const name = strong.textContent!.trim();

    if (wanted.has(name)) strong.replaceChildren(refButton(answer, name, deps));
  }

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

  // 还没画上的名字（引号里的、助手圈过的）：按原字找第一处平铺文字。
  for (const name of found) {
    if ([...answer.querySelectorAll<HTMLElement>(".page-ref")].some(el => el.dataset.name === name)) continue;
    linkFirstPlain(answer, name, deps);
  }
}

const WORD = /[A-Za-z0-9]/;

/** 名字在平铺文字里第一次出现的地方换成虚线按钮。英文名两边不能紧挨字母数字（「Code」不匹配 「Codespaces」）。 */
function linkFirstPlain(answer: HTMLElement, name: string, deps: PageRefDeps): void {
  if ([...name].length < 2) return;

  for (const node of textNodes(answer)) {
    let at = node.data.indexOf(name);

    while (at >= 0) {
      const before = node.data[at - 1] ?? "", after = node.data[at + name.length] ?? "";

      if (!(WORD.test(name[0]!) && WORD.test(before)) && !(WORD.test(name.at(-1)!) && WORD.test(after))) {
        const rest = node.splitText(at);
        rest.splitText(name.length);
        rest.replaceWith(refButton(answer, name, deps));

        return;
      }
      at = node.data.indexOf(name, at + 1);
    }
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
