import { addAxRefs, isAxRef, snapshotRefKind } from "../axstate.js";
import { sendCommand } from "../debugger.js";
import { isolatedReadContext } from "../isolated-read-context.js";
import { parseTarget, resolveArgs, resolveTargetSelector } from "../../shared/target.js";
import { wrapPageContent } from "../../../../shared/untrusted.js";

type RevealFact = "controls" | "label" | "search" | "form" | "words";

type Revealer = { role: string; name: string; facts: RevealFact[] };

const FACT_TEXT: Record<RevealFact, string> = {
  controls: "它的 aria-controls 指向这个输入框或包住它的区域",
  label: "它是这个输入框的 label",
  search: "和输入框在同一个搜索区域里",
  form: "和输入框在同一个表单里",
  words: "名字和输入框的提示文字有相同的词",
};

export function revealersInPage(this: Element): (Element[] & { found?: Revealer[] }) | null {
  const field = this;
  const box = field.getBoundingClientRect();

  if (!field.isConnected || (box.width > 0 && box.height > 0)) return null;
  const doc = field.ownerDocument;
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const asian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
  const words = (text: string) => {
    const out = new Set<string>();

    for (const run of text.match(asian) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    for (const word of text.replace(asian, " ").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) out.add(word);

    return out;
  };
  const chain: Element[] = [];

  for (let node: Element | null = field; node; node = node.parentElement) chain.push(node);
  const ids = new Set(chain.map(node => node.id).filter(Boolean));
  const regions = chain.slice(1).filter(node => node.matches('form, search, [role="search"]'));
  const input = field as HTMLInputElement;
  const labelled = (field.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => doc.getElementById(id)?.textContent ?? "");
  const fieldWords = words([field.getAttribute("placeholder"), field.getAttribute("aria-label"), field.getAttribute("title"), ...labelled, ...[...(input.labels ?? [])].map(label => label.textContent)].join(" "));
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();

    if (r.width <= 0 || r.height <= 0) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkVisibilityCSS: true })) return false;

    return !el.closest('[inert],[aria-disabled="true"]') && !el.matches(":disabled");
  };
  const roleOf = (el: Element) => clean(el.getAttribute("role")).split(" ")[0] || ({ A: "link", BUTTON: "button", SUMMARY: "summary", LABEL: "label", INPUT: "button" } as Record<string, string>)[el.tagName] || "element";
  const picked: Array<Revealer & { el: Element; score: number; depth: number }> = [];
  const controls = 'a[href], button, summary, label, input[type="button"], input[type="submit"], input[type="image"], [role="button"], [role="link"], [role="tab"], [aria-controls], [aria-expanded]';

  for (const el of doc.querySelectorAll(controls)) {
    if (el.contains(field) || field.contains(el)) continue;
    const facts: RevealFact[] = [];
    const name = clean(el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || (el as HTMLInputElement).value || el.getAttribute("alt")).slice(0, 40);

    if ((el.getAttribute("aria-controls") ?? "").split(/\s+/).some(id => ids.has(id))) facts.push("controls");
    if (el.tagName === "LABEL" && field.id && (el as HTMLLabelElement).htmlFor === field.id) facts.push("label");
    const region = regions.find(node => node.contains(el));

    if (region) facts.push(region.matches("form") ? "form" : "search");
    if ([...words(name + " " + (el.getAttribute("title") ?? ""))].some(word => fieldWords.has(word))) facts.push("words");
    const submitsField = !!input.form && (el as HTMLButtonElement).form === input.form && /^(submit|image)$/.test((el as HTMLButtonElement).type ?? "");

    if (!facts.length || (submitsField && !facts.includes("controls")) || !shown(el)) continue;
    const score = facts.reduce((sum, fact) => sum + ({ controls: 8, label: 4, search: 3, form: 2, words: 2 })[fact], 0);

    picked.push({ el, role: roleOf(el), name, facts, score, depth: chain.findIndex(node => node.contains(el)) });
  }

  picked.sort((a, b) => b.score - a.score || a.depth - b.depth);
  const top = picked.filter(item => item.score === picked[0]?.score).slice(0, 2);
  const list = top.map(item => item.el) as Element[] & { found?: Revealer[] };

  list.found = top.map(({ role, name, facts }) => ({ role, name, facts }));

  return list;
}

function isRevealer(value: unknown): value is Revealer {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;

  return typeof item.role === "string" && typeof item.name === "string" && Array.isArray(item.facts) && item.facts.every(fact => typeof fact === "string" && fact in FACT_TEXT);
}

async function resolveField(tabId: number, where: { backendNodeId: number } | { target: string }, contextId: number, objectGroup: string): Promise<string | undefined> {
  if ("backendNodeId" in where) {
    return (await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: where.backendNodeId, executionContextId: contextId, objectGroup })).object?.objectId;
  }

  const parsed = parseTarget(where.target);

  if (!parsed || parsed.kind === "ref") return undefined;
  const args = resolveArgs(parsed);
  const expression = `(${resolveTargetSelector.toString()})(${JSON.stringify(args.kind)}, ${JSON.stringify(args.selector)})`;
  const found = await sendCommand<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(tabId, "Runtime.evaluate", { expression, contextId, objectGroup });

  return found.exceptionDetails ? undefined : found.result?.objectId;
}

function refOf(tabId: number, backendNodeId: number): string {
  if (isAxRef(tabId, backendNodeId)) return `@${backendNodeId} `;
  if (snapshotRefKind(tabId) !== "ax") return "";
  addAxRefs(tabId, [backendNodeId]);

  return `@${backendNodeId} `;
}

export async function hiddenFieldHint(tabId: number, where: { backendNodeId: number } | { target: string }, action: "fill" | "click" = "fill"): Promise<string> {
  const objectGroup = `bys-reveal-${crypto.randomUUID()}`;

  try {
    const contextId = await isolatedReadContext(tabId);
    const fieldId = await resolveField(tabId, where, contextId, objectGroup);

    if (!fieldId) return "";
    const call = (objectId: string, functionDeclaration: string, args: unknown[] = [], returnByValue = false) =>
      sendCommand<{ result?: { objectId?: string; value?: unknown }; exceptionDetails?: unknown }>(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue, objectGroup });
    const list = (await call(fieldId, revealersInPage.toString())).result?.objectId;

    if (!list) return "";
    const found = (await call(list, "function() { return this.found; }", [], true)).result?.value;

    if (!Array.isArray(found) || !found.length || !found.every(isRevealer)) return "";
    const named: string[] = [];

    for (const [index, item] of found.entries()) {
      const el = (await call(list, "function(i) { return this[i]; }", [index])).result?.objectId;

      if (!el) return "";
      const { node } = await sendCommand<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", { objectId: el });

      named.push(`${refOf(tabId, node.backendNodeId)}${item.role}（${item.facts.map(fact => FACT_TEXT[fact]).join("，")}）${item.name ? `，名字：${wrapPageContent(item.name)}` : ""}`);
    }

    const subject = action === "click" ? "这个元素在页面上还没显示出来，没有点击，也没有点任何东西" : "这个输入框在页面上还没显示出来，没有写入，也没有点任何东西";
    const follow = action === "click" ? "先点它，等目标出现后再操作。" : "先点它，等输入框出现后再填写。";

    return `。${subject}。可能让它出现的可见控件：${named.join("；或 ")}。${follow}`;
  } catch {
    return "";
  } finally {
    await sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
}
