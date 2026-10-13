/**
 * 还原填写的侧栏一端（后台在 background/fill-undo.ts，协议见 relay.ts 的 FillUndoView）。
 * 这一轮回答下面的主动作换成「还原填写（N 处）」；点了以后在文末一排下面写结果，上面那段回答变淡。
 * 已提交、页面变了时按钮变灰，写清为什么收不回。后台只给栏名和状态，这里也只显示栏名。
 */
import type { FillUndoNote, FillUndoView } from "../relay.js";

/** 回答 → 挂在它下面的还原状态。新一轮开始时后台推 null，没还原过的回答换回平常的主动作。 */
const views = new WeakMap<HTMLElement, FillUndoView>();
/** 点了还原、后台还没回话。 */
const pending = new WeakSet<HTMLElement>();
let owner: HTMLElement | null = null;
let latest: FillUndoView | null = null;
let refresh: (answer: HTMLElement) => void = () => {};
let send: () => void = () => {};

/** main.ts 给出“请后台还原”的发送方式（面板端口）。 */
export function setFillUndoSender(fn: () => void): void {
  send = fn;
}

export function fillUndoOf(answer: HTMLElement): FillUndoView | undefined {
  return views.get(answer);
}

export function isFillUndoPending(answer: HTMLElement): boolean {
  return pending.has(answer);
}

/** answer-actions 换主按钮的入口；在这里注入，免得两边互相导入。 */
export function onFillUndoChange(fn: (answer: HTMLElement) => void): void {
  refresh = fn;
}

const quote = (fields: string[]) => fields.map((f) => `「${f}」`).join("");
const NOTE_TEXT: Record<FillUndoNote, string> = { rich_text: "编辑器里的文字没还原。", sensitive: "密码这类栏没还原。" };
const notes = (list: FillUndoNote[]) => list.map((n) => NOTE_TEXT[n]).join("");

/** 灰掉的主按钮上写什么。 */
export function fillUndoLabel(view: FillUndoView): string {
  switch (view.state) {
    case "ready": return `还原填写（${view.count} 处）`;
    case "submitted": return "已提交，收不回";
    case "page_changed": return "页面变了，收不回";
    case "restored": return "已还原";
  }
}

/** 文末一排下面那一行；ready 时没有。第一个元素加粗。 */
function resultLine(view: FillUndoView): [string, string] | null {
  switch (view.state) {
    case "ready": return null;
    case "submitted": return ["表单已经交给网站", "，扩展撤不回。要改请在网站上修改或取消。"];
    case "page_changed": return view.fields.length
      ? ["页面已经换了", `，${quote(view.fields)}找不到了，扩展撤不回。`]
      : ["记录没了", "：扩展重启过，不知道动手前的值，扩展撤不回。"];
    case "restored": {
      const by = (reason: string) => view.skipped.filter((s) => s.reason === reason).map((s) => s.field);
      const parts = [
        by("user_changed").length ? `${quote(by("user_changed"))}你后来改过，没动。` : "",
        by("gone").length ? `${quote(by("gone"))}已经不在页面上。` : "",
        by("failed").length ? `${quote(by("failed"))}网页没让改回去。` : "",
        notes(view.notes),
      ].join("");

      return [`还原了 ${view.restored.length} 处`, parts ? `。${parts}` : "，回到助手动手之前。"];
    }
  }
}

function paint(answer: HTMLElement, busy = false): void {
  const view = views.get(answer);
  answer.classList.toggle("fill-undone", view?.state === "restored");
  let line = answer.querySelector<HTMLElement>(":scope > .fill-undo-result");
  const text = busy ? ["助手还在做事", "，做完后再点还原。"] as [string, string] : view ? resultLine(view) : null;

  if (!text) { line?.remove(); refresh(answer);

 return; }

  if (!line) {
    line = document.createElement("div");
    line.className = "fill-undo-result";
    line.setAttribute("role", "status");
    (answer.querySelector(":scope > .answer-actions") ?? answer.lastElementChild)?.after(line);
  }
  const strong = document.createElement("b");
  strong.textContent = text[0];
  line.replaceChildren(strong, text[1]);
  refresh(answer);
}

/**
 * 后台推来这一轮的还原状态。挂到这一轮的回答（侧栏里最新的那条）上；还原过的回答保留“已还原”和变淡。
 * 回答还没写完时先记下，文末一排挂上时 adopt 再补。
 */
export function noteFillUndo(view: FillUndoView | null, refused: "busy" | undefined, answer: HTMLElement | null): void {
  latest = view;

  if (owner && owner !== answer && views.get(owner)?.state !== "restored") {
    const old = owner;
    views.delete(old);
    paint(old);
  }

  if (!answer) return;
  pending.delete(answer);

  if (!view) {
    if (views.get(answer)?.state !== "restored") { views.delete(answer); paint(answer); }
    owner = null;

    return;
  }
  owner = answer;
  views.set(answer, view);
  paint(answer, refused === "busy");
}

/** 文末一排刚挂上：后台的状态先到、回答后写完时，补到这条回答上。 */
export function adoptFillUndo(answer: HTMLElement): void {
  if (latest && answer !== owner) noteFillUndo(latest, undefined, answer);
}

/** 点了「还原填写」：按钮先灰掉写“正在还原…”，等后台回话。 */
export async function requestFillUndo(answer: HTMLElement): Promise<void> {
  if (views.get(answer)?.state !== "ready" || pending.has(answer)) return;
  pending.add(answer);
  refresh(answer);
  send();
}

/** 换会话：上一个会话的状态不带过来，等后台按新会话补发。 */
export function resetFillUndo(): void {
  latest = null;
  owner = null;
}
