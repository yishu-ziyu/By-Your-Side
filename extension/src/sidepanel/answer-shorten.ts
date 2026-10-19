/**
 * 回答写完后拖短：全文 / 要点 / 一句，三层都从这份已画好的回答里显示或隐藏，不再问模型，字和全文一字不差。
 * 要点 = 第一段 + 所有列表和表格 + 下面有列表的小标题 + 卡片只留推荐项（没有推荐项留第一项）；一句 = 第一段的第一句。
 * 层级只活在这一页：历史回放默认全文，不跨会话保存。
 * 拖的时候回答高度跟着手指走：两层之间被拖过的块从下往上逐个收起、淡出；松手后弹到最近的一层。
 */
import { D_LAYOUT } from "../shared/motion-tokens.js";

const LEVELS = ["", "一句", "要点", "全文"] as const;
type Level = 1 | 2 | 3;

/** 不属于回答正文的界面元素：不分层，复制时也去掉（与 answer-actions.ts 的 CHROME 一致）。 */
const CHROME = ".gc-actions,.answer-actions,.answer-panel,.fill-undo-result,.source-fav,.answer-sources,.citation-row,.memory-used-toggle,.memory-used-line,.memory-used-cite-row";
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
/** 松手时按手指速度往前投这么多秒再找最近的一层：轻甩也能换层。 */
const PROJECT_S = 0.15;
/** 朝一个方向拖了这么远，松手至少换一层。 */
const INTENT_PX = 24;
/** 松手后的弹簧：临界阻尼，不过冲。 */
const SPRING_K = 260;

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

function showLevel(answer: HTMLElement, next: Level): void {
  for (const el of answer.querySelectorAll<HTMLElement>("[data-shorten]")) el.classList.toggle("shorten-off", Number(el.dataset.shorten) > next);
  answer.querySelector<HTMLElement>(".shorten-rest")?.classList.toggle("shorten-off", next < 2);
}

/** 记下层级：复制、层名、主动作都按它走。松手就记，不等回弹画完（侧栏藏起来时动画不跑）。 */
function commit(answer: HTMLElement, next: Level): void {
  level.set(answer, next);
  answer.dataset.shortenLevel = String(next);
  const grip = answer.querySelector<HTMLElement>(".shorten-grip");
  const label = answer.querySelector<HTMLElement>(".shorten-level");

  // 上键收短：aria 值按“短的程度”算，上键让值变大，合 slider 惯例。
  grip?.setAttribute("aria-valuenow", String(4 - next));
  grip?.setAttribute("aria-valuetext", LEVELS[next]);
  if (label) label.textContent = LEVELS[next];
  answer.dispatchEvent(new CustomEvent("answer-shorten"));
}

/** 当前层的正文（去掉界面元素和这一层收起的部分）。复制按这一份；按层级算，不看拖动中途的画面。 */
export function visibleBody(answer: HTMLElement, chrome: string): HTMLElement {
  return bodyAt(answer, chrome, level.get(answer) ?? 3);
}

function bodyAt(answer: HTMLElement, chrome: string, lv: Level): HTMLElement {
  const body = answer.cloneNode(true) as HTMLElement;
  body.querySelectorAll(chrome).forEach((node) => node.remove());
  body.querySelectorAll<HTMLElement>("[data-shorten]").forEach((node) => { if (Number(node.dataset.shorten) > lv) node.remove(); });
  if (lv < 2) body.querySelector(".shorten-rest")?.remove();

  return body;
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
  // 层名只在拖动或键盘选中把手时露出来；读屏从把手的 aria-valuetext 听到层名，这里不重复读。
  label.setAttribute("aria-hidden", "true");
  actions.classList.add("has-grip");
  actions.append(grip, label);

  bindGesture(answer, grip, label);
  commit(answer, 3);
}

/** 两层之间可收起的一块。w 是它在本段里占的高度，[a, b] 是它在本段进度里收起的区间。 */
type Piece = { el: HTMLElement; need: 2 | 3; w: number; a: number; b: number; h: number; mt: number; mb: number; pt: number; pb: number; clip?: { rest: HTMLElement; short: number } };

/** 对话区底部临时补的空白归对话区所有：几条回答先后拖，共用一份基准内边距和收空白的动画。 */
const holds = new WeakMap<HTMLElement, { base: number; raf: number; finish?: () => void }>();

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const INLINE = ["height", "marginTop", "marginBottom", "paddingTop", "paddingBottom", "opacity", "overflow"] as const;
const clearInline = (el: HTMLElement) => { for (const k of INLINE) el.style[k] = ""; };

/** 手势：位置用连续层级 p（1 = 一句，3 = 全文）表示，像素位置 x 是回答在 p 时的总高。 */
function bindGesture(answer: HTMLElement, grip: HTMLElement, label: HTMLElement): void {
  const messages = answer.closest<HTMLElement>("#messages");
  const first = answer.querySelector<HTMLElement>('[data-shorten="1"]')!;
  const rest = answer.querySelector<HTMLElement>(".shorten-rest");
  const blocks = Array.from(answer.querySelectorAll<HTMLElement>("[data-shorten]")).filter((el) => el.dataset.shorten !== "1");
  // 卡片里的推荐项和卡片同层：跟着卡片一起收，不单独算一块。
  const nested = blocks.filter((el) => el.parentElement?.closest<HTMLElement>("[data-shorten]")?.dataset.shorten === el.dataset.shorten);
  const H: Record<Level, number> = { 1: 0, 2: 0, 3: 0 };
  let pieces: Piece[] = [];
  let p = 3;
  let raf = 0;
  let anchorTop = 0;
  let keepEnd = false;
  /** 正在弹向的层和弹簧的位置、速度：再按键、再抓住都从这里接着走。 */
  let target: Level = 3;
  let sx = 0;
  let sv = 0;
  const hold = messages ? holds.get(messages) ?? { base: 0, raf: 0 } : null;
  if (messages && hold) holds.set(messages, hold);

  /** 每次开始时量一遍：上一次回弹没停也先清掉，量的是干净的三层。 */
  const measure = () => {
    for (const pc of pieces) clearInline(pc.el);
    if (rest) rest.style.opacity = "";
    pieces = [];

    for (const lv of [1, 2, 3] as const) {
      showLevel(answer, lv);
      H[lv] = answer.getBoundingClientRect().height;
      for (const el of blocks) {
        if (Number(el.dataset.shorten) !== lv || nested.includes(el)) continue;
        const cs = getComputedStyle(el);
        const h = el.getBoundingClientRect().height;
        const mt = parseFloat(cs.marginTop), mb = parseFloat(cs.marginBottom);
        pieces.push({ el, need: lv as 2 | 3, w: h + mt + mb, a: 0, b: 0, h, mt, mb, pt: parseFloat(cs.paddingTop), pb: parseFloat(cs.paddingBottom) });
      }
      if (lv === 2 && rest) {
        // 第一段收成第一句：段落高度从整段收到只剩第一句，后半句淡出。
        const full = first.getBoundingClientRect().height;
        rest.classList.add("shorten-off");
        const short = first.getBoundingClientRect().height;
        rest.classList.remove("shorten-off");
        pieces.push({ el: first, need: 2, w: full - short, a: 0, b: 0, h: full, mt: 0, mb: 0, pt: 0, pb: 0, clip: { rest, short } });
      }
    }

    // 同一段里按文中顺序排区间：越靠下的块，往短拖时越先收。每块占多少按从下往上逐块收起时总高实际少了多少算，
    // 相邻块的外边距会折叠，按块自己的高度加边距算会越拖越偏离手指。
    for (const need of [2, 3] as const) {
      const seg = pieces.filter((pc) => pc.need === need).sort((x, y) => (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      showLevel(answer, need);
      let before = answer.getBoundingClientRect().height;
      for (const pc of [...seg].reverse()) {
        (pc.clip?.rest ?? pc.el).classList.add("shorten-off");
        const after = answer.getBoundingClientRect().height;
        pc.w = before - after;
        before = after;
      }
      const total = seg.reduce((sum, pc) => sum + pc.w, 0) || 1;
      let at = 0;
      for (const pc of seg) { pc.a = at / total; at += pc.w; pc.b = at / total; }
    }
  };

  const toP = (x: number) => (x <= H[2] ? 1 + clamp((x - H[1]) / Math.max(1, H[2] - H[1])) : 2 + clamp((x - H[2]) / Math.max(1, H[3] - H[2])));
  const toX = (q: number) => (q <= 2 ? H[1] + (q - 1) * (H[2] - H[1]) : H[2] + (q - 2) * (H[3] - H[2]));

  /** 往短拖时对话区会变矮，浏览器会把滚动位置往回夹，整页跳一下：底部临时补空白，让视口里的内容原地不动。 */
  const holdScroll = () => {
    if (!messages || !hold) return;
    const extra = Math.max(0, parseFloat(messages.style.paddingBottom || "0") - hold.base);
    const need = Math.max(0, anchorTop + messages.clientHeight - (messages.scrollHeight - extra));
    messages.style.paddingBottom = need > 0 ? `${hold.base + need}px` : "";
    messages.scrollTop = anchorTop;
    // 往长拖时回答末尾不往视口外长：开始时末尾看得见，就让新露出的内容往上推，把手留在看得见的地方。
    const over = answer.getBoundingClientRect().bottom - (messages.getBoundingClientRect().bottom - hold.base);

    if (keepEnd && over > 0) { anchorTop += over; messages.scrollTop = anchorTop; }
  };

  /** 停稳后收掉补的空白：回答平滑落回对话底部。 */
  const releaseSpace = () => {
    if (!messages || !hold) return;
    const from = Math.max(0, parseFloat(messages.style.paddingBottom || "0") - hold.base);
    const done = () => { messages.style.paddingBottom = ""; messages.style.overflowAnchor = ""; };

    if (from < 0.5 || reducedMotion()) { done(); return; }
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = clamp((now - t0) / D_LAYOUT);
      messages.style.paddingBottom = `${hold.base + from * (1 - t) ** 3}px`;
      if (t < 1) hold.raf = requestAnimationFrame(tick);
      else done();
    };
    hold.raf = requestAnimationFrame(tick);
  };

  const render = (q: number) => {
    p = q;
    const near = Math.round(q) as Level;
    for (const el of nested) el.classList.toggle("shorten-off", Number(el.dataset.shorten) > Math.ceil(q - 1e-6));

    let active: Piece | null = null;
    for (const pc of pieces) {
      const f = clamp((clamp(q - (pc.need - 1)) - pc.a) / Math.max(1e-6, pc.b - pc.a));
      // 先淡出再收高度：字在被裁掉之前已经看不见。
      const t = clamp((f - 0.3) / 0.7);
      const alpha = String(t * t * (3 - 2 * t));
      const target = pc.clip?.rest ?? pc.el;
      target.classList.toggle("shorten-off", f <= 0);
      if (f >= 1 || f <= 0) { clearInline(pc.el); if (pc.clip) pc.clip.rest.style.opacity = ""; continue; }
      pc.el.style.overflow = "hidden";

      if (pc.clip) {
        pc.el.style.height = `${pc.clip.short + (pc.h - pc.clip.short) * f}px`;
        pc.clip.rest.style.opacity = alpha;
        active = pc;
        continue;
      }
      Object.assign(pc.el.style, { height: `${pc.h * f}px`, marginTop: `${pc.mt * f}px`, marginBottom: `${pc.mb * f}px`, paddingTop: `${pc.pt * f}px`, paddingBottom: `${pc.pb * f}px`, opacity: alpha });
      active = pc;
    }
    // 外边距折叠、卡片间距让一块按比例收时总高和手指差几像素：量一次实际总高，差多少在正收的那块上补回来。
    if (active) {
      const off = answer.getBoundingClientRect().height - toX(q);
      const h = parseFloat(active.el.style.height);
      active.el.style.height = `${Math.max(0, h - off)}px`;
    }
    grip.setAttribute("aria-valuenow", String(4 - near));
    grip.setAttribute("aria-valuetext", LEVELS[near]);
    label.textContent = LEVELS[near];
    holdScroll();
  };

  const settle = (lv: Level) => {
    cancelAnimationFrame(raf);
    if (hold?.finish === finishNow) hold.finish = undefined;
    sv = 0;
    delete answer.dataset.shortening;
    render(lv);
    showLevel(answer, lv);
    commit(answer, lv);
    releaseSpace();
  };

  const finishNow = () => settle(target);

  /** 弹到某一层；初速度接住松手时手指的速度（像素 / 秒）。 */
  const springTo = (x0: number, v0: number, lv: Level) => {
    cancelAnimationFrame(raf);
    target = lv;
    commit(answer, lv);
    if (reducedMotion()) { settle(lv); return; }
    if (hold) hold.finish = finishNow;
    const k = SPRING_K, c = 2 * Math.sqrt(k), end = H[lv];
    sx = x0; sv = v0;
    let last = performance.now();
    const step = (now: number) => {
      let dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      while (dt > 0) { const h = Math.min(dt, 0.004); sv += (-k * (sx - end) - c * sv) * h; sx += sv * h; dt -= h; }
      if (Math.abs(sx - end) < 0.5 && Math.abs(sv) < 8) { settle(lv); return; }
      render(toP(sx));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const begin = () => {
    // 另一条回答还在回弹：直接停到它要去的层，免得两边抢同一个滚动位置。
    if (hold?.finish && hold.finish !== finishNow) hold.finish();
    cancelAnimationFrame(raf);
    // 拖动时每帧写透明度，回答块自带的透明度过渡会让淡出慢半拍。
    answer.dataset.shortening = "";
    if (messages && hold) {
      cancelAnimationFrame(hold.raf);
      // 补的空白还没收完时不清掉它（清掉会让滚动位置跳），基准内边距沿用上次量的。
      if (!messages.style.paddingBottom) hold.base = parseFloat(getComputedStyle(messages).paddingBottom) || 0;
      messages.style.overflowAnchor = "none";
      anchorTop = messages.scrollTop;
      keepEnd = answer.getBoundingClientRect().bottom <= messages.getBoundingClientRect().bottom - hold.base + 1;
    }
    measure();
    render(p);
  };

  let startY: number | null = null;
  let startX = 0;
  let x = 0;
  let moved = false;
  let samples: Array<[t: number, y: number]> = [];

  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // 鼠标拖不留焦点框：不让按下聚焦，键盘留下的焦点也放掉（焦点框只给键盘用）。
    e.preventDefault();
    if (document.activeElement === grip) grip.blur();
    begin();
    startY = e.clientY; startX = toX(p); x = startX; moved = false; samples = [[e.timeStamp, e.clientY]];
    sv = 0;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;

    if (Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    x = clamp(startX + dy, H[1], H[3]);
    samples.push([e.timeStamp, e.clientY]);
    samples = samples.filter(([t]) => e.timeStamp - t < 100);
    render(toP(x));
  });
  const end = (e: PointerEvent) => {
    if (startY === null) return;
    startY = null;
    grip.classList.remove("dragging");
    const from = Math.round(p) as Level;

    if (!moved) { springTo(x, 0, from === 1 ? 3 : (from - 1) as Level); return; }
    // 停住一会儿再松手是“放在这里”，速度算 0。
    const [t0, y0] = samples.find(([t]) => e.timeStamp - t < 100) ?? [e.timeStamp, e.clientY];
    const v = e.timeStamp > t0 ? ((e.clientY - y0) / (e.timeStamp - t0)) * 1000 : 0;
    const projected = x + v * PROJECT_S;
    let lv = ([1, 2, 3] as const).reduce((best, l) => (Math.abs(H[l] - projected) < Math.abs(H[best] - projected) ? l : best));
    // 回答在侧栏底部时往下拖没多少地方：朝一个方向拖够一小段，就至少换一层。
    const start = Math.round(toP(startX)) as Level;
    if (lv === start && Math.abs(x - startX) >= INTENT_PX) lv = clamp(start + Math.sign(x - startX), 1, 3) as Level;
    springTo(x, v, lv);
  };
  grip.addEventListener("pointerup", end);
  // 系统打断（窗口失焦等）不算点击：停在离当前最近的一层。
  grip.addEventListener("pointercancel", () => {
    if (startY === null) return;
    startY = null;
    grip.classList.remove("dragging");
    springTo(x, 0, Math.round(toP(x)) as Level);
  });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const running = raf !== 0 && sv !== 0;
    const from = running ? target : Math.round(p) as Level;
    const x0 = running ? sx : toX(p), v0 = running ? sv : 0;
    begin();
    // 连按时从正在弹向的那一层再走一层，速度接着用。
    springTo(running ? x0 : toX(p), v0, clamp(from + (e.key === "ArrowUp" ? -1 : 1), 1, 3) as Level);
  });
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}
