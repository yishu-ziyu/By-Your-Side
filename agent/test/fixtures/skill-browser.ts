import { vi } from "vitest";
import { elementMatches, type ElementExpectation } from "../../../shared/element-state.js";

class ElementStub {
  labels: ElementStub[] = [];
  parentElement = null;
  value = "";
  textContent = "";
  constructor(readonly tagName: string, readonly attrs: Record<string, string>) {}
  get id() { return this.attrs.id ?? ""; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  querySelector() { return null; }
}

/** Actual generated page JavaScript runs against a small DOM. Browser transport is scripted. */
export function skillBrowser() {
  const state = { hostname: "example.com", documentId: "document-one", epoch: 0, writable: true, afterFill: (() => {}) as () => void };
  const query = new ElementStub("INPUT", { "aria-label": "客户名", type: "search" });
  const region = new ElementStub("INPUT", { "aria-label": "地区", type: "text" });
  const search = new ElementStub("BUTTON", { "aria-label": "搜索" });
  const output = new ElementStub("DIV", { "aria-label": "查询结果" });
  const nodes = [query, region, search, output];
  const document = {
    querySelectorAll: (selector: string) => /^\[data-sideagent-target(?:=skill-\d+)?\]$/.test(selector) ? nodes.filter(node =>
      selector.includes("=") ? node.attrs["data-sideagent-target"] === selector.slice(selector.indexOf("=") + 1, -1) : node.attrs["data-sideagent-target"] !== undefined)
      : /^@[1-4]$/.test(selector) ? [nodes[Number(selector.slice(1)) - 1]!]
      : nodes.filter(node => node.tagName.toLowerCase() === selector.toLowerCase()),
    getElementById: (id: string) => nodes.find(node => node.id === id) ?? null,
  };
  const writes: Array<{ name: string; target?: string; value?: unknown }> = [];
  const facts = new Map<string, string>();
  const call = vi.fn(async (name: string, params: Record<string, unknown>, _timeout?: number, _session?: string, _program?: string, _epoch?: number, id?: string) => {
    if (id) facts.set(id, "executed");
    if (name === "snapshot") return { tabId: 7, url: `https://${state.hostname}/search`, text: '[ref=1] searchbox "客户名"\n[ref=2] textbox "地区"\n[ref=3] button "搜索"\n[ref=4] status "查询结果"' };
    if (name === "get_active_tab") return { tab: { id: 7, url: `https://${state.hostname}/search`, title: "客户查询" } };
    if (name === "js") return { value: new Function("document", "location", `return (${String(params.code)});`)(document, { hostname: state.hostname }) };
    const node = document.querySelectorAll(String(params.target))[0];
    if (!node) throw new Error("目标不存在");
    if (name === "fill") { node.value = String(params.value); writes.push({ name, target: node.attrs["aria-label"], value: params.value }); state.afterFill(); return { filled: true }; }
    if (name === "click") { output.textContent = `${query.value} / ${region.value}`; writes.push({ name, target: node.attrs["aria-label"] }); return { clicked: true }; }
    if (name === "read_element") {
      const expect = params.expect as ElementExpectation | undefined;
      const actual = expect?.property === "value" ? node.value : node.textContent;
      if (expect && !elementMatches(actual, expect)) throw new Error("结果条件不成立");
      return { tabId: 7, target: params.target, documentId: state.documentId, tagName: node.tagName.toLowerCase(), textContent: node.textContent, value: node.value,
        anchorSource: { tag: node.tagName.toLowerCase(), type: node.attrs.type, ariaLabel: node.attrs["aria-label"] },
        ...(expect ? { check: { matched: true, property: expect.property, elapsedMs: 0 } } : {}) };
    }
    return {};
  });
  const rpc: any = { call, resolvePageParams: (_name: string, params: Record<string, unknown>) => ({ tabId: 7, ...params }),
    getPageTarget: () => 7, setPageTarget: vi.fn(), ensureToolCall: vi.fn(), noteToolFact: (id: string, value: string) => facts.set(id, value),
    getExecutionFact: (id: string) => facts.get(id) ?? "executed", markCallRejected: vi.fn() };
  return { state, nodes, query, region, output, rpc, writes };
}
