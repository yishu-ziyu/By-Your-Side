import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  barMagnitudeRatio,
  linePoints,
  orderedSeriesData,
  recommendChartMode,
  renderChartExportSvg,
  summarizeSeries,
  tableToCsv,
} from "../extension/src/shared/table-chart-model.js";
import { parseSelectionTable } from "../extension/src/shared/table-chart.js";
import { appStreamProgress, cardFormulaAudit, splitAnswer } from "../shared/answer-cards.js";

describe("multi-view table chart model and parsing", () => {
  it("parses negative numbers, currency, percentages, and Chinese units", () => {
    const raw = [
      "季度\t营收\t同比",
      "2026 Q1\t¥120万\t+14.2%",
      "2026 Q2\t¥138万\t−5.4%",
      "2026 Q3\t¥156万\t+18.0%",
    ].join("\n");
    const table = parseSelectionTable(raw);
    assert.ok(table);
    assert.equal(table.series.length, 2);
    assert.deepEqual(table.series[0]!.values, [1200000, 1380000, 1560000]);
    assert.deepEqual(table.series[1]!.values, [14.2, -5.4, 18]);

    const growthSummary = summarizeSeries(orderedSeriesData(table.labels, table.series[1]!, "source"));
    assert.ok(growthSummary);
    assert.equal(growthSummary.hasNegative, true);
    assert.ok(barMagnitudeRatio(-5.4, growthSummary) > 0.25);
  });

  it("recommends line for 5+ time points, hbar for long Chinese labels, and bar otherwise", () => {
    const timeTable = parseSelectionTable("月份\t销量\n1月\t10\n2月\t20\n3月\t15\n4月\t24\n5月\t28")!;
    assert.equal(recommendChartMode(timeTable), "line");

    const shortTimeTable = parseSelectionTable("年份\t次数\n1901\t12\n1902\t18\n1903\t9\n1904\t24")!;
    assert.equal(recommendChartMode(shortTimeTable), "bar");

    const longTable = parseSelectionTable("方案名称\t月费\n企业安全增强标准版\t299\n团队协作基础进阶版\t199\n个人精简体验版\t49")!;
    assert.equal(recommendChartMode(longTable), "hbar");

    const shortTable = parseSelectionTable("城市\t温度\n北京\t22\n上海\t26\n深圳\t30")!;
    assert.equal(recommendChartMode(shortTable), "bar");
  });

  it("sorts descending without mutating original order and generates finite line coordinates", () => {
    const table = parseSelectionTable("项\t值\n甲\t12\n乙\t48\n丙\t25")!;
    const sorted = orderedSeriesData(table.labels, table.series[0]!, "desc");
    assert.deepEqual(sorted.map((d) => d.label), ["乙", "丙", "甲"]);
    assert.deepEqual(table.labels, ["甲", "乙", "丙"]);

    const summary = summarizeSeries(sorted)!;
    const pts = linePoints(sorted, summary, 300, 148);
    assert.equal(pts.length, 3);
    assert.ok(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  });

  it("exports RFC-4180 CSV and valid self-contained SVGs across all chart modes", () => {
    const table = parseSelectionTable('地区\t销售额\t增长\n华东,北区\t¥120万\t+12%\n华南 "核心"\t¥80万\t-4%\n华西\t¥95万\t+6%')!;
    const csv = tableToCsv(table);
    assert.equal(csv.split("\n")[0], "项目,销售额,增长");
    assert.ok(csv.includes('"华东,北区",¥120万,+12%'));
    assert.ok(csv.includes('"华南 ""核心""",¥80万,-4%'));

    for (const mode of ["bar", "hbar", "line"] as const) {
      const svg = renderChartExportSvg(table, 1, mode, "desc");
      assert.ok(svg.startsWith("<svg "));
      assert.ok(svg.endsWith("</svg>"));
      assert.ok(svg.includes("增长"));
      assert.ok(!svg.includes("NaN"));
    }
  });
});

describe("mini-app streaming progress and card formula audit", () => {
  it("tracks streaming progress stages across incomplete app HTML", () => {
    assert.equal(appStreamProgress("<div>").stage, "正在搭界面结构…");
    const styled = appStreamProgress("<style>body{}</style><canvas id=c></canvas><input type=range>");
    assert.ok(styled.parts.includes("样式") && styled.parts.includes("图表画布") && styled.parts.includes("交互控件"));
    assert.equal(appStreamProgress("<style></style><script>const x = 1").stage, "正在写交互与计算逻辑…");
    assert.equal(appStreamProgress("<style></style><script>const x = 1</script>").stage, "正在收尾校验…");
  });

  it("distinguishes verified host formulas from broken formulas", () => {
    const okParts = splitAnswer('<card title="月供">\n<input id="p" label="本金" value="100" unit="万" />\n<stat id="m" label="估算" value="=p*50" unit="元" />\n</card>');
    const okCard = okParts.find((p): p is { card: NonNullable<ReturnType<typeof splitAnswer>[number] extends { card?: infer C } ? C : never> } => "card" in p && Boolean(p.card))!.card;
    const okAudit = cardFormulaAudit(okCard);
    assert.equal(okAudit.verifiedCount, 1);
    assert.deepEqual(okAudit.brokenLabels, []);

    const badParts = splitAnswer('<card title="房贷">\n<stat label="月供" value="=unknown_fn(100)" unit="元" />\n</card>');
    const badCard = badParts.find((p): p is { card: NonNullable<ReturnType<typeof splitAnswer>[number] extends { card?: infer C } ? C : never> } => "card" in p && Boolean(p.card))!.card;
    const badAudit = cardFormulaAudit(badCard);
    assert.equal(badAudit.verifiedCount, 0);
    assert.deepEqual(badAudit.brokenLabels, ["月供"]);
  });
});
