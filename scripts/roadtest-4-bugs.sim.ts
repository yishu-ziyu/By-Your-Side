import assert from "node:assert/strict";
import test from "node:test";
import { parseSelectionTable } from "../extension/src/shared/table-chart.js";
import { cleanGuideTargetName } from "../extension/src/shared/guide-intent.js";
import { GUIDE_CANVAS_STYLES } from "../extension/src/content/guide-canvas.js";

test("parseSelectionTable treats fiscal-year headers as column names and drops trailing summary totals", () => {
  const appleTable = [
    "按产品类别划分的营收（单位：亿美元）[3]",
    "类别\t2025财年\t2026财年\t同比变化\t占总营收比例",
    "iPhone\t2,095.86\t2,540.98\t+21%\t53.1%",
    "Mac\t337.08\t379.29\t+13%\t7.9%",
    "iPad\t280.23\t279.29\t持平\t5.8%",
    "可穿戴设备、家居及配件\t356.86\t355.77\t持平\t7.4%",
    "服务\t1,091.58\t1,233.01\t+13%\t25.8%",
    "合计\t4,161.61\t4,788.34\t+15%\t100%",
  ].join("\n");

  const parsed = parseSelectionTable(appleTable);
  assert.ok(parsed, "should parse Wikipedia financial table");
  assert.deepEqual(parsed.series.slice(0, 2).map((s) => s.name), ["2025财年", "2026财年"]);
  assert.equal(parsed.labels.includes("类别"), false, "header row must not become a data bar");
  assert.equal(parsed.labels.includes("合计"), false, "trailing total row must not squash component bars");
  assert.deepEqual(parsed.labels, ["iPhone", "Mac", "iPad", "可穿戴设备、家居及配件", "服务"]);
});

test("parseSelectionTable recognizes pure 4-digit year headers and keeps standard metric rows intact", () => {
  const yearHeaderTable = [
    "项目\t2024\t2025\t2026",
    "营业收入\t3,910.35\t4,161.61\t4,788.34",
    "毛利\t1,806.83\t1,952.01\t2,336.02",
  ].join("\n");

  const parsed = parseSelectionTable(yearHeaderTable);
  assert.ok(parsed);
  assert.deepEqual(parsed.series.map((s) => s.name), ["2024", "2025", "2026"]);
  assert.deepEqual(parsed.labels, ["营业收入", "毛利"]);

  const standard = parseSelectionTable([
    "年份\t风暴次数\t沉船",
    "1901\t12\t3",
    "1902\t18\t5",
    "1903\t9\t1",
    "1904\t24\t8",
  ].join("\n"));
  assert.ok(standard);
  assert.deepEqual(standard.series.map((s) => s.name), ["风暴次数", "沉船"]);
  assert.deepEqual(standard.labels, ["1901", "1902", "1903", "1904"]);
});

test("guide offscreen beacon hides when [hidden] is set and clips overflow cleanly", () => {
  assert.match(GUIDE_CANVAS_STYLES, /\.guide-offscreen-beacon\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  assert.match(GUIDE_CANVAS_STYLES, /\.guide-offscreen-beacon\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.equal(cleanGuideTargetName("Issues871 (871)"), "Issues");
  assert.equal(cleanGuideTargetName("Pull requests 717 (717)"), "Pull requests");
  assert.equal(cleanGuideTargetName("第 2 页"), "第 2 页");
});
