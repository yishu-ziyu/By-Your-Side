import { sendCommand } from "../debugger.js";

export class TypingInterrupted extends Error {}

type TypingGrade = "exact" | "equivalent" | "transformed" | "appended" | "unchanged";

export type PageRun = <T>(fn: (this: unknown, target: string | null, ...args: never[]) => T, args: unknown[]) => Promise<T | undefined>;

type Guard = (() => Promise<void>) & { checkNow?: () => void; noteEffect?: () => void };

const READS = 5;
const READ_GAP_MS = 50;

function prepareInPage(this: unknown, target: string | null, requested?: string): { beforeLen: number; beforeHash: number; sameRequest?: boolean; editor?: true } | null {
  const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
  if (!(this instanceof Element) && target && /^(text=|loc=role:)/.test(target)) return null;
  const el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;

  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const prevReq = el.getAttribute("data-bys-last-requested");
  if (typeof requested === "string") el.setAttribute("data-bys-last-requested", requested);
  const sameRequest = typeof requested === "string" && prevReq === requested;
  const holdsFocus = (node: Element) => {
    let active = node.ownerDocument.activeElement;

    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;

    return active === node || (node.getRootNode() as Document | ShadowRoot).activeElement === node;
  };

  if (tag === "input" || tag === "textarea") {
    const field = el as HTMLInputElement;
    const typed = ["", "text", "search", "email", "url", "tel", "password"];

    if ((tag === "input" && !typed.includes(field.type)) || field.readOnly || field.matches(":disabled")) return null;
    field.focus();

    if (!holdsFocus(field)) return null;

    try { field.select(); } catch { field.ownerDocument.execCommand("selectAll"); }

    return { beforeLen: field.value.length, beforeHash: hash(field.value), sameRequest };
  }

  if (!(el as HTMLElement).isContentEditable) return null;
  let host = el as HTMLElement;

  while (host.parentElement?.isContentEditable) host = host.parentElement;
  host.focus();

  if (!holdsFocus(host)) return null;
  const scope = (el as HTMLElement).isConnected ? (el as HTMLElement) : host;
  const range = host.ownerDocument.createRange();
  range.selectNodeContents(scope);
  const selection = host.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  const before = scope.innerText.replace(/\n$/, "");

  return { beforeLen: before.length, beforeHash: hash(before), sameRequest, editor: true };
}

function gradeInPage(this: unknown, target: string | null, requested: string, beforeLen: number, beforeHash: number, sameRequest?: boolean): TypingGrade | null {
  const hash = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
  let el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;

  if (!el) return null;
  const tag = el.tagName.toLowerCase();

  if (tag !== "input" && tag !== "textarea" && !el.isConnected) while (el.parentElement?.isContentEditable) el = el.parentElement;
  const now = tag === "input" || tag === "textarea" ? (el as HTMLInputElement).value : (el as HTMLElement).innerText.replace(/\n$/, "");
  const loose = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

  if (now === requested) return "exact";

  if (loose(now) === loose(requested)) return "equivalent";

  if (requested && now.endsWith(requested) && now.length > requested.length) return "appended";

  if (sameRequest && requested && now.replace(/\s+/g, "").toLowerCase() === requested.replace(/\s+/g, "").toLowerCase()) return "transformed";

  if (beforeLen >= 0 && now.length === beforeLen && hash(now) === beforeHash) return "unchanged";

  return "transformed";
}

function clickPointInPage(this: unknown, target: string | null): [number, number] | null {
  const el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;

  if (!el || window !== window.top) return null;
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2, y = box.top + box.height / 2;
  const hit = document.elementFromPoint(x, y);

  return hit && (hit === el || el.contains(hit)) ? [Math.round(x), Math.round(y)] : null;
}

async function grade(run: PageRun, value: string, beforeLen: number, beforeHash: number, sameRequest?: boolean): Promise<TypingGrade | null> {
  let last: TypingGrade | null | undefined;

  for (let i = 0; i < READS; i++) {
    await new Promise(resolve => setTimeout(resolve, READ_GAP_MS));
    const now = await run(gradeInPage, [value, beforeLen, beforeHash, sameRequest]).catch(() => null) ?? null;

    if (now !== null && now === last) return now;
    last = now;
  }

  return last ?? null;
}

const written = (g: TypingGrade | null) => g === "exact" || g === "equivalent" || g === "transformed";

function editorStillSelected(this: unknown, target: string | null): boolean {
  let el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;
  if (!el || !(el as HTMLElement).isContentEditable) return false;
  while (el.parentElement?.isContentEditable) el = el.parentElement;
  let active = el.ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const selection = el.ownerDocument.getSelection();
  if (active !== el || !selection?.rangeCount) return false;
  const shadowRoots: ShadowRoot[] = [];
  let root = el.getRootNode();
  while (root instanceof ShadowRoot) { shadowRoots.push(root); root = root.host.getRootNode(); }
  const range = selection.getComposedRanges?.({ shadowRoots })[0] ?? selection.getRangeAt(0);
  return !!range && el.contains(range.startContainer) && el.contains(range.endContainer);
}

function repairParagraphsInPage(this: unknown, target: string | null, value: string): 'inserted' | 'focus_changed' | 'unsupported' {
  let el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;
  if (!el || !(el as HTMLElement).isContentEditable) return 'focus_changed';
  let host = el as HTMLElement;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  const scope = el.isConnected ? (el as HTMLElement) : host;
  const document = host.ownerDocument;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const selection = document.getSelection();
  if (active !== host || !selection || !host.isConnected) return 'focus_changed';
  const content = document.createElement('div');
  for (const paragraph of value.split('\n\n')) {
    const p = document.createElement('p');
    paragraph.split('\n').forEach((line, index) => {
      if (index) p.append(document.createElement('br'));
      p.append(document.createTextNode(line));
    });
    content.append(p);
  }
  const range = document.createRange();
  range.selectNodeContents(scope);
  selection.removeAllRanges();
  selection.addRange(range);
  if (document.execCommand('insertHTML', false, content.innerHTML)) return 'inserted';
  if (typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
    const before = (scope.innerText ?? '').replace(/\n$/, '');
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    dt.setData('text/html', content.innerHTML);
    const pasteEvt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    scope.dispatchEvent(pasteEvt);
    if (pasteEvt.defaultPrevented || (scope.innerText ?? '').replace(/\n$/, '') !== before) return 'inserted';
    const beforeEvt = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', dataTransfer: dt });
    scope.dispatchEvent(beforeEvt);
    if (beforeEvt.defaultPrevented || (scope.innerText ?? '').replace(/\n$/, '') !== before) return 'inserted';
  }
  return 'unsupported';
}

async function typeOnce(tabId: number, run: PageRun, value: string, guard?: Guard): Promise<{ grade: TypingGrade | null; beforeLen: number; beforeHash: number; editor?: true } | "skip"> {
  const prepared = await run(prepareInPage, [value]);

  if (!prepared) return "skip";
  await guard?.();

  if (value) await sendCommand(tabId, "Input.insertText", { text: value }, guard);
  else {
    await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, guard);
    await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, guard);
  }
  guard?.noteEffect?.();

  return { grade: await grade(run, value, prepared.beforeLen, prepared.beforeHash, prepared.sameRequest), beforeLen: prepared.beforeLen, beforeHash: prepared.beforeHash, editor: prepared.editor };
}

export async function typeIntoField(tabId: number, run: PageRun, value: string, guard?: Guard): Promise<"skip" | { grade: TypingGrade | null; fallback?: { beforeLen: number; beforeHash: number } }> {
  const first = await typeOnce(tabId, run, value, guard);

  if (first === "skip") return "skip";

  if (first.editor && value.includes('\n') && first.grade === 'equivalent') {
    if (!await run(editorStillSelected, [])) throw new TypingInterrupted('填写期间焦点或选区已改变，已停止；请读取当前内容。');
    await guard?.();
    const repaired = await run(repairParagraphsInPage, [value]);
    if (repaired === 'focus_changed') throw new TypingInterrupted('填写期间焦点或选区已改变，已停止；请读取当前内容。');
    if (repaired === 'inserted') {
      guard?.noteEffect?.();
      const repairedGrade = await grade(run, value, first.beforeLen, first.beforeHash);
      if (!written(repairedGrade)) throw new TypingInterrupted('段落修正后正文未保持完整，已停止；请读取当前内容。');
      return { grade: repairedGrade };
    }
  }
  if (written(first.grade)) return { grade: first.grade };
  const point = await run(clickPointInPage, []).catch(() => null);

  if (point) {
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type, x: point[0], y: point[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, guard);
    }
    const second = await typeOnce(tabId, run, value, guard);

    if (second !== "skip" && written(second.grade)) return { grade: second.grade };
  }

  return { grade: first.grade, fallback: { beforeLen: first.beforeLen, beforeHash: first.beforeHash } };
}

export async function regrade(run: PageRun, value: string, before: { beforeLen: number; beforeHash: number }): Promise<TypingGrade | null> {
  return await grade(run, value, before.beforeLen, before.beforeHash);
}

export { written as typingWritten };

export function submitProbeInPage(this: unknown, target: string | null): { refused: string } | { labels: string[] } {
  const el = this instanceof Element ? this : target ? window.__sideagent?.dom?.resolve(target) : null;

  if (!el) return { refused: "找不到这个框，没有回车。" };
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  const type = el.tagName === "INPUT" ? (el as HTMLInputElement).type : "";

  if (!(type === "search" || type === "text" || role === "searchbox" || role === "combobox") || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable) {
    return { refused: "只有搜索框和单行文字框能「填完回车」；多行框和编辑器里回车常常就是发送，已填好，没有回车。要回车请单独按键。" };
  }
  let active = el.ownerDocument.activeElement;

  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;

  if (active !== el) return { refused: "焦点已经不在这个框上，回车会落到别处：已填好，没有回车。" };
  const by = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map(id => el.ownerDocument.getElementById(id)?.textContent ?? "");
  const fieldLabels = "labels" in el ? [...((el as HTMLInputElement).labels ?? [])].map(label => label.textContent ?? "") : [];
  const name = [el.getAttribute("aria-label"), ...by, ...fieldLabels, el.getAttribute("placeholder"), el.getAttribute("name"), el.id, el.getAttribute("title")].join(" ");

  if (/消息|留言|回复|评论|聊天|弹幕|message|reply|comment|chat/i.test(name)) return { refused: "这个框像是发消息的，回车可能直接发出去：已填好，没有回车。要发送请点「发送」，会先问用户。" };
  let region: Element | null = el.closest("form");

  if (!region) {
    region = el.parentElement;

    for (let n = 1; n < 3 && region?.parentElement && region.parentElement !== el.ownerDocument.body; n++) region = region.parentElement;
  }

  if (!region || region === el.ownerDocument.body || region === el.ownerDocument.documentElement) return { labels: [] };
  const maybe = /发送|send|支付|付款|购买|下单|结账|pay|buy|order|checkout|purchase|[¥￥$€£]/i;
  const found = new Set<string>();

  for (const node of region.querySelectorAll("*")) {
    if (node === el) continue;
    const own = node.tagName === "INPUT" ? (node as HTMLInputElement).value : (node.textContent ?? "");

    for (const raw of [node.getAttribute("aria-label"), node.getAttribute("title"), own]) {
      const text = (raw ?? "").trim().replace(/\s+/g, " ");

      if (text && text.length <= 40 && maybe.test(text)) found.add(text);
    }
  }

  return { labels: [...found] };
}
