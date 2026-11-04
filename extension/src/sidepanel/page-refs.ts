export function quotedNames(answer: HTMLElement): string[] {
  const names: string[] = [];

  for (const node of textNodes(answer)) {
    for (const match of node.data.matchAll(/「([^「」\n]{1,20})」/g)) {
      const name = match[1]!.trim();

      if (name && !names.includes(name)) names.push(name);
    }
  }

  for (const node of textNodes(answer)) {
    for (const match of node.data.matchAll(/["“]([^"“”\n]{1,30})["”]/g)) {
      const name = match[1]!.trim();

      if (name && !names.includes(name)) names.push(name);
    }
  }

  for (const strong of boldNames(answer)) {
    const name = strong.textContent!.trim();

    if (!names.includes(name)) names.push(name);
  }

  return names;
}

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

interface PageRefDeps {
  point: (name: string) => Promise<boolean>;
  say: (text: string) => void;
}

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

  for (const name of found) {
    if ([...answer.querySelectorAll<HTMLElement>(".page-ref")].some(el => el.dataset.name === name)) continue;
    linkFirstPlain(answer, name, deps);
  }
}

const WORD = /[A-Za-z0-9]/;

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

function unwrap(button: HTMLButtonElement): void {
  const answer = button.closest<HTMLElement>(".msg");
  button.replaceWith(button.textContent ?? "");
  if (answer && !answer.querySelector(".page-ref.pointed")) answer.querySelector(".page-ref-hint")?.remove();
}
