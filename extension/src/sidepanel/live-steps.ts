import { createElement as icon, Check, ChevronRight, Clock, X as XIcon } from "lucide";
import { createOrb, type OrbHandle } from "./orb.js";
import { spokenDuration } from "./steps.js";

/** 页面上的一步过了这么久还没回来，才在那一行给「跳过这一步」。 */
const SKIP_AFTER_MS = 10_000;

export type LiveStep = {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
  from: number;
  to?: number;
  /** 页面上的一步可以跳过；模型那一段没有东西可跳。 */
  tool: boolean;
};

/** 轮到模型的这一段：没收到思考内容是「等模型回应」，收到了是「思考」。 */
export type LiveModel = { from: number; thought: string | null };

export type LiveSteps = {
  el: HTMLElement;
  render(steps: LiveStep[], model: LiveModel | null, now: number): void;
  finish(): void;
};

type Row = { el: HTMLElement; mark: HTMLElement; open: HTMLButtonElement; label: HTMLElement; time: HTMLElement; skip: HTMLButtonElement; thought: HTMLElement };

/**
 * 进行中的步骤表：每步一行，右边是这一步的用时，正在做的那行秒数在走。
 * 卡住时用户要知道卡在哪一步：等模型、模型在想、还是页面上的某一步；能干预的按钮只挂在页面那一步上。
 * 过程块会被记录同步整段重画，所以每次都按传入的步骤重画，这里只记展开和已点跳过。
 */
export function mountLiveSteps(onSkip: () => void): LiveSteps {
  const el = document.createElement("div");
  el.className = "live-steps";
  el.hidden = true;
  const rows = new Map<string, Row>();
  const opened = new Set<string>();
  const skipped = new Set<string>();

  const make = (id: string): Row => {
    const item = document.createElement("div");
    item.className = "live-step";
    const mark = document.createElement("span");
    mark.className = "live-step-mark";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "live-step-open";
    open.setAttribute("aria-label", "展开思考内容");
    open.append(icon(ChevronRight));
    const label = document.createElement("span");
    label.className = "live-step-label";
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "live-step-skip";
    const time = document.createElement("span");
    time.className = "live-step-time";
    item.append(mark, open, label, skip, time);
    const thought = document.createElement("div");
    thought.className = "live-step-thought";
    open.onclick = () => {
      if (opened.has(id)) opened.delete(id);
      else opened.add(id);
      paintOpen(row, id);
    };
    skip.onclick = () => {
      skipped.add(id);
      skip.disabled = true;
      skip.textContent = "会跳过";
      onSkip();
    };
    const row: Row = { el: item, mark, open, label, time, skip, thought };
    return row;
  };

  const paintOpen = (row: Row, id: string) => {
    const on = opened.has(id);
    row.open.setAttribute("aria-expanded", String(on));
    row.thought.hidden = !on || !row.thought.textContent;
  };

  return {
    el,
    render(steps, model, now) {
      const list: Array<{ id: string; label: string; state: "running" | "waiting" | "done" | "failed"; from: number; to?: number; tool: boolean; thought?: string }> = steps.map(step => ({ ...step }));
      if (model) list.push({ id: `model:${model.from}`, label: model.thought === null ? "等模型回应" : "思考", state: model.thought === null ? "waiting" : "running", from: model.from, tool: false, thought: model.thought ?? undefined });
      const keep = new Set(list.map(item => item.id));
      for (const [id, row] of rows) if (!keep.has(id)) { row.el.remove(); row.thought.remove(); rows.delete(id); }
      let prev: Element | null = null;
      for (const item of list) {
        let row = rows.get(item.id);
        if (!row) { row = make(item.id); rows.set(item.id, row); }
        const at: Element | null = prev ? prev.nextElementSibling : el.firstElementChild;
        if (at !== row.el) el.insertBefore(row.el, at);
        row.el.after(row.thought);
        prev = row.thought;
        row.el.dataset.state = item.state;
        setMark(row.mark, item.state);
        if (row.label.textContent !== item.label) row.label.textContent = item.label;
        row.time.textContent = spokenDuration(item.from, item.state === "running" || item.state === "waiting" ? now : item.to ?? now) ?? "";
        // 思考内容来自模型，只当文字放；只留最后一小段，展开后看得到它还在动。
        row.thought.textContent = item.thought ? item.thought.replace(/\s+/g, " ").slice(-140) : "";
        row.open.hidden = !item.thought;
        paintOpen(row, item.id);
        const canSkip = item.tool && item.state === "running" && now - item.from >= SKIP_AFTER_MS;
        row.skip.hidden = !canSkip;
        if (canSkip && !skipped.has(item.id)) { row.skip.disabled = false; row.skip.textContent = "跳过这一步"; }
      }
      el.hidden = list.length === 0;
    },
    finish() {
      for (const row of rows.values()) setMark(row.mark, "done");
      el.remove();
    },
  };
}

const orbs = new WeakMap<HTMLElement, OrbHandle>();

/** 正在做的那一步用和工具行一样的光球，不换成转圈图标。 */
function setMark(box: HTMLElement, state: "running" | "waiting" | "done" | "failed"): void {
  if (box.dataset.state === state) return;
  orbs.get(box)?.dispose();
  orbs.delete(box);
  box.dataset.state = state;
  if (state === "running") {
    const orb = createOrb("solving", 16);
    orb.setRunning(true);
    orbs.set(box, orb);
    box.replaceChildren(orb.el);
    return;
  }
  const graphic = icon(state === "done" ? Check : state === "failed" ? XIcon : Clock);
  graphic.setAttribute("aria-hidden", "true");
  box.replaceChildren(graphic);
}
