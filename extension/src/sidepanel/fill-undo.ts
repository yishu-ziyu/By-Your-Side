import type { FillUndoNote, FillUndoView } from "../relay.js";

const views = new WeakMap<HTMLElement, FillUndoView>();
const pending = new WeakSet<HTMLElement>();
let owner: HTMLElement | null = null;
const cards = new WeakMap<HTMLElement, HTMLElement>();
let latest: FillUndoView | null = null;
let refresh: (answer: HTMLElement) => void = () => {};
let send: () => void = () => {};
let follow: () => void = () => {};

export function setFillUndoHost(host: { send: () => void; follow: () => void }): void {
  send = host.send;
  follow = host.follow;
}

export function fillUndoOf(answer: HTMLElement): FillUndoView | undefined {
  return views.get(answer);
}

export function answerFillUndoOf(answer: HTMLElement): FillUndoView | undefined {
  const view = fillUndoOf(answer);
  return cards.has(answer) || (view?.state === "ready" && view.count === 0) ? undefined : view;
}

export function handFillUndoToCard(answer: HTMLElement, card: HTMLElement): void {
  if (cards.get(answer) === card) return;
  cards.set(answer, card);
  answer.querySelector(":scope > .fill-undo-result")?.remove();
  paint(answer);
}

export function isFillUndoPending(answer: HTMLElement): boolean {
  return pending.has(answer);
}

export function onFillUndoChange(fn: (answer: HTMLElement) => void): void {
  refresh = fn;
}

const quote = (fields: string[]) => fields.map((f) => `「${f}」`).join("");
const NOTE_TEXT: Record<FillUndoNote, string> = { rich_text: "编辑器里的文字没还原。", sensitive: "密码这类栏没还原。" };
const notes = (list: FillUndoNote[]) => list.map((n) => NOTE_TEXT[n]).join("");
const BEFORE_TEXT: Record<FillUndoNote, string> = { rich_text: "编辑器里填的字不能一键还原。", sensitive: "密码这类栏不能一键还原。" };

export function fillUndoLabel(view: FillUndoView): string {
  switch (view.state) {
    case "ready": return `恢复这 ${view.count} 处填写`;
    case "submitted": return "网站已收到，无法恢复";
    case "page_changed": return "恢复记录已失效";
    case "restored": return `已恢复 ${view.restored.length} 处`;
  }
}

function resultLine(view: FillUndoView): [string, string] | null {
  switch (view.state) {
    case "ready": return view.count === 0 && view.notes.length ? ["", view.notes.map((n) => BEFORE_TEXT[n]).join("")] : null;
    case "submitted": return ["表单已经交给网站", "，扩展撤不回。要改请在网站上修改或取消。"];
    case "page_changed": return view.fields.length
      ? ["页面已经换了", `，${quote(view.fields)}找不到了，扩展撤不回。`]
      : ["记录没了", "：扩展重启过，不知道动手前的值，扩展撤不回。"];
    case "restored": {
      const by = (reason: string) => view.skipped.filter((s) => s.reason === reason).map((s) => s.field);
      const parts = [
        by("user_changed").length ? `${quote(by("user_changed"))}你后来改过，没动。` : "",
        by("gone").length ? `${quote(by("gone"))}已经不在页面上（比如弹窗关了），${by("gone").length > 1 ? "这几处" : "这一处"}没法还原。如果它已经保存，请到网站里手动改回。` : "",
        by("failed").length ? `${quote(by("failed"))}网页没让改回去。` : "",
        notes(view.notes),
        view.unavailable?.length ? `${quote(view.unavailable)}已提交或页面已变化，无法恢复。` : "",
      ].join("");

      return [`还原了 ${view.restored.length} 处`, parts ? `。${parts}` : "，回到助手动手之前。"];
    }
  }
}

function paint(answer: HTMLElement, busy = false): void {
  const view = views.get(answer);
  answer.classList.toggle("fill-undone", view?.state === "restored");
  answer.classList.toggle("fill-undo-settled", !!view && view.state !== "ready");
  const card = cards.get(answer);
  let line = card ? (card.nextElementSibling?.matches(".fill-undo-result") ? card.nextElementSibling as HTMLElement : null) : answer.querySelector<HTMLElement>(":scope > .fill-undo-result");
  const text = busy ? ["助手还在做事", "，做完后再点还原。"] as [string, string] : view ? resultLine(view) : null;

  if (!text) { line?.remove(); refresh(answer);

 return; }

  if (!line) {
    line = document.createElement("div");
    line.className = "fill-undo-result";
    line.setAttribute("role", "status");
    if (card) {
      line.classList.add("plan-undo-result");
      card.after(line);
    } else (answer.querySelector(":scope > .answer-actions") ?? answer.lastElementChild)?.after(line);
  }
  const strong = document.createElement("b");
  strong.textContent = text[0];
  line.replaceChildren(...(text[0] ? [strong] : []), text[1]);
  refresh(answer);
  follow();
}

export function noteFillUndo(view: FillUndoView | null, refused: "busy" | undefined, answer: HTMLElement | null): void {
  latest = view;

  if (owner && owner !== answer && views.get(owner)?.state === "ready") {
    const old = owner;
    views.delete(old);
    paint(old);
  }

  if (!answer) return;
  pending.delete(answer);

  if (!view) {
    if (views.get(answer)?.state === "ready") { views.delete(answer); paint(answer); }
    owner = null;

    return;
  }
  owner = answer;
  views.set(answer, view);
  paint(answer, refused === "busy");
}

export function adoptFillUndo(answer: HTMLElement): void {
  if (latest && answer !== owner) noteFillUndo(latest, undefined, answer);
}

export async function requestFillUndo(answer: HTMLElement): Promise<void> {
  const view = fillUndoOf(answer);
  if (view?.state !== "ready" || view.count === 0 || pending.has(answer)) return;
  pending.add(answer);
  refresh(answer);

  try {
    send();
  } catch (error) {
    pending.delete(answer);
    refresh(answer);
    throw error;
  }
}

export function resetFillUndo(): void {
  latest = null;
  owner = null;
}
