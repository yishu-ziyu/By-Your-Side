/**
 * content 快照 iframe 视口语义（A3 补充）。
 * viewport 下：视口外 iframe 整行丢弃（含其同源子文档）；视口内 iframe 仅占位
 *（not-expanded），不递归子文档——因为不做子文档坐标换算。
 * full_page 保留旧行为（占位＋递归同源子文档）作为回归守卫。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = { innerWidth: 1280, innerHeight: 800, __sideagent: undefined };
  g.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
  g.CSS = { escape: (s: string) => s };
  g.document = { documentElement: undefined };
  return g;
});

import "../src/content/snapshot.js";

interface FakeRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface FakeText {
  nodeType: 3;
  textContent: string;
  parentElement: FakeElement | null;
}

class FakeElement {
  nodeType = 1 as const;
  tagName: string;
  attrs: Record<string, string>;
  childNodes: Array<FakeElement | FakeText> = [];
  parentElement: FakeElement | null = null;
  rect: FakeRect;
  text: string;
  contentDocument: { documentElement: FakeElement; childNodes: Array<FakeElement | FakeText> } | null = null;
  tabIndex = -1;
  isContentEditable = false;
  shadowRoot: null = null;

  constructor(
    tag: string,
    opts: {
      attrs?: Record<string, string>;
      children?: Array<FakeElement | FakeText>;
      rect?: Partial<FakeRect>;
      text?: string;
    } = {},
  ) {
    this.tagName = tag.toUpperCase();
    this.attrs = opts.attrs ?? {};
    this.text = opts.text ?? "";
    this.rect = {
      top: 0,
      bottom: 100,
      left: 0,
      right: 100,
      width: 100,
      height: 100,
      ...opts.rect,
    };
    for (const c of opts.children ?? []) this.append(c);
  }

  append(c: FakeElement | FakeText): void {
    c.parentElement = this;
    this.childNodes.push(c);
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }

  get id(): string {
    return this.attrs.id ?? "";
  }

  get textContent(): string {
    return this.text;
  }

  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }
}

function textNode(s: string): FakeText {
  return { nodeType: 3, textContent: s, parentElement: null };
}

interface FakeNs {
  snapshot?: (scope?: string) => string;
}

function takeSnapshot(scope?: string): string {
  const w = fakes.window as unknown as { __sideagent?: FakeNs };
  const snap = w.__sideagent?.snapshot;
  if (!snap) throw new Error("content snapshot 未加载");
  return snap(scope);
}

beforeEach(() => {
  // 同一 window 对象沿用（content 脚本只加载一次）；每轮重建 DOM 即有确定性 ref。
  const docHolder = fakes.document as { documentElement: unknown };

  const inFrameDoc = new FakeElement("div", {
    children: [textNode("InsideSecret"), new FakeElement("button", { text: "InsideBtn" })],
  });
  const outFrameDoc = new FakeElement("div", {
    children: [textNode("OutsideSecret"), new FakeElement("button", { text: "OutsideBtn" })],
  });
  const inFrame = new FakeElement("iframe", {
    attrs: { src: "https://in.example/" },
    rect: { top: 100, bottom: 300, left: 0, right: 200, width: 200, height: 200 },
  });
  inFrame.contentDocument = { documentElement: inFrameDoc, childNodes: [inFrameDoc] };
  const outFrame = new FakeElement("iframe", {
    attrs: { src: "https://out.example/" },
    rect: { top: 2000, bottom: 2200, left: 0, right: 200, width: 200, height: 200 },
  });
  outFrame.contentDocument = { documentElement: outFrameDoc, childNodes: [outFrameDoc] };

  const body = new FakeElement("body", {
    children: [
      new FakeElement("button", { attrs: { id: "top" }, text: "TopBtn" }),
      inFrame,
      outFrame,
      new FakeElement("div", { children: [textNode("AfterText")] }),
    ],
  });
  const html = new FakeElement("html", { children: [body] });
  docHolder.documentElement = html;
});

describe("viewport 下 iframe 语义", () => {
  it("视口外 iframe 整行丢弃，不带回其子文档内容", () => {
    const out = takeSnapshot("viewport");
    expect(out).not.toContain("out.example");
    expect(out).not.toContain("OutsideSecret");
    expect(out).not.toContain("OutsideBtn");
  });

  it("视口内 iframe 仅占位不递归", () => {
    const out = takeSnapshot("viewport");
    expect(out).toContain("in.example");
    expect(out).toContain("not-expanded");
    expect(out).not.toContain("InsideSecret");
    expect(out).not.toContain("InsideBtn");
  });

  it("视口内普通内容不受影响", () => {
    const out = takeSnapshot("viewport");
    expect(out).toContain("TopBtn");
    expect(out).toContain("AfterText");
  });
});

describe("full_page 保留旧行为（回归）", () => {
  it("同源子文档仍递归展开，占位行无 not-expanded", () => {
    const out = takeSnapshot("full_page");
    expect(out).toContain("InsideSecret");
    expect(out).toContain("OutsideSecret");
    expect(out).not.toContain("not-expanded");
  });
});
