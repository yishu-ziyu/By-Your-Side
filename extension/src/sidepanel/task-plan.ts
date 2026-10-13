/**
 * A3：要写页面或跨站时，先给三行计划。只读任务不出这张卡。
 * 「开始」收成任务条上的目标行；「改一下」把计划放进输入框当草稿，不加动效。
 */
import { hostOf } from "./tab-mentions.js";
import { reducedMotion } from "./branch-graph.js";

export interface TaskPlanLines {
  go: string;
  do: string;
  dont: string;
}

export interface TaskPlan {
  shouldAsk: (text: string, pages: Array<{ url: string }>, currentUrl: string) => boolean;
  draft: (text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string) => TaskPlanLines;
  show: (text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string) => void;
  visible: () => boolean;
  confirm: () => void;
  handleKeydown: (event: KeyboardEvent) => boolean;
  hide: () => void;
  /** 这一轮结束：收起计划留下的那一行。 */
  endRun: () => void;
  reset: () => void;
}

const WRITE = /填|写进|写入|改成|改掉|点一?下|点击|提交|删除|输入|粘贴|勾选|下单|购买|发帖|发表|保存到|填到|填进/;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function uniqueHosts(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const host = hostOf(url);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

function siteName(url: string, title?: string): string {
  const host = hostOf(url);
  if (!host || /^(localhost|127\.|0\.0\.0\.0)/.test(host)) return clip((title ?? "").replace(/\s+/g, " "), 12) || host || "当前页";
  return host;
}

export function planLines(text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string): TaskPlanLines {
  const names: string[] = [];
  for (const item of [{ url: currentUrl, title: currentTitle ?? "" }, ...pages]) {
    const name = siteName(item.url, item.title);
    if (name && !names.includes(name)) names.push(name);
  }
  const go = names.join("、") || "当前页";
  const doLine = clip(text.replace(/[。！？.!?]+$/u, ""), 28) || "按你刚才说的做";
  return { go, do: doLine, dont: notAuthorized(text) };
}

/**
 * 「不会做」只列用户这句话没授权的动作：助手把原话里的「提交」「下单」当授权（agent/src/prompt.ts），
 * 计划卡不能一边写「不会做 提交」一边让它真去提交。
 */
function notAuthorized(text: string): string {
  const asked = text.replace(/(?:不要|别|不用|先不|无需|不)(?:点|去|帮我)?(?:提交|付款|支付|下单|购买|发帖|发表)/g, "");
  const left = [
    !/提交|发帖|发表|下单/.test(asked) && "提交",
    !/付款|支付|下单|购买|买下/.test(asked) && "付款",
  ].filter(Boolean);
  return left.length ? left.join("、") : "你没说的事";
}

export function needsTaskPlan(text: string, pages: Array<{ url: string }>, currentUrl: string): boolean {
  const hosts = uniqueHosts([currentUrl, ...pages.map((p) => p.url)]);
  return hosts.length > 1 || WRITE.test(text);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function mountTaskPlan(opts: {
  root: HTMLElement;
  inputEl: HTMLTextAreaElement;
  onStart: (text: string) => void;
}): TaskPlan {
  let card: HTMLElement | null = null;
  let goal: HTMLElement | null = null;
  let pending: string | null = null;
  let shownDraft = "";

  const hide = (): void => {
    card?.remove();
    card = null;
    pending = null;
  };

  // 计划是对出卡那一刻输入框里的话做的：用户接着改了输入，旧计划作废，下次发送按新话重新判断。
  opts.inputEl.addEventListener("input", () => {
    if (card && opts.inputEl.value !== shownDraft) hide();
  });

  const renderGoal = (lines: TaskPlanLines): HTMLElement => {
    goal?.remove();
    const row = el("div", "task-plan-goal");
    row.setAttribute("aria-label", "这次的计划");
    // 「会做」就是上面用户气泡里的原话，这一行不再说一遍。
    row.textContent = `会去 ${lines.go} · 不会做 ${lines.dont}`;
    opts.root.prepend(row);
    goal = row;
    return row;
  };

  const show = (text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string): void => {
    hide();
    const lines = planLines(text, pages, currentUrl, currentTitle);
    pending = text;
    shownDraft = opts.inputEl.value;
    const next = el("section", "task-plan");
    next.setAttribute("aria-label", "动手前的计划");
    next.append(el("p", "task-plan-kicker", "动手前看一眼范围"));
    const body = el("div", "task-plan-lines");
    const row = (k: string, v: string) => {
      const line = el("p", "task-plan-line");
      line.append(el("span", "task-plan-key", k), el("span", "task-plan-val", v));
      return line;
    };
    body.append(row("会去", lines.go), row("会做", lines.do), row("不会做", lines.dont));
    next.append(body);
    const actions = el("div", "task-plan-actions");
    const start = el("button", "task-plan-start", "开始 ↵");
    start.type = "button";
    const edit = el("button", "task-plan-edit", "改一下");
    edit.type = "button";
    actions.append(start, edit);
    next.append(actions);

    const begin = (): void => {
      const title = next.querySelector(".task-plan-kicker");
      const from = title?.getBoundingClientRect();
      const kept = pending;
      hide();
      const dest = renderGoal(lines);
      if (from && !reducedMotion()) {
        const box = dest.getBoundingClientRect();
        dest.style.transform = `translate(${from.left - box.left}px, ${from.top - box.top}px) scale(${Math.max(0.4, from.width / Math.max(1, box.width))})`;
        dest.style.opacity = "0.6";
        requestAnimationFrame(() => {
          dest.style.transform = "none";
          dest.style.opacity = "";
        });
      }
      if (kept) opts.onStart(kept);
    };

    start.addEventListener("click", begin);
    edit.addEventListener("click", () => {
      opts.inputEl.value = `会去 ${lines.go}\n会做 ${lines.do}\n不会做 ${lines.dont}`;
      opts.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      hide();
      opts.inputEl.focus({ preventScroll: true });
    });
    opts.root.prepend(next);
    card = next;
    if (!reducedMotion()) {
      next.classList.add("task-plan-in");
      window.setTimeout(() => next.classList.remove("task-plan-in"), 240);
    }
    start.focus({ preventScroll: true });
  };

  return {
    shouldAsk: needsTaskPlan,
    draft: planLines,
    show,
    visible: () => !!card,
    confirm: () => { card?.querySelector<HTMLButtonElement>(".task-plan-start")?.click(); },
    hide,
    endRun: () => { goal?.remove(); goal = null; },
    reset: () => { hide(); goal?.remove(); goal = null; },
    handleKeydown: (e) => {
      if (!card || e.isComposing) return false;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        card.querySelector<HTMLButtonElement>(".task-plan-start")?.click();
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
        opts.inputEl.focus({ preventScroll: true });
        return true;
      }
      return false;
    },
  };
}
