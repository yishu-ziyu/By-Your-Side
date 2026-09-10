import { describe, expect, it } from "vitest";
import { axTreeToText, MAX_OUTPUT_CHARS, type AxNodeLite } from "../src/background/axtree.js";

function node(partial: Partial<AxNodeLite> & { nodeId: string }): AxNodeLite {
  return partial;
}

const FIXTURE: AxNodeLite[] = [
  node({ nodeId: "root", role: { value: "RootWebArea" }, name: { value: "示例页" }, childIds: ["nav", "main", "ignored1"], backendDOMNodeId: 1 }),
  node({ nodeId: "nav", parentId: "root", role: { value: "navigation" }, childIds: ["link1"], backendDOMNodeId: 2 }),
  node({ nodeId: "link1", parentId: "nav", role: { value: "link" }, name: { value: "首页" }, backendDOMNodeId: 10, properties: [{ name: "url", value: { value: "https://example.com/home" } }] }),
  node({ nodeId: "main", parentId: "root", role: { value: "main" }, childIds: ["h1", "btn", "box", "t1"], backendDOMNodeId: 3 }),
  node({ nodeId: "h1", parentId: "main", role: { value: "heading" }, name: { value: "标题" }, backendDOMNodeId: 4, properties: [{ name: "level", value: { value: 1 } }] }),
  node({ nodeId: "btn", parentId: "main", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 20, properties: [{ name: "disabled", value: { value: true } }] }),
  node({ nodeId: "box", parentId: "main", role: { value: "textbox" }, name: { value: "搜索" }, backendDOMNodeId: 30, value: { value: "已填内容" } }),
  node({ nodeId: "t1", parentId: "main", role: { value: "StaticText" }, name: { value: "一段说明文字" }, backendDOMNodeId: 40 }),
  // ignored 容器：自身不出行，子节点提升
  node({ nodeId: "ignored1", parentId: "root", ignored: true, childIds: ["deep1"] }),
  node({ nodeId: "deep1", parentId: "ignored1", role: { value: "link" }, name: { value: "深层链接" }, backendDOMNodeId: 50 }),
  // InlineTextBox 整棵子树丢弃
  node({ nodeId: "itb", parentId: "root", role: { value: "InlineTextBox" }, name: { value: "不应出现" }, backendDOMNodeId: 60 }),
];

describe("axTreeToText", () => {
  it("emits roles, names and indentation; interactive roles get refs (= backendDOMNodeId)", () => {
    const { text, backendIds } = axTreeToText(FIXTURE);
    const lines = text.split("\n");
    expect(lines).toContain('RootWebArea "示例页"');
    expect(lines).toContain('  [ref=10] link "首页" url=https://example.com/home');
    expect(lines.some((l) => l.includes("[ref=20]") && l.includes('button "提交"') && l.includes("disabled"))).toBe(true);
    expect(lines.some((l) => l.includes("[ref=30]") && l.includes('textbox "搜索"') && l.includes('value="已填内容"'))).toBe(true);
    expect(lines.some((l) => l.includes('heading "标题"') && l.includes("level=1"))).toBe(true);
    expect(lines.some((l) => l.includes("text: 一段说明文字"))).toBe(true);
    // 内容定位修订：heading / StaticText 也必须可引用。
    const heading = lines.find((l) => l.includes("heading"));
    expect(heading).toContain("[ref=4]");
    expect(backendIds.sort((a, b) => a - b)).toEqual([4, 10, 20, 30, 40, 50]);
  });

  it("ref 即 backendDOMNodeId：跨快照天然保号（ego 约定）", () => {
    const first = axTreeToText(FIXTURE).text;
    const second = axTreeToText(FIXTURE).text;
    expect(second).toEqual(first);
    expect(second).toContain("[ref=20]");
  });

  it("keeps children of ignored nodes (lifted), drops InlineTextBox subtrees", () => {
    const { text } = axTreeToText(FIXTURE);
    expect(text).toContain('link "深层链接"');
    expect(text).not.toContain("不应出现");
  });

  it("collapses unnamed generic containers but keeps their children", () => {
    const nodes: AxNodeLite[] = [
      node({ nodeId: "r", role: { value: "RootWebArea" }, childIds: ["g"], backendDOMNodeId: 1 }),
      node({ nodeId: "g", parentId: "r", role: { value: "generic" }, childIds: ["b"], backendDOMNodeId: 2 }),
      node({ nodeId: "b", parentId: "g", role: { value: "button" }, name: { value: "内层按钮" }, backendDOMNodeId: 3 }),
    ];
    const { text } = axTreeToText(nodes);
    expect(text).not.toContain("generic");
    expect(text).toContain('button "内层按钮"');
  });

  it("truncates with a marker when output exceeds the cap", () => {
    const many: AxNodeLite[] = [
      node({ nodeId: "r", role: { value: "RootWebArea" }, childIds: [], backendDOMNodeId: 1 }),
    ];
    const childIds: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const id = `n${i}`;
      childIds.push(id);
      many.push(
        node({
          nodeId: id,
          parentId: "r",
          role: { value: "StaticText" },
          name: { value: `第 ${i} 条内容`.repeat(20) },
          backendDOMNodeId: 100 + i,
        }),
      );
    }
    many[0]!.childIds = childIds;
    const { text, truncated } = axTreeToText(many);
    expect(truncated).toBe(true);
    expect(text).toContain("[truncated");
    expect(text.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
  });

  it("handles an empty node list", () => {
    const { text, backendIds } = axTreeToText([]);
    expect(text).toBe("");
    expect(backendIds).toEqual([]);
  });
});

describe("快照预算治理", () => {
  it("超预算时优先保住全部 ref 行，先丢纯文本行", () => {
    const textNodes: AxNodeLite[] = [];
    const rootChildren: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const id = `t${i}`;
      rootChildren.push(id);
      textNodes.push(node({ nodeId: id, parentId: "root", role: { value: "StaticText" }, name: { value: `大段说明文字第 ${i} 段，` + "很长的正文内容".repeat(6) }, backendDOMNodeId: 1000 + i }));
    }
    const nodes: AxNodeLite[] = [
      node({ nodeId: "root", role: { value: "RootWebArea" }, childIds: ["btn", ...rootChildren], backendDOMNodeId: 1 }),
      node({ nodeId: "btn", parentId: "root", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 20 }),
      ...textNodes,
    ];
    const { text, truncated, backendIds } = axTreeToText(nodes, 3_000);
    expect(truncated).toBe(true);
    expect(backendIds).toContain(20);
    expect(text).toContain('[ref=20] button "提交"');
    expect(text.length).toBeLessThan(3_200);
    expect(text).toContain("[truncated");
  });

  it("父节点名字与子静态文本重复时只出一行", () => {
    const nodes: AxNodeLite[] = [
      node({ nodeId: "r", role: { value: "RootWebArea" }, childIds: ["b"], backendDOMNodeId: 1 }),
      node({ nodeId: "b", parentId: "r", role: { value: "button" }, name: { value: "暂停" }, childIds: ["t"], backendDOMNodeId: 2 }),
      node({ nodeId: "t", parentId: "b", role: { value: "StaticText" }, name: { value: "暂停" }, backendDOMNodeId: 3 }),
    ];
    const { text } = axTreeToText(nodes);
    expect(text.match(/暂停/g)).toHaveLength(1);
  });

  it("不同文字的静态文本保留", () => {
    const nodes: AxNodeLite[] = [
      node({ nodeId: "r", role: { value: "RootWebArea" }, childIds: ["b", "t1", "t2"], backendDOMNodeId: 1 }),
      node({ nodeId: "b", parentId: "r", role: { value: "button" }, name: { value: "提交" }, backendDOMNodeId: 2 }),
      node({ nodeId: "t1", parentId: "r", role: { value: "StaticText" }, name: { value: "提交订单后不可撤销" }, backendDOMNodeId: 3 }),
      node({ nodeId: "t2", parentId: "r", role: { value: "StaticText" }, name: { value: "另一段说明" }, backendDOMNodeId: 4 }),
    ];
    const { text } = axTreeToText(nodes);
    expect(text).toContain("提交订单后不可撤销");
    expect(text).toContain("另一段说明");
  });
});
