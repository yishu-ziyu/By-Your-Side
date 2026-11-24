import assert from "node:assert/strict";
import test from "node:test";
import { IncrementalBlockFreezer } from "./block-freezer.js";
import { highlightCodeTokens } from "./code-highlight.js";
import { repairStreamingTail } from "./streaming-tail.js";

test("repairStreamingTail preserves prefix byte-for-byte across every cut", () => {
  const sample = `## 标题

往往是底层**「中文标点加粗」**和 *斜体* 以及 ~~删除~~，还有 \`inline\` 与 [链接](https://example.com/a)。

| 列一 | 列二 |
| --- | --- |
| 值 1 | 值 2 |

\`\`\`ts
const x = 1;
\`\`\`

<card title="预算">
<stat id="fps" label="帧率" value="60" />
</card>`;

  for (let i = 1; i <= sample.length; i += 1) {
    const prefix = sample.slice(0, i);
    const repaired = repairStreamingTail(prefix);

    assert.ok(repaired.keptLength <= prefix.length);
    assert.equal(repaired.text, prefix.slice(0, repaired.keptLength) + repaired.suffix);
  }
});

test("repairStreamingTail holds back trailing CJK emphasis openers and marker-only lines", () => {
  assert.equal(repairStreamingTail("往往是底层**").text, "往往是底层");
  assert.equal(repairStreamingTail("往往是底层*").text, "往往是底层");
  assert.equal(repairStreamingTail("以及~~").text, "以及");
  assert.equal(repairStreamingTail("上一行\n---").text, "上一行\n");
  assert.equal(repairStreamingTail("上一行\n###").text, "上一行\n");
  assert.equal(repairStreamingTail("上一行\n```ty").text, "上一行\n");
  assert.equal(repairStreamingTail("```ts\nconst a = 1;\n``").text, "```ts\nconst a = 1;\n```");
});

test("repairStreamingTail handles table header holdback and delimiter synthesis", () => {
  assert.equal(repairStreamingTail("前文\n\n| 维度 | 方案").text, "前文\n\n");
  assert.equal(repairStreamingTail("| 维度 | 方案 |\n").text, "| 维度 | 方案 |\n| --- | --- |");
  assert.equal(repairStreamingTail("| 维度 | 方案 |\n| --- | --").text, "| 维度 | 方案 |\n| --- | --- |");
});

test("IncrementalBlockFreezer monotonically freezes blocks, isolates cards, and supports rewind", () => {
  const freezer = new IncrementalBlockFreezer();
  const full = "第一段。\n\n```ts\nconst n = 1;\n```\n\n引用 {=fps}：\n\n<card title=\"t\">\n<stat id=\"fps\" label=\"f\" value=\"60\" />\n</card>\n\n尾段。";
  let prevFrozen = 0;

  for (let i = 5; i <= full.length; i += 7) {
    const res = freezer.update(full.slice(0, i), false);

    assert.ok(res.frozenCount >= prevFrozen);
    prevFrozen = res.frozenCount;
  }

  const done = freezer.update(full, true);

  assert.equal(done.frozenCount, done.blocks.length);
  assert.ok(done.blocks.some((b) => b.kind === "code"));
  assert.ok(done.blocks.some((b) => b.kind === "card"));
  assert.ok(done.blocks.some((b) => b.hasRef));

  const rewound = freezer.update("第一段。\n\n改写后的第二段。", true);

  assert.equal(rewound.blocks.length, 2);
  assert.equal(rewound.blocks[0]!.raw.trim(), "第一段。");
});

test("highlightCodeTokens escapes HTML and highlights keywords safely", () => {
  const html = highlightCodeTokens('const tag = "<script>alert(1)</script>";\n// note', "ts");

  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<span class="tok-kw">const</span>'));
  assert.ok(html.includes('<span class="tok-com">// note</span>'));
});
