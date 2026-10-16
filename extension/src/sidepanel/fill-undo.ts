/**
 * 还原填写的侧栏一端（后台在 background/fill-undo.ts，协议见 relay.ts 的 FillUndoView）。
 * 这一轮回答下面的主动作换成「还原填写（N 处）」；点了以后在文末一排下面写结果，上面那段回答变淡。
 * 已提交、页面变了时按钮变灰，写清为什么收不回。后台只给栏名和状态，这里也只显示栏名。
 */
import type { FillUndoNote, FillUndoView } from "../relay.js";

/** 回答 → 挂在它下面的还原状态。新一轮开始时后台推 null：还能点的「还原填写」换回平常的主动作；已还原、已提交、页面变了是这条回答的状态，留着。 */
const views = new WeakMap<HTMLElement, FillUndoView>();
/** 点了还原、后台还没回话。 */
const pending = new WeakSet<HTMLElement>();
let owner: HTMLElement | null = null;
/** 这条回答的还原交给了它上面的计划卡：回答下不再出「还原填写」，结果行放在卡下面，回答照样变淡。 */
const cards = new WeakMap<HTMLElement, HTMLElement>();
let latest: FillUndoView | null = null;
let refresh: (answer: HTMLElement) => void = () => {};
let send: () => void = () => {};
let follow: () => void = () => {};

/** main.ts 给出“请后台还原”的发送方式（面板端口），和侧栏的贴底（对话停在底部时，加了行也保持在底部）。 */
export function setFillUndoHost(host: { send: () => void; follow: () => void }): void {
  send = host.send;
  follow = host.follow;
}

/** 有按钮可言的状态。ready 但 count 为 0 只是说明（例如编辑器里的文字没还原），不出按钮。 */
export function fillUndoOf(answer: HTMLElement): FillUndoView | undefined {
  const view = views.get(answer);

  return view?.state === "ready" && view.count === 0 ? undefined : view;
}

/** 回答下面的主动作要不要出还原：交给计划卡的不出。 */
export function answerFillUndoOf(answer: HTMLElement): FillUndoView | undefined {
  return cards.has(answer) ? undefined : fillUndoOf(answer);
}

/** 计划卡接管这条回答的还原：卡上的「撤销」就是还原，结果行挪到卡下面。 */
export function handFillUndoToCard(answer: HTMLElement, card: HTMLElement): void {
  if (cards.get(answer) === card) return;
  cards.set(answer, card);
  answer.querySelector(":scope > .fill-undo-result")?.remove();
  paint(answer);
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
    case "ready": return view.count === 0 && view.notes.length ? ["", notes(view.notes)] : null;
    case "submitted": return ["表单已经交给网站", "，扩展撤不回。要改请在网站上修改或取消。"];
    case "page_changed": return view.fields.length
      ? ["页面已经换了", `，${quote(view.fields)}找不到了，扩展撤不回。`]
      : ["记录没了", "：扩展重启过，不知道动手前的值，扩展撤不回。"];
    case "restored": {
      const by = (reason: string) => [...new Set(view.skipped.filter((s) => s.reason === reason).map((s) => s.field))];
      const parts = [
        by("user_changed").length ? `${quote(by("user_changed"))}你后来改过，没动。` : "",
        by("gone").length ? `${quote(by("gone"))}已经不在页面上（例如弹窗已关），跳过了。` : "",
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
  // 已还原 / 已提交 / 页面变了是这条回答的状态，文末一排一直显示，不等悬停。
  answer.classList.toggle("fill-undo-settled", !!view && view.state !== "ready");
  // 只有说明时，结果行跟着回答一直显示，不然用户不知道哪里没还原。
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
  // 这几行在回答写完、已经滚到底之后才加上：对话本来停在底部，就跟着贴底，免得落在输入框下面看不见。
  follow();
}

/**
 * 后台推来这一轮的还原状态。挂到这一轮的回答（侧栏里最新的那条）上；已经定下来的旧状态留在原来的回答上。
 * 回答还没写完时先记下，文末一排挂上时 adopt 再补。
 */
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

/** 文末一排刚挂上：后台的状态先到、回答后写完时，补到这条回答上。 */
export function adoptFillUndo(answer: HTMLElement): void {
  if (latest && answer !== owner) noteFillUndo(latest, undefined, answer);
}

/** 点了「还原填写」：按钮先灰掉写“正在还原…”，等后台回话。 */
export async function requestFillUndo(answer: HTMLElement): Promise<void> {
  if (fillUndoOf(answer)?.state !== "ready" || pending.has(answer)) return;
  pending.add(answer);
  refresh(answer);

  try {
    send();
  } catch (error) {
    // 面板端口刚断开：按钮回到可点，让用户再点一次。
    pending.delete(answer);
    refresh(answer);
    throw error;
  }
}

/** 换会话：上一个会话的状态不带过来，等后台按新会话补发。 */
export function resetFillUndo(): void {
  latest = null;
  owner = null;
}
