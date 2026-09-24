import { describe, expect, it } from "vitest";
import { DEFAULT_SUGGESTIONS, suggestionsFor, type PageProfile } from "../src/sidepanel/starter-suggestions.js";

const page = (over: Partial<PageProfile>): PageProfile => ({ paragraphs: 0, inputs: 0, tables: 0, listItems: 0, cjkRatio: 0.9, ...over });

const labels = (profile: PageProfile | null) => suggestionsFor(profile).map((item) => item.label);

describe("新对话建议跟着页面变", () => {
  it("英文文章：概括 + 翻译", () => {
    expect(labels(page({ paragraphs: 6, cjkRatio: 0 }))).toEqual(["概括这一页", "翻译成中文"]);
  });

  it("按正文判断语言：英文正文建议翻译", () => {
    expect(labels(page({ paragraphs: 4, cjkRatio: 0.02 }))).toContain("翻译成中文");
  });

  it("中文文章不建议翻译", () => {
    expect(labels(page({ paragraphs: 6 }))).toEqual(["概括这一页"]);
  });

  it("表单页先给填写；表格或长列表给整理成表格；最多三个", () => {
    expect(labels(page({ inputs: 4 }))[0]).toBe("帮我填写表单");
    expect(labels(page({ tables: 1 }))).toEqual(["整理成表格"]);
    expect(labels(page({ cjkRatio: 0, paragraphs: 5, inputs: 3, tables: 2 }))).toHaveLength(3);
  });

  it("探测失败沿用默认建议；什么都没有时至少给概括", () => {
    expect(suggestionsFor(null)).toEqual(DEFAULT_SUGGESTIONS);
    expect(labels(page({}))).toEqual(["概括当前页"]);
  });
});
