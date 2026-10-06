import { createElement as icon, Copy } from "lucide";

/** 不属于回答正文的界面文字：复制时去掉。 */
const CHROME = ".answer-actions,.answer-panel,.source-fav,.answer-sources,.citation-row";

const SECTION_TITLES = { sources: "读过的网页", memory: "用到的记忆" } as const;

/**
 * 文末一排在回答落定时添加：复制 · 来源 · 耗时（docs/evals/20261006-answer-receipt.md）。
 * 最新一条回答一直显示，旧回答悬停才出现（样式表按 .answer-latest 区分）。
 * 「来源」展开回答下方的面板：读过的网页、用到的记忆，各自由 answer-sources / 记忆行填进来。
 */
export function attachAnswerActions(answer: HTMLElement): void {
  if (answer.querySelector(".answer-actions") || !answer.textContent?.trim()) return;
  const actions = document.createElement("div");
  actions.className = "answer-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.setAttribute("aria-label", "复制回答");
  copy.title = "复制回答";
  copy.append(icon(Copy));
  const sources = document.createElement("button");
  sources.type = "button";
  sources.className = "answer-sources-btn";
  sources.hidden = true;
  sources.setAttribute("aria-expanded", "false");
  const time = document.createElement("span");
  time.className = "answer-time";
  const feedback = document.createElement("span");
  feedback.className = "answer-action-feedback";
  feedback.setAttribute("role", "status");
  const panel = document.createElement("div");
  panel.className = "answer-panel";
  panel.hidden = true;

  copy.onclick = async () => {
    copy.disabled = true;
    // SAFETY: cloneNode 保持原节点类型，answer 是 HTMLElement。
    const body = answer.cloneNode(true) as HTMLElement;
    body.querySelectorAll(CHROME).forEach(node => node.remove());

    try {
      await navigator.clipboard.writeText(body.innerText.trim() || body.textContent?.trim() || "");
      feedback.textContent = "已复制";
    } catch {
      feedback.textContent = "复制失败，请选中文字复制";
    } finally {
      copy.disabled = false;
    }
  };

  sources.onclick = () => {
    panel.hidden = !panel.hidden;
    sources.setAttribute("aria-expanded", String(!panel.hidden));

    // 面板常在最后一条回答下面，展开时滚到看得见。
    if (!panel.hidden) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  actions.append(copy, sources, time, feedback);
  answer.append(actions, panel);
  document.querySelectorAll(".answer-latest").forEach(node => node.classList.remove("answer-latest"));
  answer.classList.add("answer-latest");
}

/** 「来源」面板里的一节；回答还没有文末一排时返回 null。 */
export function answerPanelSection(answer: HTMLElement, kind: keyof typeof SECTION_TITLES): HTMLElement | null {
  const panel = answer.querySelector<HTMLElement>(":scope > .answer-panel");

  if (!panel) return null;
  let section = panel.querySelector<HTMLElement>(`:scope > [data-section="${kind}"]`);

  if (!section) {
    section = document.createElement("section");
    section.dataset.section = kind;
    const title = document.createElement("h3");
    title.textContent = SECTION_TITLES[kind];
    const body = document.createElement("div");
    body.className = "answer-panel-body";
    section.append(title, body);

    // 网页在前，记忆在后。
    if (kind === "sources") panel.prepend(section);
    else panel.append(section);
  }

  // SAFETY: 上面刚建的结构里第二个子元素就是 body。
  return section.querySelector<HTMLElement>(".answer-panel-body")!;
}

/** 面板内容变了之后调用：有内容才露出「来源」，按钮前放最多两个站点的首字母方块。 */
export function refreshAnswerPanel(answer: HTMLElement): void {
  const button = answer.querySelector<HTMLButtonElement>(":scope > .answer-actions > .answer-sources-btn");
  const panel = answer.querySelector<HTMLElement>(":scope > .answer-panel");

  if (!button || !panel) return;

  for (const section of panel.querySelectorAll<HTMLElement>(":scope > section")) {
    section.hidden = !section.querySelector(".answer-panel-body")?.childElementCount;
  }

  const shown = panel.querySelectorAll(":scope > section:not([hidden])");
  button.hidden = shown.length === 0;

  if (button.hidden) panel.hidden = true;

  const glyphs = Array.from(panel.querySelectorAll<HTMLElement>(".answer-source-glyph"));
  const hosts = new Map(glyphs.map(node => [node.dataset.host ?? node.textContent ?? "", node]));
  // SAFETY: cloneNode 保持原节点类型。
  const squares = [...hosts.values()].slice(0, 2).map(node => node.cloneNode(true) as HTMLElement);

  button.replaceChildren(...squares, glyphs.length ? "来源" : "记忆");
}

/** 站点图标：浏览器缓存里的网站真图标（YIS-74）；取不到时退回首字母方块。 */
export function siteGlyph(url: string, host: string): HTMLElement {
  const glyph = document.createElement("span");
  glyph.className = "answer-source-glyph";
  glyph.dataset.host = host;
  glyph.setAttribute("aria-hidden", "true");
  const letter = host.charAt(0).toUpperCase();

  if (!chrome.runtime?.getURL) {
    glyph.textContent = letter;

    return glyph;
  }

  const img = document.createElement("img");
  img.alt = "";
  img.src = `${chrome.runtime.getURL("/_favicon/")}?pageUrl=${encodeURIComponent(url)}&size=32`;
  img.onerror = () => { glyph.textContent = letter; };

  glyph.append(img);

  return glyph;
}

export function setAnswerTime(answer: HTMLElement, text: string): void {
  const time = answer.querySelector<HTMLElement>(":scope > .answer-actions > .answer-time");

  if (time) time.textContent = text;
}
