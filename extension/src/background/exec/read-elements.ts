import { recordObservedDocument } from "../observation-document.js";
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { getWorkingTabId, resolveReadableTab } from "../state.js";

const MIN_LIMIT = 1;

const MAX_LIMIT = 200;

const DEFAULT_LIMIT = 60;

/** 单次返回的安全上限；超过即报错，不返回部分内容。 */
const MAX_OUTPUT_CHARS = 200_000;

export type ReadElementsResult = ToolContract["read_elements"]["data"];

type ElementSummary = ReadElementsResult["elements"][number];

type ElementsPage = Pick<ReadElementsResult, "total" | "truncated" | "elements">;

type ElementsReply = { ok: true; data: ElementsPage } | { ok: false; error: string };

/** 一次批量读取的结果：页面返回的数据 + 本次读取到的文档身份。 */
type ElementsRead = { data: ElementsPage; documentId?: string };

/** Serialized unchanged into executeScript; no closure over outer imports or page-supplied code. */
function readElementsInPage(selector: string, limit: number): ElementsReply {
  try {
    let matches: NodeListOf<Element>;

    try { matches = document.querySelectorAll(selector); }
    catch { throw new Error(`无效的 CSS 选择器: ${selector}`); }

    const total = matches.length;
    const truncated = total > limit;

    const elements: ElementSummary[] = Array.from(matches).slice(0, limit).map((element, index) => {
      const tagName = String(element.tagName || "").toLowerCase();
      const text = String(element.textContent ?? "").trim().slice(0, 200);
      const style = getComputedStyle(element);
      const visible = element.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none";
      const box = element.getBoundingClientRect();
      const rect = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      const scopeLabels: string[] = [];
      let scope = element.parentElement;

      for (let depth = 0; scope && depth < 8 && scopeLabels.length < 4; depth++, scope = scope.parentElement) {
        const role = scope.getAttribute?.("role") || scope.tagName?.toLowerCase();

        if (!["form", "dialog", "region", "group", "row", "article", "section", "fieldset"].includes(role)) continue;
        const labelledBy = scope.getAttribute?.("aria-labelledby");

        const name = scope.getAttribute?.("aria-label")
          || (labelledBy ? labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ") : "")
          || scope.querySelector?.(":scope > legend, :scope > h1, :scope > h2, :scope > h3")?.textContent;

        if (name?.trim()) scopeLabels.push(`${role}: ${name.trim().slice(0, 180)}`);
      }

      // 只指向这一个元素的 CSS 路径：唯一 id 优先，否则逐层加 :nth-child，直到整页只匹配它一个；算不出来就不给。
      let target: string | undefined;

      try {
        const parts: string[] = [];
        const unique = (path: string) => document.querySelectorAll(path).length === 1 && document.querySelector(path) === element;

        for (let node: Element | null = element; node && node !== document.documentElement && !target; node = node.parentElement) {
          const id = node.getAttribute("id");

          if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) parts.unshift(`#${CSS.escape(id)}`);
          else {
            const parent = node.parentElement;
            parts.unshift(parent ? `${node.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(parent.children, node) + 1})` : node.tagName.toLowerCase());
          }

          if (unique(parts.join(" > "))) target = `loc=css:${parts.join(" > ")}`;
        }
      } catch {
        target = undefined;
      }

      const summary: ElementSummary = {
        index, tagName, text, visible, rect,
        style: { backgroundColor: style.backgroundColor, color: style.color, outline: style.outline, border: style.border, textDecoration: style.textDecoration, fontWeight: style.fontWeight },
      };

      if (target) summary.target = target;

      if (scopeLabels.length) summary.scopeLabels = scopeLabels;

      return summary;
    });

    return { ok: true, data: { total, truncated, elements } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseSelector(raw: string): { css: string; normalized: string } {
  if (typeof raw !== "string" || !raw) throw new Error("selector 不能为空");

  if (raw.startsWith("@")) throw new Error("read_elements 不支持 @ref，请使用 loc=css: 或原生 CSS 选择器");

  if (raw.startsWith("loc=") && !raw.startsWith("loc=css:")) throw new Error("read_elements 只支持 loc=css: 或原生 CSS 选择器");
  const css = raw.startsWith("loc=css:") ? raw.slice("loc=css:".length) : raw;

  if (!css) throw new Error("CSS 选择器不能为空");

  return { css, normalized: `loc=css:${css}` };
}

function parseLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < MIN_LIMIT || raw > MAX_LIMIT) {
    throw new Error(`limit 必须是 ${MIN_LIMIT}-${MAX_LIMIT} 之间的整数`);
  }

  return raw;
}

/** 与 read_element 的 assertComplete 一致：超限即报错，绝不返回部分内容。 */
function assertBounded(data: ElementsPage): ElementsPage {
  if (JSON.stringify(data.elements).length > MAX_OUTPUT_CHARS) {
    throw new Error(`read_elements 输出超过安全上限 ${MAX_OUTPUT_CHARS} 字符，未返回部分内容；请缩小 selector 匹配范围或降低 limit`);
  }

  return data;
}

async function readInDocument(tabId: number, member: string, css: string, limit: number): Promise<{ data: ElementsPage; documentId?: string }> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: readElementsInPage,
    args: [css, limit],
  });

  const first = results[0] as (chrome.scripting.InjectionResult<ElementsReply> & { error?: unknown }) | undefined;

  if (!first) throw new Error("页面读取没有返回结果");

  if (first.error) throw new Error(`页面读取失败: ${String(first.error)}`);
  const reply = first.result;

  if (!reply || typeof reply.ok !== "boolean") throw new Error("页面读取未返回结构化结果");

  if (!reply.ok) throw new Error(reply.error);
  const data = assertBounded(reply.data);

  if (first.documentId) recordObservedDocument(tabId, member, first.documentId);

  const read: ElementsRead = { data };

  if (first.documentId) read.documentId = first.documentId;

  return read;
}

/** 宿主自己按选择器读取全部命中元素（有界），供任务核验取证；不改页面，只读。 */
export async function readElements(
  params: ToolContract["read_elements"]["params"],
  executionKey: string = LEAD_SESSION_ID,
): Promise<ReadElementsResult> {
  const { css, normalized } = parseSelector(params.selector);
  const limit = parseLimit(params.limit);
  const tabId = params.tabId ?? await getWorkingTabId(executionKey);

  if (tabId == null) throw new Error("当前执行成员没有工作标签页；请提供需要读取的 tabId");
  const tab = await resolveReadableTab(tabId, executionKey);

  if (tab.id == null) throw new Error(`标签页 ${tabId} 已关闭`);
  const { data, documentId } = await readInDocument(tabId, executionKey, css, limit);

  const result: ReadElementsResult = { tabId, selector: normalized, ...data };

  if (documentId) result.documentId = documentId;

  return result;
}
