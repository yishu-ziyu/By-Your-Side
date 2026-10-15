import { Check, createElement as icon } from "lucide";
import { sanitizeAnswerHtml } from "../shared/answer-html.js";
import { renderMarkdownHtml as renderShared } from "../shared/markdown.js";

/**
 * 侧栏回答里的代码块：上面一条语言名 +「换行 / 不换行」+「复制」，默认换行。
 * 条上的字全写在 data-* 里由 CSS 显示，不是文字节点：整段「复制」读 innerText、收短和读完时间数 textContent，
 * 都不会把「JavaScript 换行 复制」算进回答。fence 的语言名只经 setAttribute 进来，不拼进 HTML。
 * 查看生成文件的页面也用这个渲染器，但没有这些样式，所以只在侧栏里加。
 */
const IN_SIDE_PANEL = typeof location !== "undefined" && location.pathname.endsWith("/sidepanel.html");

const LANGUAGE_NAMES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", py: "Python", python: "Python",
  sh: "Shell", bash: "Shell", shell: "Shell", json: "JSON", html: "HTML", css: "CSS",
};

const COPIED_MS = 1500;

/**
 * 回答原文会透传原始 HTML，渲染后的 HTML 由 main.ts 再交给 innerHTML，按钮节点不是这里建的那些。
 * 所以按钮带一个本页随机串：模型看不到侧栏的 DOM，仿造的「复制」按钮没有它，点了不做事。
 */
const TOKEN = crypto.randomUUID();

/**
 * 复制的字必须就是看到的字：只给 marked 生成的那种纯文本代码块加条。
 * 原始 HTML 能藏字（<span hidden>、style、外层 class），代码里有元素、自己或外层带属性的都不加。
 */
function plainFence(pre: Element, code: Element): boolean {
  if (code.childElementCount || pre.attributes.length) return false;

  if ([...code.attributes].some((a) => a.name !== "class" || !/^language-\S+$/.test(a.value))) return false;

  for (let el = pre.parentElement; el; el = el.parentElement) if ([...el.attributes].some((a) => a.name !== "start")) return false;

  return true;
}

function codeBlockHead(code: Element): HTMLElement {
  const lang = /^language-(\S+)$/.exec(code.className)?.[1] ?? "";
  const head = document.createElement("div");
  head.className = "code-block-head";
  const label = document.createElement("span");
  label.className = "code-block-lang";
  label.setAttribute("data-label", LANGUAGE_NAMES[lang.toLowerCase()] ?? (lang || "代码"));
  const wrap = document.createElement("button");
  wrap.type = "button";
  wrap.className = "code-block-wrap";
  // 看得见的字在「不换行 / 换行」之间变，都含「换行」；按下表示正在换行。
  wrap.setAttribute("aria-label", "换行");
  wrap.setAttribute("aria-pressed", "true");
  wrap.dataset.codeBlock = TOKEN;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-block-copy";
  copy.setAttribute("aria-label", "复制代码");
  copy.dataset.codeBlock = TOKEN;
  // 几面叠在同一格，宽度按最宽的一面算：切换时旁边的「换行」不挪。
  const idle = document.createElement("span");
  idle.className = "code-block-face";
  const done = document.createElement("span");
  done.className = "code-block-face code-block-face-done";
  done.setAttribute("aria-hidden", "true");
  const check = icon(Check);
  check.setAttribute("width", "12");
  check.setAttribute("height", "12");
  done.append(check);
  const failed = document.createElement("span");
  failed.className = "code-block-face code-block-face-failed";
  failed.setAttribute("aria-hidden", "true");
  copy.append(idle, done, failed);
  const actions = document.createElement("span");
  actions.className = "code-block-actions";
  actions.append(wrap, copy);
  head.append(label, actions);

  return head;
}

export function renderMarkdownHtml(text: string): string {
  // 先消毒再加条：加条时看到的就是最后显示的结构，条上的按钮也不会被正文的规则删掉。
  const html = sanitizeAnswerHtml(renderShared(text));

  if (!IN_SIDE_PANEL || !html.includes("<pre")) return html;
  const template = document.createElement("template");
  template.innerHTML = html;

  // 模型写的 code-block* class 去掉，仿造不出这一条的样子。
  for (const el of template.content.querySelectorAll("[class*='code-block']")) {
    for (const name of [...el.classList]) if (name.startsWith("code-block")) el.classList.remove(name);
  }

  for (const pre of template.content.querySelectorAll("pre")) {
    const code = pre.firstElementChild;

    if (!code || code.tagName !== "CODE" || pre.childNodes.length !== 1 || !plainFence(pre, code)) continue;
    const block = document.createElement("div");
    block.className = "code-block";
    pre.replaceWith(block);
    block.append(codeBlockHead(code), pre);
  }

  return template.innerHTML;
}

function flash(button: HTMLElement, state: "copied" | "failed"): void {
  button.classList.remove("copied", "failed");
  void button.offsetWidth;
  button.classList.add(state);
  clearTimeout(Number(button.dataset.copiedTimer));
  button.dataset.copiedTimer = String(setTimeout(() => button.classList.remove(state), COPIED_MS));
}

// 流式输出时正文每一帧整段换新，所以用委托，不给每个按钮单独绑。
if (IN_SIDE_PANEL) {
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(".code-block-head button");
    const block = button?.closest<HTMLElement>(".code-block");

    if (!button || !block || button.dataset.codeBlock !== TOKEN) return;

    if (button.classList.contains("code-block-wrap")) {
      const wrapped = !block.classList.toggle("code-block-nowrap");
      button.setAttribute("aria-pressed", String(wrapped));

      return;
    }
    // marked 在代码末尾多给一个换行，不是代码的一部分。
    const text = (block.querySelector("pre > code")?.textContent ?? "").replace(/\n$/, "");
    navigator.clipboard.writeText(text).then(() => flash(button, "copied"), () => flash(button, "failed"));
  });
}
