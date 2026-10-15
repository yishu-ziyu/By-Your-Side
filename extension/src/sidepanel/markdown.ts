import { Check, createElement as icon } from "lucide";
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

function codeBlockHead(code: Element): HTMLElement {
  const lang = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1] ?? "";
  const head = document.createElement("div");
  head.className = "code-block-head";
  const label = document.createElement("span");
  label.className = "code-block-lang";
  label.setAttribute("data-label", LANGUAGE_NAMES[lang.toLowerCase()] ?? (lang || "代码"));
  const wrap = document.createElement("button");
  wrap.type = "button";
  wrap.className = "code-block-wrap";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-block-copy";
  // 两面叠在同一格，宽度按「已复制 ✓」算：切换时旁边的「换行」不挪。
  const idle = document.createElement("span");
  idle.className = "code-block-face";
  const done = document.createElement("span");
  done.className = "code-block-face code-block-face-done";
  const check = icon(Check);
  check.setAttribute("width", "12");
  check.setAttribute("height", "12");
  check.setAttribute("aria-hidden", "true");
  done.append(check);
  copy.append(idle, done);
  const actions = document.createElement("span");
  actions.className = "code-block-actions";
  actions.append(wrap, copy);
  head.append(label, actions);

  return head;
}

export function renderMarkdownHtml(text: string): string {
  const html = renderShared(text);

  if (!IN_SIDE_PANEL || !html.includes("<pre")) return html;
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const pre of template.content.querySelectorAll("pre")) {
    const code = pre.querySelector(":scope > code");

    if (!code) continue;
    const block = document.createElement("div");
    block.className = "code-block";
    pre.replaceWith(block);
    block.append(codeBlockHead(code), pre);
  }

  return template.innerHTML;
}

// 流式输出时正文每一帧整段换新，所以用委托，不给每个按钮单独绑。
if (IN_SIDE_PANEL) {
  document.addEventListener("click", (event) => {
    // SAFETY: click 事件的 target 是 Element。
    const button = (event.target as Element).closest<HTMLButtonElement>(".code-block-head button");
    const block = button?.closest<HTMLElement>(".code-block");

    if (!button || !block) return;

    if (button.classList.contains("code-block-wrap")) {
      block.classList.toggle("code-block-nowrap");

      return;
    }
    // marked 在代码末尾多给一个换行，不是代码的一部分。
    const text = (block.querySelector("pre > code")?.textContent ?? "").replace(/\n$/, "");
    void navigator.clipboard.writeText(text).then(() => {
      button.classList.remove("copied");
      void button.offsetWidth;
      button.classList.add("copied");
      clearTimeout(Number(button.dataset.copiedTimer));
      button.dataset.copiedTimer = String(setTimeout(() => button.classList.remove("copied"), COPIED_MS));
    }, () => undefined);
  });
}
