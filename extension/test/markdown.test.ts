import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { renderMarkdownHtml } from "../src/sidepanel/markdown.js";

/** 与 main.ts 同配置的 marked 基线，用于比对「除裸网址边界外没有别的改动」。 */
const baseline = new Marked({ breaks: true, gfm: true });

/** 取出渲染结果里的所有链接 href（保持 HTML 转义原样）。 */
function hrefs(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!);
}

describe("renderMarkdownHtml：裸网址自动链接", () => {
  it("中文逗号后的正文不进裸链接（真实案例：已在新标签页打开 …）", () => {
    const html = renderMarkdownHtml(
      "已在新标签页打开 https://example.com，页面显示 “Example Domain”，其他什么都没动。",
    );

    expect(hrefs(html)).toEqual(["https://example.com"]);
    expect(html).toContain(
      '<a href="https://example.com">https://example.com</a>，页面显示 “Example Domain”，其他什么都没动。',
    );
  });

  it.each([
    ["打开 https://example.com。尾文结束", "https://example.com", "</a>。尾文结束"],
    ["打开 https://example.com；分号尾文", "https://example.com", "</a>；分号尾文"],
    ["打开 https://example.com“引号尾文”", "https://example.com", "</a>“引号尾文”"],
    ["打开 https://example.com，页面显示", "https://example.com", "</a>，页面显示"],
    ["打开 https://example.com页面显示 结束", "https://example.com", "</a>页面显示 结束"],
    ["打开 https://example.com/path。尾文", "https://example.com/path", "</a>。尾文"],
  ])("中文标点与尾文止于链接外：%s", (input, expectedHref, expectedTail) => {
    const html = renderMarkdownHtml(input);
    expect(hrefs(html)).toEqual([expectedHref]);
    expect(html).toContain(expectedTail);
  });

  it("www 裸链接同样止于中文逗号", () => {
    const html = renderMarkdownHtml("打开 www.example.com，页面显示 结束");
    expect(hrefs(html)).toEqual(["http://www.example.com"]);
    expect(html).toContain("</a>，页面显示 结束");
  });

  it("英文网址的参数/片段/路径/平衡括号保持完整", () => {
    const html = renderMarkdownHtml(
      "见 https://example.com/a?b=1&c=2#frag 与 https://en.wikipedia.org/wiki/Foo_(bar) 说明",
    );

    expect(hrefs(html)).toEqual([
      "https://example.com/a?b=1&c=2#frag",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("中文路径/查询/片段保留（不一律删除非 ASCII 字符）", () => {
    const html = renderMarkdownHtml("路径 https://example.com/路径/详情?q=标题#顶部 保持");
    expect(hrefs(html)).toEqual([
      "https://example.com/%E8%B7%AF%E5%BE%84/%E8%AF%A6%E6%83%85?q=%E6%A0%87%E9%A2%98#%E9%A1%B6%E9%83%A8",
    ]);
  });

  it("明确的 Markdown 链接（中文文字/中文路径）保持", () => {
    const html = renderMarkdownHtml("链接：[例子](https://example.com/中文路径)，完成");
    expect(hrefs(html)).toEqual(["https://example.com/%E4%B8%AD%E6%96%87%E8%B7%AF%E5%BE%84"]);
    expect(html).toContain(">例子</a>，完成");
  });

  it("英文尾随标点仍按 marked 既有规则剥离", () => {
    const html = renderMarkdownHtml("见 (https://example.com) 括号，和 https://example.com/a, 逗号");
    expect(hrefs(html)).toEqual(["https://example.com", "https://example.com/a"]);
  });

  it("行内代码与代码块不被改写", () => {
    const inline = renderMarkdownHtml("`https://example.com，页面` 行内代码");
    expect(inline).toContain("<code>https://example.com，页面</code>");
    expect(hrefs(inline)).toEqual([]);

    const fenced = renderMarkdownHtml("```\nhttps://example.com，页面\n```");
    expect(fenced).toContain("https://example.com，页面");
    expect(hrefs(fenced)).toEqual([]);
  });

  it("裸 IRI 域名不猜链接，显式尖括号自动链接保留（取舍）", () => {
    const bare = renderMarkdownHtml("IRI https://例え.テスト/路径 说明");
    expect(hrefs(bare)).toEqual([]);
    expect(bare).toContain("https://例え.テスト/路径");

    const explicit = renderMarkdownHtml("显式 <https://例え.テスト/路径> 链接");
    expect(hrefs(explicit)).toEqual([
      "https://%E4%BE%8B%E3%81%88.%E3%83%86%E3%82%B9%E3%83%88/%E8%B7%AF%E5%BE%84",
    ]);
  });

  it("邮件自动链接保持", () => {
    const html = renderMarkdownHtml("邮件 me@example.com，然后继续");
    expect(hrefs(html)).toEqual(["mailto:me@example.com"]);
    expect(html).toContain("</a>，然后继续");
  });

  it("仍是 marked HTML 输出，XSS 过滤留给外部 sanitizer（main.ts 的 DOMPurify）", () => {
    const html = renderMarkdownHtml('<img src=x onerror="alert(1)">');
    expect(html).toContain("onerror");
  });

  it("非中文场景与 marked 基线输出一致（不全局破坏文本替换）", () => {
    const samples = [
      "# 标题\n\n- 一\n- 二\n",
      "**粗体** 与 *斜体* 与 ~~删除~~\n",
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
      "> 引用\n> 第二行\n",
      "行内 `code` 与\n```ts\nconst a: number = 1;\n```\n",
      "见 https://example.com/a?b=1&c=2#frag 与 (https://example.com) 结束\n",
      "第一行\n第二行\n",
      "[链接](https://example.com/x) 和 ![图](https://example.com/i.png)\n",
      "<div>raw html</div>\n\n段落\n",
    ];

    for (const sample of samples) {
      expect(renderMarkdownHtml(sample)).toBe(baseline.parse(sample, { async: false }));
    }
  });
});
