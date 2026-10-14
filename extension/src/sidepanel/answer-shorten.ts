/**
 * 回答写完后拖短：全文 / 要点 / 一句，三层都从这份已画好的回答里显示或隐藏，不再问模型，字和全文一字不差。
 * 要点 = 第一段 + 所有列表和表格 + 下面有列表的小标题 + 卡片只留推荐项（没有推荐项留第一项）；一句 = 第一段的第一句。
 * 层级只活在这一页：历史回放默认全文，不跨会话保存。
 */
const LEVELS = ["", "一句", "要点", "全文"] as const;
type Level = 1 | 2 | 3;

/** 不属于回答正文的界面元素：不分层，复制时也去掉（与 answer-actions.ts 的 CHROME 一致）。 */
const CHROME = ".gc-actions,.answer-actions,.answer-panel,.source-fav,.answer-sources,.citation-row,.memory-used-toggle,.memory-used-line,.memory-used-cite-row";
const LIST = /^(UL|OL|TABLE)$/;
const HEADING = /^H[1-6]$/;
/** 卡片里成组的项：推荐项带 .pick / .best。 */
const CARD_GROUPS: Array<[group: string, item: string, pick: string]> = [
  [".gc-options", ".gc-option", ".pick"],
  [".gc-stats", ".gc-stat", ".best"],
  [".gc-table tbody", "tr", ".best"],
];
/** 量不到高度时，少于这么多字算不到三行（侧栏一行约 25 个字）。 */
const SHORT_CHARS = 75;
/** 拖多远换一层。 */
const STEP_PX = 36;
/** 阅读速度：每秒约读 9 个字（不算空白）。 */
const CHARS_PER_SECOND = 9;

const level = new WeakMap<HTMLElement, Level>();

/** 第一段的第一句：在第一个句末标点处把后面的内容包进 .shorten-rest。英文句点后要跟空白，小数点不切。第一段只有一句时不拆。 */
function splitFirstSentence(p: HTMLElement): void {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest(CHROME) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });

  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const m = /[。！？!?]+["”’」』）)]*|\.(?=\s)/.exec(node.data);

    if (!m) continue;
    const range = document.createRange();
    range.setStart(node, m.index + m[0].length);
    const tail = Array.from(p.children).find((child) => child.matches(CHROME));

    if (tail) range.setEndBefore(tail);
    else range.setEnd(p, p.childNodes.length);
    if (!range.toString().trim()) return;
    // extractContents 会把句末所在的 <strong>/<a> 拆成两半；span 挂在 p 下面，不进这些行内元素里。
    const span = document.createElement("span");
    span.className = "shorten-rest";
    span.append(range.extractContents());
    p.insertBefore(span, tail ?? null);

    return;
  }
}

/** 给顶层块标出最短在哪一层可见；返回能不能分层。 */
function markLevels(answer: HTMLElement): boolean {
  const blocks = Array.from(answer.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !el.matches(CHROME));
  const first = blocks[0];

  if (!first || first.tagName !== "P") return false;
  first.dataset.shorten = "1";

  blocks.slice(1).forEach((el, i, rest) => {
    let need: Level = 3;

    if (LIST.test(el.tagName) || el.classList.contains("gen-card")) need = 2;
    else if (HEADING.test(el.tagName)) {
      // 小标题到下一个小标题之间有列表，才留在要点层。
      for (const next of rest.slice(i + 1)) {
        if (HEADING.test(next.tagName)) break;
        if (LIST.test(next.tagName) || next.classList.contains("gen-card")) { need = 2; break; }
      }
    }
    el.dataset.shorten = String(need);
  });

  for (const [groupSel, itemSel, pickSel] of CARD_GROUPS) {
    for (const group of answer.querySelectorAll<HTMLElement>(`.gen-card ${groupSel}`)) {
      const items = Array.from(group.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.matches(itemSel));
      const keep = items.find((el) => el.matches(pickSel)) ?? items[0];
      items.forEach((el) => { el.dataset.shorten = el === keep ? "2" : "3"; });
    }
  }

  splitFirstSentence(first);

  return true;
}

function apply(answer: HTMLElement, next: Level): void {
  if (level.has(answer)) answer.dataset.shortenMoved = "";
  level.set(answer, next);
  answer.dataset.shortenLevel = String(next);

  for (const el of answer.querySelectorAll<HTMLElement>("[data-shorten]")) el.classList.toggle("shorten-off", Number(el.dataset.shorten) > next);
  answer.querySelector<HTMLElement>(".shorten-rest")?.classList.toggle("shorten-off", next < 2);
  const grip = answer.querySelector<HTMLElement>(".shorten-grip");
  const label = answer.querySelector<HTMLElement>(".shorten-level");

  // 上键收短：aria 值按“短的程度”算，上键让值变大，合 slider 惯例。
  grip?.setAttribute("aria-valuenow", String(4 - next));
  grip?.setAttribute("aria-valuetext", LEVELS[next]);
  if (label) label.textContent = `${LEVELS[next]} · 约 ${readSeconds(answer)} 秒读完`;
  answer.dispatchEvent(new CustomEvent("answer-shorten"));
}

/** 现在看得到的正文（去掉界面元素和收起的部分）。复制按这一份。 */
export function visibleBody(answer: HTMLElement, chrome: string): HTMLElement {
  const body = answer.cloneNode(true) as HTMLElement;
  body.querySelectorAll(`${chrome},.shorten-off`).forEach((node) => node.remove());

  return body;
}

function readSeconds(answer: HTMLElement): number {
  return Math.max(1, Math.round((visibleBody(answer, CHROME).textContent ?? "").replace(/\s/g, "").length / CHARS_PER_SECOND));
}

export function isShortened(answer: HTMLElement): boolean {
  return (level.get(answer) ?? 3) < 3;
}

/** 收短时“复制为 Markdown”：把看得到的块转回 Markdown。只覆盖回答里会出现的段落、标题、列表、表格和卡片。 */
export function visibleMarkdown(body: HTMLElement): string {
  const inline = (el: Element): string => Array.from(el.childNodes).map((node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    const text = inline(node);

    switch (node.tagName) {
      case "STRONG": case "B": return `**${text}**`;
      case "EM": case "I": return `*${text}*`;
      case "CODE": return `\`${text}\``;
      case "A": return node.getAttribute("href") ? `[${text}](${node.getAttribute("href")})` : text;
      case "BR": return "\n";
      default: return text;
    }
  }).join("");
  const line = (el: Element) => inline(el).replace(/\s+/g, " ").trim();

  return Array.from(body.children).map((el) => {
    if (HEADING.test(el.tagName)) return `${"#".repeat(Number(el.tagName[1]))} ${line(el)}`;
    if (el.tagName === "UL") return Array.from(el.children).map((li) => `- ${line(li)}`).join("\n");
    if (el.tagName === "OL") return Array.from(el.children).map((li, i) => `${i + 1}. ${line(li)}`).join("\n");
    if (el.tagName === "TABLE") {
      const rows = Array.from(el.querySelectorAll("tr")).map((tr) => `| ${Array.from(tr.children).map(line).join(" | ")} |`);
      const cols = el.querySelector("tr")?.children.length ?? 0;

      return [rows[0], `|${" --- |".repeat(cols)}`, ...rows.slice(1)].join("\n");
    }
    if (el.classList.contains("gen-card")) {
      const title = el.querySelector(".gc-title");
      const items = Array.from(el.querySelectorAll(".gc-option,.gc-stat,.gc-step,.gc-check,.gc-callout,.gc-table tbody tr"));
      // 卡片项由名字、价格、理由等几格拼成，格之间补上分隔。
      const cells = (item: Element) => {
        const parts = Array.from(item.querySelectorAll(".name,.price,.meta,.gc-why,.k > span:first-child,.v,.n,.t,.d,td")).map(line).filter(Boolean);
        return parts.length ? parts.join(" · ") : line(item);
      };

      return [title ? `**${line(title)}**` : "", ...items.map((item) => `- ${cells(item)}`)].filter(Boolean).join("\n");
    }

    return line(el);
  }).filter(Boolean).join("\n\n");
}

/**
 * 回答落定后挂上把手：上下拖一层层收短 / 展开，点一下短一层（最短再点回全文），键盘上下键同样。
 * 回答不到三行，或要点层和全文一样时不挂。
 */
export function attachShorten(answer: HTMLElement): void {
  const actions = answer.querySelector<HTMLElement>(":scope > .answer-actions");

  if (!actions || actions.querySelector(".shorten-grip")) return;
  const lineHeight = parseFloat(getComputedStyle(answer).lineHeight) || 24;

  const height = answer.getBoundingClientRect().height - actions.getBoundingClientRect().height;
  // 侧栏批注栏开着时对话区不渲染，高度是 0：按字数估三行。
  const short = height > 0 ? height < lineHeight * 3 : (answer.textContent ?? "").replace(/\s/g, "").length < SHORT_CHARS;

  if (short) return;
  if (!markLevels(answer)) return;

  if (!answer.querySelector('[data-shorten="3"]')) {
    // 要点层和全文一样：撤掉标记，不出把手。
    answer.querySelectorAll<HTMLElement>("[data-shorten]").forEach((el) => delete el.dataset.shorten);

    return;
  }

  const grip = document.createElement("div");
  grip.className = "shorten-grip";
  grip.tabIndex = 0;
  grip.setAttribute("role", "slider");
  grip.setAttribute("aria-label", "回答长短");
  grip.setAttribute("aria-valuemin", "1");
  grip.setAttribute("aria-valuemax", "3");
  grip.setAttribute("aria-orientation", "vertical");
  grip.title = "上下拖动调长短";
  grip.append(document.createElement("i"));
  const label = document.createElement("span");
  label.className = "shorten-level";
  actions.classList.add("has-grip");
  actions.append(grip, label);

  const set = (next: number) => apply(answer, Math.max(1, Math.min(3, next)) as Level);
  let startY: number | null = null;
  let startLevel: Level = 3;
  let moved = false;

  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // 鼠标拖不留焦点框：不让按下聚焦，键盘留下的焦点也放掉（焦点框只给键盘用）。
    e.preventDefault();
    if (document.activeElement === grip) grip.blur();
    startY = e.clientY; startLevel = level.get(answer) ?? 3; moved = false;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;

    if (Math.abs(dy) > 4) moved = true;
    const next = startLevel + Math.round(dy / STEP_PX);

    if (next !== level.get(answer)) set(next);
  });
  const end = () => {
    if (startY === null) return;
    grip.classList.remove("dragging");
    const current = level.get(answer) ?? 3;

    if (!moved) set(current === 1 ? 3 : current - 1);
    startY = null;
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", () => { startY = null; grip.classList.remove("dragging"); });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    set((level.get(answer) ?? 3) + (e.key === "ArrowUp" ? -1 : 1));
  });

  apply(answer, 3);
}
