import { Check, createElement as icon } from "lucide";
import { openGatedImage, sanitizeAnswerHtml } from "../shared/answer-html.js";
import { renderMarkdownHtml as renderShared } from "../shared/markdown.js";

const IN_SIDE_PANEL = typeof location !== "undefined" && location.pathname.endsWith("/sidepanel.html");

const LANGUAGE_NAMES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", py: "Python", python: "Python",
  sh: "Shell", bash: "Shell", shell: "Shell", json: "JSON", html: "HTML", css: "CSS",
};

const COPIED_MS = 1500;

const TOKEN = crypto.randomUUID();

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
  wrap.setAttribute("aria-label", "换行");
  wrap.setAttribute("aria-pressed", "true");
  wrap.dataset.codeBlock = TOKEN;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "code-block-copy";
  copy.setAttribute("aria-label", "复制代码");
  copy.dataset.codeBlock = TOKEN;
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
  const html = sanitizeAnswerHtml(renderShared(text));

  if (!IN_SIDE_PANEL || !html.includes("<pre")) return html;
  const template = document.createElement("template");
  template.innerHTML = html;

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

if (typeof document !== "undefined") document.addEventListener("click", openGatedImage);

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
    const text = (block.querySelector("pre > code")?.textContent ?? "").replace(/\n$/, "");
    navigator.clipboard.writeText(text).then(() => flash(button, "copied"), () => flash(button, "failed"));
  });
}
