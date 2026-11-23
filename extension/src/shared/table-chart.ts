import {
  barMagnitudeRatio,
  linePoints,
  orderedSeriesData,
  recommendChartMode,
  renderChartExportSvg,
  summarizeSeries,
  tableToCsv,
  type ChartSortMode,
  type ChartViewMode,
  type SelectionTable,
} from "./table-chart-model.js";

export type { SelectionTable } from "./table-chart-model.js";

export const CHART_QUESTION = "这张表里的数字说明了什么？用一两句话说。";

const MAX_ROWS = 24;

const PLOT_HEIGHT = 104;

const SVG_NS = "http://www.w3.org/2000/svg";

const SCALE: Record<string, number> = { 万: 1e4, 亿: 1e8, k: 1e3, K: 1e3, m: 1e6, M: 1e6 };

const NUMBER = new RegExp(`^[¥￥$€£]?\\s*([+−-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*([%${Object.keys(SCALE).join("")}])?\\s*[^\\d\\s]{0,3}$`);

const PERIOD_CELL_RE = /^(?:(?:19|20)\d{2}\s*(?:财年|年度|年|Q[1-4])|(?:FY|CY)\s*\d{2,4}|Q[1-4](?:\s*(?:19|20)?\d{2})?|\d{1,2}月)$/i; // WHY: hardcode-ok calendar/fiscal labels like 2025财年 are column headers, not numeric metrics

const PLAIN_YEAR_RE = /^(?:19|20)\d{2}$/;

const SUMMARY_ROW_RE = /^(?:合计|总计|小计|汇总|总和|total|subtotal|sum|grand\s+total)(?:[\s（(].*)?$/i; // WHY: hardcode-ok trailing total rows skew component bar scales

const VIEW_LABELS: ReadonlyArray<{ mode: ChartViewMode; label: string }> = [
  { mode: "bar", label: "柱状" },
  { mode: "hbar", label: "横向" },
  { mode: "line", label: "折线" },
];

function numberOf(cell: string): number | null {
  const trimmed = cell.trim();

  if (PERIOD_CELL_RE.test(trimmed)) return null;
  const match = NUMBER.exec(trimmed);

  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, "").replace("−", "-"));

  return Number.isFinite(value) ? value * (SCALE[match[2] ?? ""] ?? 1) : null;
}

function isHeaderRow(rows: string[][]): boolean {
  const firstCols = rows[0]!.slice(1);

  if (firstCols.every((cell) => numberOf(cell) === null)) return true;
  const yearOrText = firstCols.some((cell) => PLAIN_YEAR_RE.test(cell))
    && firstCols.every((cell) => !cell || numberOf(cell) === null || PLAIN_YEAR_RE.test(cell));

  if (!yearOrText) return false;

  return rows.slice(1).some((row) => row.slice(1).some((cell) => numberOf(cell) !== null && !PLAIN_YEAR_RE.test(cell)));
}

function dropTrailingSummaryRow(body: string[][], width: number): string[][] {
  if (body.length < 3) return body;
  const last = body[body.length - 1]!;

  if (!SUMMARY_ROW_RE.test((last[0] ?? "").trim())) return body;

  for (let column = 1; column < width; column++) {
    const lastVal = numberOf(last[column] ?? "");

    if (lastVal === null) continue;
    const prevVals = body.slice(0, -1).map((row) => numberOf(row[column] ?? "")).filter((v): v is number => v !== null);

    if (prevVals.length < 2) continue;
    const maxPrev = Math.max(...prevVals.map(Math.abs));

    if (Math.abs(lastVal) >= maxPrev * 0.98) return body.slice(0, -1);
  }

  return body;
}

export function parseSelectionTable(text: string): SelectionTable | null {
  const rows = text.split("\n").map((line) => line.split("\t").map((cell) => cell.trim())).filter((row) => row.length > 1 && row.some(Boolean));

  if (rows.length < 2) return null;
  const headed = isHeaderRow(rows);
  const width = Math.max(...rows.map((row) => row.length));
  const body = dropTrailingSummaryRow(headed ? rows.slice(1) : rows, width);

  if (body.length < 2 || body.length > MAX_ROWS) return null;
  const series: SelectionTable["series"] = [];

  for (let column = 1; column < width; column++) {
    const cells = body.map((row) => row[column] ?? "");
    const values = cells.map(numberOf);
    const numeric = values.filter((value) => value !== null).length;

    if (numeric >= 2 && numeric * 2 > body.length) series.push({ name: (headed && rows[0]![column]) || `第 ${column + 1} 列`, cells, values });
  }

  return series.length ? { labels: body.map((row) => row[0] ?? ""), series } : null;
}

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);

  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));

  return el;
}

function renderVerticalBars(plot: HTMLElement, table: SelectionTable, seriesIndex: number, sort: ChartSortMode): void {
  const series = table.series[seriesIndex]!;
  const data = orderedSeriesData(table.labels, series, sort);
  const summary = summarizeSeries(data);
  plot.className = "plot";
  plot.replaceChildren();

  for (let i = 0; i < data.length; i++) {
    const datum = data[i]!;
    const column = document.createElement("div");

    if (summary && i === summary.maxIndex) column.classList.add("is-peak");
    if (datum.value !== null && datum.value < 0) column.classList.add("is-neg");
    const valueEl = document.createElement("b");
    valueEl.textContent = datum.cell;
    const bar = document.createElement("i");
    const ratio = barMagnitudeRatio(datum.value, summary);
    bar.style.height = `${ratio > 0 ? Math.max(4, Math.round(ratio * PLOT_HEIGHT)) : 0}px`;
    const name = document.createElement("span");
    name.textContent = datum.label;
    name.title = datum.label;
    column.append(valueEl, bar, name);
    plot.append(column);
  }
}

function renderHorizontalBars(plot: HTMLElement, table: SelectionTable, seriesIndex: number, sort: ChartSortMode): void {
  const series = table.series[seriesIndex]!;
  const data = orderedSeriesData(table.labels, series, sort);
  const summary = summarizeSeries(data);
  plot.className = "plot plot-hbar";
  plot.replaceChildren();

  for (let i = 0; i < data.length; i++) {
    const datum = data[i]!;
    const row = document.createElement("div");
    row.className = "hbar-row";

    if (summary && i === summary.maxIndex) row.classList.add("is-peak");
    if (datum.value !== null && datum.value < 0) row.classList.add("is-neg");
    const name = document.createElement("span");
    name.className = "hbar-label";
    name.textContent = datum.label;
    name.title = datum.label;
    const track = document.createElement("div");
    track.className = "hbar-track";
    const fill = document.createElement("i");
    const pct = Math.round(barMagnitudeRatio(datum.value, summary) * 100);
    fill.style.width = `${pct > 0 ? Math.max(3, pct) : 0}%`;
    track.append(fill);
    const valueEl = document.createElement("b");
    valueEl.className = "hbar-val";
    valueEl.textContent = datum.cell;
    row.append(name, track, valueEl);
    plot.append(row);
  }
}

function renderLineChart(plot: HTMLElement, table: SelectionTable, seriesIndex: number): void {
  const series = table.series[seriesIndex]!;
  const data = orderedSeriesData(table.labels, series, "source");
  const summary = summarizeSeries(data);
  plot.className = "plot plot-line";
  plot.replaceChildren();

  if (!summary) return;
  const width = Math.max(260, data.length * 56);
  const height = 148;
  const pts = linePoints(data, summary, width, height, 28, 28);
  const svg = svgNode("svg", { class: "line-svg", viewBox: `0 0 ${width} ${height}`, width, height });
  const baseLine = svgNode("line", { class: "line-axis", x1: 16, y1: height - 24, x2: width - 16, y2: height - 24 });
  svg.append(baseLine);

  if (pts.length >= 2) {
    const d = pts.map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const path = svgNode("path", { class: "line-path", d });
    svg.append(path);
  }

  for (const p of pts) {
    const dot = svgNode("circle", {
      class: p.index === summary.maxIndex ? "line-dot is-peak" : "line-dot",
      cx: p.x.toFixed(1),
      cy: p.y.toFixed(1),
      r: p.index === summary.maxIndex ? 4 : 3,
    });
    const val = svgNode("text", { class: "line-val", x: p.x.toFixed(1), y: (p.y - 9).toFixed(1), "text-anchor": "middle" });
    val.textContent = p.datum.cell;
    const lbl = svgNode("text", { class: "line-lbl", x: p.x.toFixed(1), y: height - 8, "text-anchor": "middle" });
    lbl.textContent = p.datum.label.length > 8 ? `${p.datum.label.slice(0, 7)}…` : p.datum.label;
    svg.append(dot, val, lbl);
  }

  plot.append(svg);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function svgToPngBlob(svgMarkup: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, img.naturalWidth * scale);
      canvas.height = Math.max(1, img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");

      if (!ctx) { URL.revokeObjectURL(url); resolve(null); return; }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => resolve(blob), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function flashButtonLabel(button: HTMLButtonElement, temp: string, rest: string): void {
  button.textContent = temp;
  setTimeout(() => { if (button.isConnected) button.textContent = rest; }, 1600);
}

export function renderSelectionChart(table: SelectionTable): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "chart";
  const head = document.createElement("div");
  head.className = "chart-head";
  const tabs = document.createElement("div");
  tabs.className = "seg";
  tabs.hidden = table.series.length < 2;
  const modes = document.createElement("div");
  modes.className = "chart-modes";
  const sortBtn = document.createElement("button");
  sortBtn.type = "button";
  sortBtn.className = "chart-sort";
  const plot = document.createElement("div");
  plot.className = "plot";
  plot.setAttribute("role", "img");
  const footRow = document.createElement("div");
  footRow.className = "chart-foot";
  const foot = document.createElement("div");
  foot.className = "chart-summary";
  const actions = document.createElement("div");
  actions.className = "chart-actions";
  const csvBtn = document.createElement("button");
  csvBtn.type = "button";
  csvBtn.className = "chart-export";
  csvBtn.textContent = "导出 CSV";
  const copyImgBtn = document.createElement("button");
  copyImgBtn.type = "button";
  copyImgBtn.className = "chart-export";
  copyImgBtn.textContent = "复制图";
  actions.append(csvBtn, copyImgBtn);
  footRow.append(foot, actions);

  let seriesIndex = 0;
  let viewMode: ChartViewMode = recommendChartMode(table);
  let sortMode: ChartSortMode = "source";

  const draw = () => {
    const series = table.series[seriesIndex]!;
    const activeSort: ChartSortMode = viewMode === "line" ? "source" : sortMode;

    if (viewMode === "hbar") renderHorizontalBars(plot, table, seriesIndex, activeSort);
    else if (viewMode === "line") renderLineChart(plot, table, seriesIndex);
    else renderVerticalBars(plot, table, seriesIndex, activeSort);

    for (const [at, tab] of [...tabs.children].entries()) tab.setAttribute("aria-pressed", String(at === seriesIndex));
    for (const btn of modes.querySelectorAll<HTMLButtonElement>("button")) btn.setAttribute("aria-pressed", String(btn.dataset.mode === viewMode));
    sortBtn.hidden = viewMode === "line" || table.labels.length < 3;
    sortBtn.setAttribute("aria-pressed", String(sortMode === "desc"));
    sortBtn.textContent = sortMode === "desc" ? "已降序" : "按值排序";

    const data = orderedSeriesData(table.labels, series, activeSort);
    const summary = summarizeSeries(data);

    if (summary && summary.count >= 3 && summary.maxIndex >= 0 && summary.minIndex >= 0) {
      const hi = data[summary.maxIndex]!;
      const lo = data[summary.minIndex]!;
      foot.hidden = false;
      foot.textContent = `最高 ${hi.label}（${hi.cell}） · 最低 ${lo.label}（${lo.cell}）`;
    } else foot.hidden = true;

    plot.setAttribute("aria-label", `${series.name}：${data.map((d) => `${d.label} ${d.cell}`).join("，")}`);
  };

  for (const [index, series] of table.series.entries()) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.textContent = series.name;
    tab.addEventListener("click", (event) => {
      event.stopPropagation();
      seriesIndex = index;
      draw();
    });
    tabs.append(tab);
  }

  for (const item of VIEW_LABELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.mode = item.mode;
    btn.textContent = item.label;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      viewMode = item.mode;
      draw();
    });
    modes.append(btn);
  }

  sortBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    sortMode = sortMode === "desc" ? "source" : "desc";
    draw();
  });

  csvBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const csv = `\uFEFF${tableToCsv(table)}`;
    const safeName = (table.series[seriesIndex]?.name || "chart").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 32) || "chart";
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${safeName}.csv`);
    flashButtonLabel(csvBtn, "已导出", "导出 CSV");
  });

  copyImgBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const svgMarkup = renderChartExportSvg(table, seriesIndex, viewMode, sortMode);

    if (!svgMarkup) return;
    void svgToPngBlob(svgMarkup).then(async (png) => {
      const safeName = (table.series[seriesIndex]?.name || "chart").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 32) || "chart";

      if (png && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
          flashButtonLabel(copyImgBtn, "已复制", "复制图");

          return;
        } catch {  }
      }

      if (png) {
        downloadBlob(png, `${safeName}.png`);
        flashButtonLabel(copyImgBtn, "已存 PNG", "复制图");
      } else {
        downloadBlob(new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" }), `${safeName}.svg`);
        flashButtonLabel(copyImgBtn, "已存 SVG", "复制图");
      }
    });
  });

  head.append(tabs, modes, sortBtn);
  figure.append(head, plot, footRow);
  requestAnimationFrame(draw);

  return figure;
}
