import { hostOf } from "./tab-mentions.js";

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

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function siteName(url: string, title?: string): string {
  const host = hostOf(url);
  if (!host || /^(localhost|127\.|0\.0\.0\.0)/.test(host)) return clip((title ?? "").replace(/\s+/g, " "), 12) || host || "当前页";
  return host;
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
