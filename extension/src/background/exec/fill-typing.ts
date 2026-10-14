/**
 * 填写像真人敲键盘（docs/evals/20261014-fill-typing.md）：先清空，再用 CDP Input.insertText 写进去，写完读回分级。
 * 原生 setter 加脚本派发的事件不算可信输入：只认可信 input 事件的搜索框、只按 beforeinput 更新的编辑器都收不到（10-14 复现）。
 * 做法参考 Ego lite 的 fill（MIT，github.com/citrolabs/ego-lite，package/ego-browser/src/driver/page-actions.ts）：
 * insertText 写入、清空用全选覆盖、空值发 Delete、连续两次读到一样才算数、五级结果、没写进去先点一下再试。
 * 日期、时间、颜色、滑块和下拉框不走这里（键盘写不进去），照旧直接设值。
 */
import { sendCommand } from "../debugger.js";

/** 读回分级：一字不差、等价（只差空白或大小写）、网站改了格式、接在原内容后面、没变。 */
export type TypingGrade = "exact" | "equivalent" | "transformed" | "appended" | "unchanged";

/** 在页面里执行：this 是元素（按节点调用）或按 target 找（domops）。 */
export type PageRun = <T>(fn: (this: unknown, target: string | null, ...args: never[]) => T, args: unknown[]) => Promise<T | undefined>;

type Guard = (() => Promise<void>) & { checkNow?: () => void; noteEffect?: () => void };

/** 读回最多读几次、隔多久：网站常在 input 事件之后的下一拍才改值。 */
const READS = 5;
const READ_GAP_MS = 50;

/** 键盘能写的框：聚焦、全选，返回原内容的长度；其余（日期、颜色、下拉框、不可写）返回 null，走旧写法。自包含。 */
function prepareInPage(this: unknown, target: string | null): { beforeLen: number } | null {
  const el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;

  if (!el) return null;
  const tag = el.tagName.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    // SAFETY: tag 已核对是 input 或 textarea。
    const field = el as HTMLInputElement;
    // 数字框照旧直接设值：旧写法会读回 min、max、step 并报越界。
    const typed = ["", "text", "search", "email", "url", "tel", "password"];

    if ((tag === "input" && !typed.includes(field.type)) || field.readOnly || field.disabled) return null;
    field.focus();

    try { field.select(); } catch { field.ownerDocument.execCommand("selectAll"); }

    return { beforeLen: field.value.length };
  }

  if (!(el as HTMLElement).isContentEditable) return null;
  let host = el as HTMLElement;

  while (host.parentElement?.isContentEditable) host = host.parentElement;
  host.focus();
  const range = host.ownerDocument.createRange();
  range.selectNodeContents(host);
  const selection = host.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  return { beforeLen: host.innerText.replace(/\n$/, "").length };
}

/** 写完读一次，只交回分级、不交回值（密码这类栏的值不出页面）。自包含。 */
function gradeInPage(this: unknown, target: string | null, requested: string, beforeLen: number): TypingGrade | null {
  let el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;

  if (!el) return null;
  const tag = el.tagName.toLowerCase();

  if (tag !== "input" && tag !== "textarea") while (el.parentElement?.isContentEditable) el = el.parentElement;
  // SAFETY: 上面按 tag 分开：输入框读 value，编辑器读 innerText。
  const now = tag === "input" || tag === "textarea" ? (el as HTMLInputElement).value : (el as HTMLElement).innerText.replace(/\n$/, "");
  const loose = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

  if (now === requested) return "exact";

  if (loose(now) === loose(requested)) return "equivalent";

  if (requested && now.endsWith(requested) && now.length > requested.length) return "appended";

  if (now.length === beforeLen && (requested ? !now.includes(requested) : beforeLen > 0)) return "unchanged";

  return "transformed";
}

/** 点一下这个框的落点：落点上确实是它（或它里面）才给，不然不点，免得点到别的控件。只在顶层页面里给。自包含。 */
function clickPointInPage(this: unknown, target: string | null): [number, number] | null {
  const el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;

  if (!el || window !== window.top) return null;
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2, y = box.top + box.height / 2;
  const hit = document.elementFromPoint(x, y);

  return hit && (hit === el || el.contains(hit)) ? [Math.round(x), Math.round(y)] : null;
}

async function grade(run: PageRun, value: string, beforeLen: number): Promise<TypingGrade | null> {
  let last: TypingGrade | null | undefined;

  for (let i = 0; i < READS; i++) {
    await new Promise(resolve => setTimeout(resolve, READ_GAP_MS));
    const now = await run(gradeInPage, [value, beforeLen]).catch(() => null) ?? null;

    if (now !== null && now === last) return now;
    last = now;
  }

  return last ?? null;
}

const written = (g: TypingGrade | null) => g === "exact" || g === "equivalent" || g === "transformed";

async function typeOnce(tabId: number, run: PageRun, value: string, guard?: Guard): Promise<TypingGrade | null | "skip"> {
  const prepared = await run(prepareInPage, []);

  if (!prepared) return "skip";
  await guard?.();

  // 全选之后：有字就用 insertText 覆盖，空值按一次 Delete 删掉选中的内容。
  if (value) await sendCommand(tabId, "Input.insertText", { text: value }, guard);
  else {
    await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, guard);
    await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, guard);
  }
  guard?.noteEffect?.();

  return await grade(run, value, prepared.beforeLen);
}

/**
 * 用真实键盘输入写一个框。返回：
 * - "skip"：这类框键盘写不进（日期、下拉框……），调用方走旧写法；
 * - { grade }：写进去了；
 * - { grade, fallback }：两次键盘输入都没写进去，调用方用旧写法再写一次，再用 regrade 判结果。
 */
export async function typeIntoField(tabId: number, run: PageRun, value: string, guard?: Guard): Promise<"skip" | { grade: TypingGrade | null; fallback?: true }> {
  const first = await typeOnce(tabId, run, value, guard);

  if (first === "skip") return "skip";

  if (written(first)) return { grade: first };
  // 没写进去（接在后面了、没变）：先点一下这个框，再写一次。
  const point = await run(clickPointInPage, []).catch(() => null);

  if (point) {
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type, x: point[0], y: point[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, guard);
    }
    const second = await typeOnce(tabId, run, value, guard);

    if (second !== "skip" && written(second)) return { grade: second };
  }

  return { grade: first, fallback: true };
}

/** 旧写法写完以后再判一次。 */
export async function regrade(run: PageRun, value: string): Promise<TypingGrade | null> {
  return await grade(run, value, -1);
}

export { written as typingWritten };

/** 「填完回车」只给搜索框和普通单行框；回车可能就是“发送”的框不给（docs/web-actions.md 的已知缺口不能扩大）。自包含。 */
export function submitRefusalInPage(this: unknown, target: string | null): string | null {
  const el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;

  if (!el) return "找不到这个框，没有回车。";
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  // SAFETY: 只在 tag 是 input 时读 type。
  const type = el.tagName === "INPUT" ? (el as HTMLInputElement).type : "";

  if (!(type === "search" || type === "text" || role === "searchbox" || role === "combobox") || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable) {
    return "只有搜索框和单行文字框能「填完回车」；多行框和编辑器里回车常常就是发送，已填好，没有回车。要回车请单独按键。";
  }
  const name = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id, el.getAttribute("title")].join(" ");

  if (/消息|留言|回复|评论|聊天|message|reply|comment|chat/i.test(name)) return "这个框像是发消息的，回车可能直接发出去：已填好，没有回车。要发送请点「发送」，会先问用户。";
  // 和这个框同在一个表单、或同在离它最近的那个带按钮的小容器里（往上最多三层，不到 body）：整页的按钮不算“旁边”。
  let box: Element | null = el.closest("form");

  for (let up = el.parentElement, n = 0; !box && up && up !== el.ownerDocument.body && n < 3; up = up.parentElement, n++) if (up.querySelector("button,[role=button],input[type=submit]")) box = up;
  const buttons = box ? [...box.querySelectorAll("button,[role=button],input[type=submit],input[type=button]")] : [];
  const label = (b: Element) => (b.getAttribute("aria-label") || (b as HTMLInputElement).value || b.textContent || b.getAttribute("title") || "").trim().replace(/\s+/g, " ");

  if (buttons.some(b => label(b).startsWith("发送") || /^send(\s|$)/i.test(label(b)))) return "这个框旁边有「发送」，回车可能直接发出去：已填好，没有回车。要发送请点「发送」，会先问用户。";

  return null;
}
