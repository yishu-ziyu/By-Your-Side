/**
 * A3：要写页面或跨站时，放一行计划「会去 … · 不会做 …」，任务照常马上开始。
 * 这一行是这一轮过程卡的头：步骤在同一张卡里打勾，做完整张卡收成一行回执（对标 ChatGPT Atlas 的「用时 N 分钟」，
 * 同一张卡变形换内容取自 anish's lab 的 Morfe card）。侧栏不再叠着计划、过程、回执几块。
 * 不停下来等「开始」（10-13 用户定）：快、少等优先；要拦就点停止。付款和发消息前助手仍会先停下问。
 * 「会做」就是用户气泡里的原话，这一行不再说一遍。
 */
import { hostOf } from "./tab-mentions.js";

export interface TaskPlanLines {
  go: string;
  dont: string;
}

export interface TaskPlan {
  shouldAsk: (text: string, pages: Array<{ url: string }>, currentUrl: string) => boolean;
  /** 任务已经发出：放上这次的计划行，等这一轮的过程卡建好挪进去。 */
  announce: (text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string) => void;
  /** 这一轮的过程卡建好了：有计划就放在卡头，卡展开，步骤在卡里打勾。返回这张卡是不是计划卡。 */
  adopt: (root: HTMLDetailsElement, body: HTMLElement) => boolean;
  /** 这一轮结束：还没挪进卡的计划行收掉。 */
  endRun: () => void;
  reset: () => void;
}

/** 卡收成回执那一行要的材料。filled：这一轮填了几栏（还原填写的账本给的数）；没填过就写做了几步。 */
export interface PlanReceiptView {
  filled: number | null;
  steps: number;
  total: string | null;
  /** completed：收成一行；failed / stopped：卡保持展开，每一步都看得见，没做成和停在哪一步有记号。 */
  ended: "completed" | "failed" | "stopped";
  /** ready：可撤销；done：已撤销；closed：收不回（已提交、页面变了）；none：这一轮没有能撤销的。 */
  undo: "ready" | "pending" | "done" | "closed" | "none";
  /** 撤销能还原的栏，和这一轮写过但撤不回的栏（编辑器正文等）：照直写在回执上，免得「撤销」像是全都收回。 */
  undoable: string[];
  untracked: string[];
  onUndo: () => void;
}

// 「写好」「选择」「新建」「保存」也是要动页面（页面变化验收那句「…正文写好…新建一条笔记…保存」原来一条都没认出，整轮没有回执卡）；
// 「保存按钮在哪」「新建键是哪个」是问路，不算。
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

/** 网站在界面上的名字：一般写主机名；本机地址写页面标题。 */
export function siteName(url: string, title?: string): string {
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
  return { go, dont: notAuthorized(text) };
}

/**
 * 「不会做」只列用户这句话没授权的动作：助手把原话里的「提交」「下单」当授权（agent/src/prompt.ts），
 * 计划行不能一边写「不会做 提交」一边让它真去提交。
 */
function notAuthorized(text: string): string {
  // 先去掉名词（「报名表」「订单」不是要提交），再去掉否定说法（「不要直接提交」不是授权）。
  const asked = text
    .replace(/报名表|报名页|订单|订阅/g, "")
    .replace(/(?:不要|别|不用|不需要|先不|无需|不)(?:直接|马上|帮我|去|点击|点)*(?:提交|报名|预订|预约|订|付款|支付|下单|购买|发帖|发表|发送)/g, "");
  const left = [
    !/提交|报名|预订|预约|订|发帖|发表|发送|下单/.test(asked) && "提交",
    !/付款|支付|下单|购买|买下/.test(asked) && "付款",
  ].filter(Boolean);
  return left.length ? left.join("、") : "你没说的事";
}

export function needsTaskPlan(text: string, pages: Array<{ url: string }>, currentUrl: string): boolean {
  const hosts = uniqueHosts([currentUrl, ...pages.map((p) => p.url)]);
  return hosts.length > 1 || WRITE.test(text);
}

export function mountTaskPlan(opts: { root: HTMLElement }): TaskPlan {
  // 发出到这一轮的过程卡建好之前，计划行先放在任务条上；卡一建好就挪进卡头。
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

/**
 * 做完：同一张卡收成一行「已填 3 项 · 用时 42 秒 · 撤销 · 细节 ›」。细节就是这张卡原来的过程行，点 summary 展开。
 * 没做完或中止：同样的一行写「没做完 · …」「已中止 · …」，卡保持展开，每一步和没做成的那一步都看得见。
 * 再次调用只换字（还原填写的状态晚到、撤销以后），不重建。
 */
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
    undo.textContent = { ready: "撤销", pending: "正在撤销…", done: "已撤销", closed: "收不回" }[view.undo];
    undo.disabled = view.undo !== "ready";
    // 撤销在 summary 里：点它不能顺带展开或收起细节。
    undo.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (!undo.disabled) view.onUndo();
    });
    parts.push(" · ", undo);
  }

  const quote = (fields: string[]) => fields.map((f) => `「${f}」`).join("");
  const scope = [
    view.undo === "ready" && view.undoable.length ? `可撤销${quote(view.undoable)}` : "",
    view.untracked.length ? `${quote(view.untracked)}撤销不了` : "",
  ].filter(Boolean).join("，");

  if (scope) {
    const note = document.createElement("span");
    note.className = "plan-undo-scope";
    note.textContent = scope;
    parts.push(" · ", note);
  }

  // 没做完、停下时卡保持展开，用户一眼看到停在哪一步；第一次画时定一次，之后由用户自己开合。
  if (!line.dataset.ended) root.open = view.ended !== "completed";
  line.dataset.ended = view.ended;
  const details = document.createElement("span");
  details.className = "plan-details";
  parts.push(" · ", details);
  line.replaceChildren(...parts);
}
