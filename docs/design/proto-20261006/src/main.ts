/**
 * BYS 侧栏高保真原型。
 * 结构照搬 extension/src/sidepanel/main.ts 的 app.innerHTML（id / class 不改），
 * 样式直接用生产 styles.css；流式显示用仓库原文件 stream-reveal.ts + shared/markdown.ts。
 * 新接的库：@floating-ui/dom（菜单 / 弹层 / 提示）、remend（补全半截 Markdown）、
 * motion/mini（弹簧）、@formkit/auto-animate（chip 增删）。
 */
import { computePosition, autoUpdate, offset, flip, shift, type Placement } from "@floating-ui/dom";
import remend from "remend";
import { animate } from "motion/mini";
import autoAnimate from "@formkit/auto-animate";
import DOMPurify from "dompurify";
import { createElement as icon, ArrowUp, Square, Ellipsis, SquarePen, Brain, ChevronDown, ChevronRight, Copy, Globe, Mail, CalendarDays, FileText, Plus } from "lucide";
import { renderMarkdownHtml } from "./vendor/markdown.js";
import { revealText } from "./vendor/stream-reveal.js";

type V = "A" | "B" | "C";
type Surface = "topbar" | "chips" | "process" | "memory";

const params = new URLSearchParams(location.search);
const state: Record<Surface, V> = {
  topbar: (params.get("topbar") as V) || "A",
  chips: (params.get("chips") as V) || "A",
  process: (params.get("process") as V) || "A",
  memory: (params.get("memory") as V) || "A",
};
if (params.has("nopicker")) document.body.classList.add("hide-picker");

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// 生产同款：渲染出的链接一律新开标签页
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
});

/** steps.ts splitAction 原样：「填写「回复草稿」」→ 填写 / 「回复草稿」 */
function splitAction(text: string): { verb: string; object: string } {
  const quote = text.indexOf("「");
  const space = text.indexOf(" ");
  const at = quote > 0 ? quote : space > 0 ? space : -1;
  return at < 0 ? { verb: text, object: "" } : { verb: text.slice(0, at).trim(), object: text.slice(at).trim() };
}
function paintAction(el: HTMLElement, text: string): void {
  const { verb, object } = splitAction(text);
  const v = document.createElement("span"); v.className = "act-verb"; v.textContent = verb;
  if (!object) { el.replaceChildren(v); return; }
  const o = document.createElement("span"); o.className = "act-object"; o.textContent = object;
  el.replaceChildren(v, " ", o);
}

/* ─────────────── 宿主页 + 侧栏骨架 ─────────────── */
document.body.className = "proto-page" + (params.has("nopicker") ? " hide-picker" : "");
document.body.innerHTML = `
<div id="host" aria-label="Gmail（模拟宿主网页）">
  <div class="g-top"><div class="g-logo">✉ Gmail</div><div class="g-search">搜索邮件</div></div>
  <div class="g-body">
    <div class="g-nav"><div class="on">收件箱 12</div><div>已加星标</div><div>已发送</div><div>草稿 1</div></div>
    <div class="g-read">
      <h1>Product Designer 职位 —— 想约你聊聊</h1>
      <div class="g-from"><span class="g-av">L</span><span><b>Lena Wu</b> &lt;lena@northwind.io&gt;<br/>发给我 · 10月5日 周一 16:12</span></div>
      <div class="g-mail">
        <p>Hi Mike，</p>
        <p>我是 Northwind 的招聘负责人 Lena。看了你在 By Your Side 上的设计，很喜欢那种安静的侧栏体验。我们在招一位 Product Designer，负责 AI 助手的交互。</p>
        <p>下周方便约 30 分钟视频聊聊吗？你定时间就好。</p>
        <p>Lena</p>
      </div>
      <div class="g-reply">
        <div class="g-reply-to">回复 Lena Wu</div>
        <div class="g-draft" id="g-draft"></div>
        <div class="g-actions"><button class="g-send" id="g-send" type="button">发送</button><span class="g-note" id="g-note"></span></div>
      </div>
    </div>
  </div>
  <div id="picker"></div>
</div>
<div id="panel"><div id="app" class="starter-ready"></div></div>`;

const app = document.getElementById("app")!;
// 下面这段对照生产 app.innerHTML：顶栏、对话区（含两条渐隐带）、起始区、输入区的 id 都不改。
app.innerHTML = `
  <header id="topbar">
    <button id="conversation-switcher" type="button" aria-haspopup="menu" aria-expanded="false" title="切换会话"><span class="conversation-title">回复招聘邮件</span></button>
    <div class="tb-group">
      <button class="tb-icon tb-extra tb-new" type="button" aria-label="新会话" title="新会话"></button>
      <button class="tb-icon tb-extra tb-memory" type="button" aria-label="记忆" title="记忆"></button>
      <button id="header-more" type="button" aria-label="更多" title="更多"></button>
    </div>
  </header>
  <div id="messages-frame">
    <div id="messages"></div>
    <div class="scroll-fade" data-edge="top" aria-hidden="true"></div>
    <div class="scroll-fade" data-edge="bottom" aria-hidden="true"></div>
  </div>
  <section id="starter" aria-label="开始方式">
    <p id="starter-title">说说你想完成什么</p>
    <p id="starter-sub">浏览器 AI 助手，帮你读页面、整理信息或操作网页。</p>
    <div id="starter-actions">
      <button type="button" data-starter="请概括当前页面的要点。">概括当前页</button>
      <button type="button" data-starter="请帮我填写当前页面的表单，提交前让我确认。">帮我填写表单</button>
    </div>
  </section>
  <div class="composer-dock-wrap">
    <div id="chips-slot-a"></div>
    <div id="composer">
      <div id="chips-slot-b"></div>
      <p class="composer-hint" id="composer-hint" hidden>起点已填进输入框，改好再发送。</p>
      <textarea id="input" rows="1" placeholder="说说你想完成什么…"></textarea>
      <div id="composer-bar">
        <button id="attach-btn" class="composer-icon-btn" type="button" title="添加上下文" aria-haspopup="true">+</button>
        <span id="composer-spacer"></span>
        <button id="composer-more" type="button" aria-label="输入选项">···</button>
        <button id="continue-btn" type="button" title="接着做这件事">继续</button>
        <button id="send-btn" class="kinetic-morph-button" type="button" title="发送">
          <span class="morph-icon-send"></span><span class="morph-icon-stop"></span>
        </button>
      </div>
    </div>
  </div>
  <div class="fl-menu" id="header-menu-fl" role="menu" hidden></div>
  <div class="fl-menu" id="chip-menu" role="menu" hidden></div>
  <div class="fl-tip" id="fl-tip" hidden></div>`;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
const topbar = $("#topbar");
const messagesEl = $("#messages");
const frame = $("#messages-frame");
const inputEl = $<HTMLTextAreaElement>("#input");
$("#conversation-switcher").append(icon(ChevronDown));
$(".tb-new").append(icon(SquarePen));
$(".tb-memory").append(icon(Brain));
$("#header-more").append(icon(Ellipsis));
$(".morph-icon-send").append(icon(ArrowUp));
$(".morph-icon-stop").append(icon(Square));

/* ─────────────── Floating UI：菜单 / 弹层 / 提示 ─────────────── */
type Floating = { open: (anchor: HTMLElement) => void; close: () => void; isOpen: () => boolean };
function floating(el: HTMLElement, placement: Placement, onToggle?: (open: boolean) => void): Floating {
  let cleanup: (() => void) | null = null;
  let anchorEl: HTMLElement | null = null;
  const close = () => {
    if (el.hidden) return;
    el.hidden = true; cleanup?.(); cleanup = null; onToggle?.(false);
    anchorEl?.setAttribute("aria-expanded", "false");
  };
  const open = (anchor: HTMLElement) => {
    anchorEl = anchor; el.hidden = false; anchor.setAttribute("aria-expanded", "true"); onToggle?.(true);
    cleanup = autoUpdate(anchor, el, () => {
      void computePosition(anchor, el, { placement, strategy: "absolute", middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })] })
        .then(({ x, y }) => Object.assign(el.style, { left: `${x}px`, top: `${y}px` }));
    });
    if (!reduced()) animate(el, { opacity: [0, 1], transform: ["translateY(-4px) scale(.96)", "none"] }, { duration: 0.24, ease: [0.16, 1, 0.3, 1] });
    (el.querySelector("button") as HTMLElement | null)?.focus({ preventScroll: true });
  };
  document.addEventListener("pointerdown", (e) => { if (!el.hidden && !el.contains(e.target as Node) && !anchorEl?.contains(e.target as Node)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.hidden) { close(); anchorEl?.focus(); } });
  return { open, close, isOpen: () => !el.hidden };
}

const headerMenuEl = $("#header-menu-fl");
const headerMenu = floating(headerMenuEl, "bottom-end", (o) => o ? topbar.setAttribute("data-menu-open", "") : topbar.removeAttribute("data-menu-open"));
function renderHeaderMenu(): void {
  // A：「＋ 新会话」收进菜单；B / C 顶栏已有新会话图标，菜单就不重复
  const withNew = state.topbar === "A";
  headerMenuEl.innerHTML = `
    ${withNew ? `<button type="button" role="menuitem" data-act="new"><span>新会话</span><kbd>⌘K</kbd></button>` : ""}
    ${state.topbar !== "B" ? `<button type="button" role="menuitem" data-act="memory"><span>记忆</span></button>` : ""}
    <hr />
    <button type="button" role="menuitem"><span>当前模型</span><span class="mi-sub">DeepSeek V4</span></button>
    <button type="button" role="menuitem"><span>模型与语音</span></button>
    <button type="button" role="menuitem"><span>阅读外观</span></button>`;
}
$("#header-more").addEventListener("click", (e) => {
  if (headerMenu.isOpen()) { headerMenu.close(); return; }
  renderHeaderMenu(); headerMenu.open(e.currentTarget as HTMLElement);
});
headerMenuEl.addEventListener("click", (e) => {
  const b = (e.target as Element).closest("button"); if (!b) return;
  headerMenu.close();
  if (b.dataset.act === "new") newConversation();
});
$(".tb-new").addEventListener("click", () => newConversation());

// 提示：句内链接悬停时出完整去处
const tip = $("#fl-tip");
let tipCleanup: (() => void) | null = null;
function showTip(anchor: HTMLElement, html: string): void {
  tip.innerHTML = html; tip.hidden = false;
  tipCleanup?.();
  tipCleanup = autoUpdate(anchor, tip, () => void computePosition(anchor, tip, { placement: "bottom-start", middleware: [offset(6), flip(), shift({ padding: 8 })] })
    .then(({ x, y }) => Object.assign(tip.style, { left: `${x}px`, top: `${y}px` })));
}
function hideTip(): void { tip.hidden = true; tipCleanup?.(); tipCleanup = null; }

/* ─────────────── 上下文 chip（AutoAnimate 负责增删） ─────────────── */
type Ctx = { id: string; label: string; glyph: "mail" | "cal" | "file" };
const CTX_ALL: Ctx[] = [
  { id: "page", label: "Gmail · 草稿", glyph: "mail" },
  { id: "mail", label: "Lena 的来信", glyph: "mail" },
  { id: "cal", label: "日历 · 下周", glyph: "cal" },
  { id: "cv", label: "作品集.pdf", glyph: "file" },
];
let ctx: Ctx[] = CTX_ALL.slice(0, 3);
const chipsEl = document.createElement("div");
chipsEl.className = "ctx-chips";
chipsEl.setAttribute("aria-label", "带给助手的上下文");
autoAnimate(chipsEl, { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
const glyphFor = (g: Ctx["glyph"]) => icon(g === "mail" ? Mail : g === "cal" ? CalendarDays : FileText);

function chipNode(c: Ctx): HTMLElement {
  const el = document.createElement("span");
  el.className = "ctx-chip"; el.dataset.id = c.id;
  const g = document.createElement("span"); g.className = "cg"; g.append(glyphFor(c.glyph));
  const l = document.createElement("span"); l.className = "cl"; l.textContent = c.label;
  const x = document.createElement("button"); x.className = "cx"; x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", `去掉「${c.label}」`);
  x.onclick = () => removeChip(c.id);
  el.append(g, l, x);
  return el;
}
function renderChips(): void {
  // 只做增量：AutoAnimate 看 DOM 增删来补动画
  const want = new Set(ctx.map((c) => c.id));
  chipsEl.querySelectorAll<HTMLElement>(".ctx-chip").forEach((n) => { if (!want.has(n.dataset.id!)) n.remove(); });
  for (const c of ctx) if (!chipsEl.querySelector(`[data-id="${c.id}"]`)) chipsEl.append(chipNode(c));
}
function removeChip(id: string): void { ctx = ctx.filter((c) => c.id !== id); renderChips(); }
function addChip(id: string): void { const c = CTX_ALL.find((x) => x.id === id); if (c && !ctx.some((x) => x.id === id)) { ctx.push(c); renderChips(); } }

const chipMenuEl = $("#chip-menu");
const chipMenu = floating(chipMenuEl, "top-start");
function openChipMenu(anchor: HTMLElement): void {
  if (chipMenu.isOpen()) { chipMenu.close(); return; }
  const missing = CTX_ALL.filter((c) => !ctx.some((x) => x.id === c.id));
  chipMenuEl.innerHTML = `<p class="mi-label">带给助手</p>` + (missing.length
    ? missing.map((c) => `<button type="button" role="menuitem" data-add="${c.id}"><span>${c.label}</span></button>`).join("")
    : `<button type="button" disabled><span style="color:var(--text-tertiary)">都已带上</span></button>`) +
    `<hr /><button type="button" role="menuitem"><span>截取当前网页视口</span></button><button type="button" role="menuitem"><span>上传本地图片</span></button>`;
  chipMenu.open(anchor);
}
chipMenuEl.addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>("button[data-add]"); if (b) { addChip(b.dataset.add!); chipMenu.close(); } });
$("#attach-btn").addEventListener("click", (e) => openChipMenu(e.currentTarget as HTMLElement));

function placeChips(): void {
  chipsEl.dataset.place = state.chips;
  if (state.chips === "A") $("#chips-slot-a").append(chipsEl);
  else if (state.chips === "B") $("#chips-slot-b").append(chipsEl);
  else {
    const lastUser = Array.from(messagesEl.querySelectorAll(".msg.user")).pop();
    if (lastUser) lastUser.after(chipsEl); else $("#chips-slot-a").append(chipsEl);
  }
}

/* ─────────────── 滚动渐隐（C 锁定：40px + 2px 模糊，只在能滚的一侧） ─────────────── */
function syncFade(): void {
  const { scrollTop, scrollHeight, clientHeight } = messagesEl;
  frame.dataset.fadeTop = String(scrollTop > 2);
  frame.dataset.fadeBottom = String(scrollHeight - scrollTop - clientHeight > 2);
}
messagesEl.addEventListener("scroll", syncFade, { passive: true });
new ResizeObserver(syncFade).observe(messagesEl);
let pinned = true;
messagesEl.addEventListener("wheel", () => { pinned = false; }, { passive: true });
const scrollToEnd = () => { if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight; syncFade(); };

/* ─────────────── 场景内容 ─────────────── */
const USER_TEXT = "帮我回这封招聘邮件，约下周二或周三下午聊，语气别太正式。";
const STEPS = [
  { live: "正在读取「Lena 的来信」", past: "读了「Lena 的来信」" },
  { live: "正在查看「日历 · 下周」", past: "看了「日历 · 下周」" },
  { live: "正在填写「回复草稿」", past: "填写了「回复草稿」" },
];
const LEAD = "因为你之前说过回招聘邮件要先给时间、少客套，我按这个写好了草稿：";
const ANSWER = `${LEAD}

读完 [原文](https://mail.google.com/mail/u/0/#inbox/lena) 和你的 [下周日历](https://calendar.google.com/calendar/u/0/r/week) 后，草稿已经填进 Gmail 回复框，**还没发送**：

> Hi Lena，谢谢来信，这个方向我很感兴趣。下周二（10/13）14:00–17:00，或周三（10/14）15:00 以后都可以，30 分钟视频就好。
>
> Mike

1. **时间**：只给了日历上空着的两段，避开周三上午的评审。
2. **语气**：去掉了「非常荣幸」这类客套，保留一句感谢。

[在 Gmail 里查看草稿](https://mail.google.com/mail/u/0/#drafts)`;
const DRAFT = "Hi Lena，\n\n谢谢来信，这个方向我很感兴趣。下周二（10/13）14:00–17:00，或周三（10/14）15:00 以后都可以，30 分钟视频就好。\n\nMike";
const MEMORY_ROWS = [
  { glyph: "past", text: "先给可约时间，再说背景" },
  { glyph: "profile", text: "短句，不写客套话" },
];
// 生产 main.ts USED_GLYPHS 原样
const USED_GLYPHS: Record<string, string> = {
  past: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="5" r="4"/><path d="M5 2.8V5l1.5 1"/></svg>',
  profile: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="3.3" r="1.8"/><path d="M1.6 9c.4-1.9 1.8-2.9 3.4-2.9S8 7.1 8.4 9"/></svg>',
};

/** 句内链接：14px 小图标 + 墨蓝字。Lena 的信用头像，日历/草稿用 lucide，其余用地球。 */
function linkIcon(href: string): HTMLElement {
  const box = document.createElement("span");
  box.className = "il-ico";
  box.setAttribute("aria-hidden", "true");
  if (href.includes("#inbox/lena")) { box.classList.add("av"); box.textContent = "L"; return box; }
  box.append(icon(href.includes("calendar.google") ? CalendarDays : href.includes("#drafts") ? Mail : Globe));
  return box;
}
const LINK_TIPS: Record<string, string> = {
  "#inbox/lena": "Lena Wu · Product Designer 职位<small>mail.google.com</small>",
  "calendar.google": "日历 · 10/12 – 10/18<small>calendar.google.com</small>",
  "#drafts": "回复 Lena Wu（草稿，未发送）<small>mail.google.com</small>",
};

/** 渲染链：remend 补全半截 Markdown → 生产 renderMarkdownHtml → DOMPurify → 句内链接 chip。 */
function render(text: string): string {
  let html = renderMarkdownHtml(remend(text));
  // remend 把半截链接写成 streamdown:incomplete-link，DOMPurify 会剥掉这种协议；先改成纯文字
  html = html.replace(/<a href="streamdown:incomplete-link">([\s\S]*?)<\/a>/g, '<span class="link-pending">$1</span>');
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(html);
  tpl.content.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    a.classList.add("inline-link");
    a.prepend(linkIcon(a.getAttribute("href")!));
    if (a.parentElement?.tagName === "P" && a.parentElement.childNodes.length === 1) a.parentElement.classList.add("link-line");
  });
  return tpl.innerHTML;
}

/* ─────────────── 一轮对话 ─────────────── */
let runToken = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function userBubble(): HTMLElement {
  const el = document.createElement("div");
  el.className = "msg user"; el.textContent = USER_TEXT;
  return el;
}

type Run = { root: HTMLDetailsElement; title: HTMLElement; time: HTMLElement; stack: HTMLElement; body: HTMLElement; reveal: HTMLElement };
function buildRun(): Run {
  const root = document.createElement("details");
  root.className = "run-steps"; root.dataset.v = state.process;
  const summary = document.createElement("summary");
  const title = document.createElement("span"); title.className = "run-title";
  const time = document.createElement("span"); time.className = "run-time";
  const chev = document.createElement("span"); chev.className = "run-chevron"; chev.append(icon(ChevronRight));
  const stack = document.createElement("div"); stack.className = "run-stack";
  summary.append(stack, title, time, chev);
  const reveal = document.createElement("div"); reveal.className = "run-reveal";
  const body = document.createElement("div"); body.className = "run-body";
  reveal.append(body);
  root.append(summary, reveal);
  summary.addEventListener("click", (e) => { e.preventDefault(); toggleRun(root, reveal); });
  return { root, title, time, stack, body, reveal };
}

/** 过程展开：Motion 弹簧（三版共用；A 版进行中也能点开看实时步骤）。 */
function toggleRun(root: HTMLDetailsElement, reveal: HTMLElement): void {
  if (!root.classList.contains("done") && root.dataset.v !== "A") return;
  const opening = !root.open;
  if (reduced()) { root.open = opening; return; }
  if (opening) {
    root.open = true;
    const h = reveal.scrollHeight;
    animate(reveal, { height: [0, h], opacity: [0, 1] }, { type: "spring", stiffness: 420, damping: 34, mass: 1 } as never).finished.then(() => { reveal.style.height = ""; });
  } else {
    const h = reveal.offsetHeight;
    animate(reveal, { height: [h, 0], opacity: [1, 0] }, { duration: 0.18, ease: [0.4, 0, 0.2, 1] }).finished.then(() => { root.open = false; reveal.style.height = ""; reveal.style.opacity = ""; });
  }
}

function addStepRow(run: Run, text: string): void {
  const chip = document.createElement("button");
  chip.type = "button"; chip.className = "chip";
  const label = document.createElement("span"); label.className = "chip-label"; paintAction(label, text);
  const more = document.createElement("span"); more.className = "chip-more"; more.append(icon(ChevronRight));
  chip.append(label, more);
  run.body.append(chip);
}

async function setLiveTitle(run: Run, text: string, first: boolean): Promise<void> {
  const v = run.root.dataset.v as V;
  if (v === "B" && !first && !reduced()) {
    // B：动词换句时淡出 / 淡入，对象跟着走
    await animate(run.title, { opacity: [1, 0], transform: ["none", "translateY(-4px)"] }, { duration: 0.14, ease: [0.4, 0, 0.2, 1] }).finished;
    paintAction(run.title, text);
    animate(run.title, { opacity: [0, 1], transform: ["translateY(4px)", "none"] }, { duration: 0.3, ease: [0.16, 1, 0.3, 1] });
  } else paintAction(run.title, text);
  if (v === "C") {
    const line = document.createElement("div"); line.className = "rs-line"; paintAction(line, text);
    run.stack.append(line);
    const lines = Array.from(run.stack.children) as HTMLElement[];
    lines.forEach((l, i) => { l.dataset.age = String(lines.length - 1 - i); });
    if (lines.length > 3) lines[0]!.remove();
    if (!reduced()) animate(line, { opacity: [0, 1], transform: ["translateY(4px)", "none"] }, { duration: 0.3, ease: [0.16, 1, 0.3, 1] });
  }
}

let memEls: { toggle: HTMLButtonElement; wrap: HTMLElement; lead: HTMLElement } | null = null;

function attachMemoryCite(answer: HTMLElement): void {
  const lead = answer.querySelector("p")!;
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.className = "memory-used-toggle cite-pop";
  toggle.setAttribute("aria-expanded", "false");
  const chevron = document.createElement("span"); chevron.className = "memory-used-chevron"; chevron.textContent = "›";
  toggle.append("用了 2 条记忆 ", chevron);
  lead.append(toggle);
  const wrap = document.createElement("div");
  wrap.className = "mx-wrap"; wrap.dataset.v = state.memory;
  wrap.innerHTML = `<div class="mx" role="group" aria-label="用到的记忆"><ul>${MEMORY_ROWS.map((r) => `<li><span class="g">${USED_GLYPHS[r.glyph]}</span>${r.text}</li>`).join("")}</ul></div>`;
  if (state.memory !== "B") wrap.hidden = true;
  lead.after(wrap);
  toggle.onclick = () => setMemoryOpen(toggle.getAttribute("aria-expanded") !== "true");
  memEls = { toggle, wrap, lead };
}

function setMemoryOpen(open: boolean): void {
  if (!memEls) return;
  const { toggle, wrap, lead } = memEls;
  const v = wrap.dataset.v as V;
  toggle.setAttribute("aria-expanded", String(open));
  lead.classList.toggle("lead-open", open);
  if (v === "B") { open ? wrap.setAttribute("data-open", "") : wrap.removeAttribute("data-open"); return; }
  if (v === "C" || reduced()) { wrap.hidden = !open; open ? wrap.setAttribute("data-open", "") : wrap.removeAttribute("data-open"); return; }
  // A：Motion 弹簧撑开高度
  if (open) {
    wrap.hidden = false; wrap.setAttribute("data-open", "");
    const h = wrap.scrollHeight;
    animate(wrap, { height: [0, h], opacity: [0, 1] }, { type: "spring", stiffness: 380, damping: 30 } as never).finished.then(() => { wrap.style.height = ""; });
  } else {
    const h = wrap.offsetHeight;
    animate(wrap, { height: [h, 0], opacity: [1, 0] }, { duration: 0.16, ease: [0.4, 0, 0.2, 1] }).finished.then(() => { wrap.hidden = true; wrap.removeAttribute("data-open"); wrap.style.height = ""; wrap.style.opacity = ""; });
  }
}

function answerActions(): HTMLElement {
  const row = document.createElement("div");
  row.className = "answer-actions";
  const copy = document.createElement("button"); copy.type = "button"; copy.title = "复制"; copy.setAttribute("aria-label", "复制"); copy.append(icon(Copy));
  const time = document.createElement("span"); time.className = "answer-time"; time.textContent = "7 秒";
  row.append(copy, time);
  return row;
}

function confirmBlock(): HTMLElement {
  const box = document.createElement("div");
  box.className = "receipt-decision";
  box.innerHTML = `<strong>发送这封邮件？</strong>
    <p>草稿在 Gmail 回复框里。我不会替你发送，你看过再按发送。</p>
    <div><button type="button" data-act="send">我来发送</button><button type="button" data-act="edit">再改改</button></div>`;
  box.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button"); if (!b) return;
    if (b.dataset.act === "edit") { fillDraft("再改改：", false); return; }
    // 只把用户带到发送键，不代按
    const send = document.getElementById("g-send")!;
    send.setAttribute("data-armed", "");
    document.getElementById("g-note")!.textContent = "BYS 已停在这里，等你按发送";
    box.querySelector("p")!.innerHTML = `已在 Gmail 里定位到「发送」，<b style="font-weight:500;color:var(--text-primary)">等你按下</b>。`;
    (box.querySelector("[data-act=send]") as HTMLButtonElement).disabled = true;
  });
  return box;
}

function diagFold(): HTMLElement {
  const d = document.createElement("details");
  d.className = "diag-fold";
  d.innerHTML = `<summary>诊断（只记录问题）· 2</summary><ul>
    <li>读取「日历 · 下周」2.1s，比平时慢 1.4s</li>
    <li>回复框里有 1 个没认出的按钮，已跳过</li></ul>`;
  return d;
}

function nextStarters(): HTMLElement {
  const box = document.createElement("div");
  box.className = "next-starters";
  box.setAttribute("aria-label", "接下来可以");
  const items = [
    { label: "语气再放松一点", prompt: "把草稿语气再放松一点，像朋友之间回信。" },
    { label: "加上作品集链接", prompt: "在草稿末尾加一句作品集链接：" },
  ];
  for (const it of items) {
    const b = document.createElement("button"); b.type = "button"; b.dataset.starter = it.prompt;
    b.innerHTML = `${it.label}<span class="ns-pen">✎</span>`;
    b.title = "填进输入框，改好再发";
    b.onclick = () => fillDraft(it.prompt, true);
    box.append(b);
  }
  return box;
}

/** 起点只填草稿，绝不自动发送（同生产 bindStarterButton）。 */
function fillDraft(text: string, hint: boolean): void {
  inputEl.value = text;
  inputEl.focus();
  inputEl.setSelectionRange(text.length, text.length);
  inputEl.classList.remove("just-filled"); void inputEl.offsetWidth; inputEl.classList.add("just-filled");
  $("#composer-hint").hidden = !hint;
  autoResize();
  requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; syncFade(); });
}
function autoResize(): void { inputEl.style.height = "auto"; inputEl.style.height = `${Math.min(140, Math.max(44, inputEl.scrollHeight))}px`; }
inputEl.addEventListener("input", () => { autoResize(); if (!inputEl.value) $("#composer-hint").hidden = true; });

async function fillGmail(token: number): Promise<void> {
  const el = document.getElementById("g-draft")!;
  el.setAttribute("data-filling", "");
  for (let i = 0; i <= DRAFT.length; i += 3) { if (token !== runToken) return; el.textContent = DRAFT.slice(0, i); await wait(16); }
  el.textContent = DRAFT; el.removeAttribute("data-filling");
}

type Opts = { instant?: boolean };
async function playTurn(opts: Opts = {}): Promise<void> {
  const token = ++runToken;
  const instant = !!opts.instant;
  app.classList.remove("conversation-empty");
  $(".conversation-title").textContent = "回复招聘邮件";
  messagesEl.replaceChildren();
  memEls = null; pinned = true;
  document.getElementById("g-draft")!.textContent = "";
  document.getElementById("g-send")!.removeAttribute("data-armed");
  document.getElementById("g-note")!.textContent = "";
  inputEl.value = ""; $("#composer-hint").hidden = true;
  const sendBtn = $("#send-btn");

  messagesEl.append(userBubble());
  placeChips();
  const run = buildRun();
  messagesEl.append(run.root);
  const start = Date.now();
  const timer = setInterval(() => { run.time.textContent = `${Math.max(1, Math.round((Date.now() - start) / 1000))} 秒`; }, 1000);
  run.time.textContent = "1 秒";

  if (!instant) {
    sendBtn.classList.add("stopping");
    for (let i = 0; i < STEPS.length; i++) {
      if (token !== runToken) { clearInterval(timer); return; }
      await setLiveTitle(run, STEPS[i]!.live, i === 0);
      addStepRow(run, STEPS[i]!.past);
      scrollToEnd();
      if (i === 2) void fillGmail(token);
      await wait(1150);
    }
  } else {
    STEPS.forEach((s) => addStepRow(run, s.past));
    document.getElementById("g-draft")!.textContent = DRAFT;
  }
  clearInterval(timer);
  if (token !== runToken) return;
  // 收成一行回执：做了 N 件事 ›（steps.ts finishedRunTitle）
  run.root.classList.add("done");
  if (run.root.open) { run.root.open = false; }
  paintAction(run.title, `做了 ${STEPS.length} 件事`);
  if (!instant && !reduced() && run.root.dataset.v !== "A") animate(run.root.querySelector("summary")!, { opacity: [0, 1] }, { duration: 0.2 });

  const answer = document.createElement("div");
  answer.className = "msg assistant markdown answer-latest";
  messagesEl.append(answer);

  const finish = () => {
    if (token !== runToken) return;
    sendBtn.classList.remove("stopping");
    attachMemoryCite(answer);
    answer.append(answerActions());
    answer.querySelectorAll<HTMLAnchorElement>("a.inline-link").forEach((a) => {
      const key = Object.keys(LINK_TIPS).find((k) => a.href.includes(k));
      a.addEventListener("click", (e) => e.preventDefault());
      if (key) { a.addEventListener("mouseenter", () => showTip(a, LINK_TIPS[key]!)); a.addEventListener("mouseleave", hideTip); }
    });
    messagesEl.append(confirmBlock(), diagFold(), nextStarters());
    scrollToEnd();
  };

  if (instant) { revealText(answer, ANSWER, { live: false, final: true, render, after: finish }); return; }

  // 模型一阵一阵到：每 70ms 到 4~11 个字，交给生产 stream-reveal 按节奏放出、逐字 300ms 淡入
  let at = 0;
  while (at < ANSWER.length) {
    if (token !== runToken) return;
    at = Math.min(ANSWER.length, at + 4 + Math.floor(Math.random() * 8));
    revealText(answer, ANSWER.slice(0, at), { live: true, final: at >= ANSWER.length, render, onProgress: scrollToEnd, after: finish });
    await wait(70);
  }
}

function newConversation(): void {
  runToken++;
  $(".conversation-title").textContent = "新会话";
  messagesEl.replaceChildren();
  app.classList.add("conversation-empty");
  $("#send-btn").classList.remove("stopping");
  inputEl.value = ""; $("#composer-hint").hidden = true;
  placeChips();
}
app.querySelectorAll<HTMLButtonElement>("#starter-actions button").forEach((b) => { b.onclick = () => fillDraft(b.dataset.starter!, true); });
$("#continue-btn").addEventListener("click", () => void playTurn());
$("#send-btn").addEventListener("click", () => { if (inputEl.value.trim()) void playTurn(); });

/* ─────────────── 变体选择器（侧栏外） ─────────────── */
const DESC: Record<Surface, Record<V, string>> = {
  topbar: { A: "任务名 + ⋯（＋ 收进菜单）", B: "任务名 + 两枚灰图标 + ⋯", C: "只留任务名，指上去才出图标" },
  chips: { A: "输入框上方，贴边一行", B: "输入框边框内顶部", C: "最后一条用户消息下面" },
  process: { A: "单行，› 展开（Motion 弹簧）", B: "单行实时换句，动词淡入", C: "最近三行叠放，旧的变淡" },
  memory: { A: "Motion 弹簧撑开高度", B: "CSS 200ms ease", C: "瞬间出现 + 淡入" },
};
const LABEL: Record<Surface, string> = { topbar: "顶栏", chips: "上下文", process: "过程行", memory: "记忆展开" };
function renderPicker(): void {
  const p = document.getElementById("picker")!;
  p.innerHTML = `<h2>变体（侧栏外，只给你挑）</h2>` + (Object.keys(LABEL) as Surface[]).map((s) => `
    <div class="row"><span>${LABEL[s]}</span><div class="seg">${(["A", "B", "C"] as V[]).map((v) => `<button type="button" data-s="${s}" data-v="${v}" aria-pressed="${state[s] === v}">${v}</button>`).join("")}</div></div>
    <div class="desc">${DESC[s][state[s]]}</div>`).join("") +
    `<div class="acts"><button type="button" data-act="replay">重放流式</button><button type="button" data-act="expand">展开记忆</button></div>`;
}
document.getElementById("picker")!.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("button"); if (!b) return;
  if (b.dataset.act === "replay") { void playTurn(); return; }
  if (b.dataset.act === "expand") { setMemoryOpen(memEls?.toggle.getAttribute("aria-expanded") !== "true"); return; }
  setVariant(b.dataset.s as Surface, b.dataset.v as V);
});
function setVariant(s: Surface, v: V): void {
  state[s] = v;
  renderPicker();
  if (s === "topbar") { topbar.dataset.v = v; headerMenu.close(); }
  if (s === "chips") placeChips();
  if (s === "process") messagesEl.querySelectorAll<HTMLElement>("details.run-steps").forEach((d) => { d.dataset.v = v; });
  if (s === "memory" && memEls) {
    const wasOpen = memEls.toggle.getAttribute("aria-expanded") === "true";
    memEls.wrap.dataset.v = v; memEls.wrap.removeAttribute("data-open"); memEls.wrap.hidden = v !== "B";
    if (wasOpen) { memEls.wrap.hidden = false; memEls.wrap.setAttribute("data-open", ""); }
  }
}

topbar.dataset.v = state.topbar;
renderChips();
renderPicker();
placeChips();

// 给截图 / 录屏脚本用
(window as unknown as Record<string, unknown>).__proto = {
  setVariant, playTurn, setMemoryOpen, addChip, removeChip, newConversation, fillDraft,
  openMenu: () => { renderHeaderMenu(); headerMenu.open($("#header-more")); }, closeMenu: () => headerMenu.close(),
  openChipMenu: () => openChipMenu($("#attach-btn")),
  toggleRun: () => { const d = messagesEl.querySelector<HTMLDetailsElement>("details.run-steps"); if (d) toggleRun(d, d.querySelector(".run-reveal")!); },
  scrollTo: (sel: string) => messagesEl.querySelector(sel)?.scrollIntoView({ block: "center" }),
  showTip: (i = 0) => { const a = messagesEl.querySelectorAll<HTMLElement>("a.inline-link")[i]; if (a) a.dispatchEvent(new MouseEvent("mouseenter")); },
  state,
};

void playTurn({ instant: params.has("instant") });
