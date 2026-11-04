import { hostOf } from "./tab-mentions.js";

interface TaskPlanLines {
  go: string;
  dont: string;
}

interface TaskPlan {
  shouldAsk: (text: string, pages: Array<{ url: string }>, currentUrl: string) => boolean;
  announce: (text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string) => void;
  adopt: (root: HTMLDetailsElement, body: HTMLElement) => boolean;
  endRun: () => void;
  reset: () => void;
}

interface PlanReceiptView {
  filled: number | null;
  steps: number;
  total: string | null;
  ended: "completed" | "failed" | "stopped";
  undo: "ready" | "pending" | "done" | "closed" | "none";
  undoLabel: string;
  undoable: string[];
  untracked: string[];
  unavailable: string[];
  onUndo: () => void;
}

const WRITE = /填|写进|写入|写成|写上|写好|改成|改为|改掉|点一?下|点击|提交|删除|输入|粘贴|勾选|选择|选成|选为|下单|购买|发帖|发表|保存(?!按钮|键|在|是)|新建(?!按钮|键|在|是)|创建(?!按钮|键|在|是)|填到|填进/;

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

export function siteName(url: string, title?: string): string {
  const host = hostOf(url);
  if (!host || /^(localhost|127\.|0\.0\.0\.0)/.test(host)) return clip((title ?? "").replace(/\s+/g, " "), 12) || host || "当前页";
  return host;
}

function planLines(text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string): TaskPlanLines {
  const names: string[] = [];
  for (const item of [{ url: currentUrl, title: currentTitle ?? "" }, ...pages]) {
    const name = siteName(item.url, item.title);
    if (name && !names.includes(name)) names.push(name);
  }
  const go = names.join("、") || "当前页";
  return { go, dont: notAuthorized(text) };
}

function notAuthorized(text: string): string {
  const asked = text
    .replace(/报名表|报名页|订单|订阅/g, "")
    .replace(/(?:不要|别|不用|不需要|先不|无需|不)(?:直接|马上|帮我|去|点击|点)*(?:提交|报名|预订|预约|订|付款|支付|下单|购买|发帖|发表|发送)/g, "");
  const left = [
    !/提交|报名|预订|预约|订|发帖|发表|发送|下单/.test(asked) && "提交",
    !/付款|支付|下单|购买|买下/.test(asked) && "付款",
  ].filter(Boolean);
  return left.length ? left.join("、") : "你没说的事";
}

function needsTaskPlan(text: string, pages: Array<{ url: string }>, currentUrl: string): boolean {
  const hosts = uniqueHosts([currentUrl, ...pages.map((p) => p.url)]);
  return hosts.length > 1 || WRITE.test(text);
}

export function mountTaskPlan(opts: { root: HTMLElement }): TaskPlan {
  let waiting: HTMLElement | null = null;
  const clear = (): void => { waiting?.remove(); waiting = null; };

  return {
    shouldAsk: needsTaskPlan,
    announce: (text, pages, currentUrl, currentTitle) => {
      clear();
      const lines = planLines(text, pages, currentUrl, currentTitle);
      const row = document.createElement("div");
      row.className = "task-plan-goal";
      row.setAttribute("aria-label", "这次的计划");
      row.textContent = `会去 ${lines.go} · 不会做 ${lines.dont}`;
      opts.root.prepend(row);
      waiting = row;
    },
    adopt: (root, body) => {
      if (!waiting) return false;
      body.prepend(waiting);
      waiting = null;
      root.classList.add("plan-card");
      root.open = true;

      return true;
    },
    endRun: clear,
    reset: clear,
  };
}

export function paintPlanReceipt(root: HTMLDetailsElement, view: PlanReceiptView): void {
  const summary = root.querySelector(":scope > summary");

  if (!summary) return;
  root.classList.add("plan-done");
  let line = summary.querySelector<HTMLElement>(".plan-receipt-line");

  if (!line) {
    line = document.createElement("span");
    line.className = "plan-receipt-line";
    summary.prepend(line);
  }

  root.classList.toggle("plan-failed", view.ended === "failed");
  root.classList.toggle("plan-stopped", view.ended === "stopped");
  const done = view.filled ? `已填 ${view.filled} 项` : `做了 ${view.steps} 步`;
  const head = view.ended === "failed" ? `没做完 · ${done}` : view.ended === "stopped" ? `已中止 · ${done}` : done;
  const parts: Array<string | HTMLElement> = [view.total ? `${head} · 用时 ${view.total}` : head];

  if (view.undo !== "none") {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "plan-undo";
    undo.textContent = view.undo === "pending" ? "正在恢复…" : view.undoLabel;
    undo.disabled = view.undo !== "ready";
    undo.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (!undo.disabled) view.onUndo();
    });
    parts.push(" · ", undo);
  }

  let scope = root.querySelector<HTMLElement>(":scope > .plan-fill-scope");
  if (!scope) {
    scope = document.createElement("div");
    scope.className = "plan-fill-scope plan-undo-scope";
    root.append(scope);
  }
  const description = document.createElement("p");
  description.textContent = "以下是本轮有记录的填写。恢复只作用于仍有效的记录，不撤回网站已保存的数据；你后来改过的值会保留。";
  const fields = document.createElement("ul");
  for (const name of view.undoable) {
    const field = document.createElement("li");
    field.textContent = name;
    fields.append(field);
  }
  const boundary = document.createElement("p");
  boundary.textContent = [
    view.untracked.length ? `${view.untracked.map(name => `「${name}」`).join("、")}没有恢复记录。` : "脚本修改、编辑器正文不在恢复范围内。",
    view.unavailable.length ? `${view.unavailable.map(name => `「${name}」`).join("、")}已提交或页面已变化，无法恢复。` : "",
  ].join("");
  scope.replaceChildren(description, fields, boundary);
  scope.hidden = view.undo === "none" && !view.untracked.length;

  if (!line.dataset.ended) root.open = view.ended !== "completed";
  line.dataset.ended = view.ended;
  const details = document.createElement("span");
  details.className = "plan-details";
  parts.push(" · ", details);
  line.replaceChildren(...parts);
}
