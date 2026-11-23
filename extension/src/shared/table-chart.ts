import {
  barMagnitudeRatio,
  linePoints,
  orderedSeriesData,
  recommendChartMode,
  summarizeSeries,
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

const VIEW_LABELS: ReadonlyArray<{ mode: ChartViewMode; label: string }> = [
  { mode: "bar", label: "柱状" },
  { mode: "hbar", label: "横向" },
  { mode: "line", label: "折线" },
];

function numberOf(cell: string): number | null {
  const match = NUMBER.exec(cell.trim());

  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, "").replace("−", "-"));

  return Number.isFinite(value) ? value * (SCALE[match[2] ?? ""] ?? 1) : null;
}

export function parseSelectionTable(text: string): SelectionTable | null {
  const rows = text.split("\n").map((line) => line.split("\t").map((cell) => cell.trim())).filter((row) => row.length > 1 && row.some(Boolean));

  if (rows.length < 2) return null;
  const headed = rows[0]!.slice(1).every((cell) => numberOf(cell) === null);
  const body = headed ? rows.slice(1) : rows;

  if (body.length < 2 || body.length > MAX_ROWS) return null;
  const width = Math.max(...rows.map((row) => row.length));
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

export function renderSelectionChart(table: SelectionTable): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "chart";
  const head = document.createElement("div");
  head.className = "chart-head";
  const tabs = document.createElement("div");
  tabs.className = "seg";
  tabs.hidden = table.series.length < 2;
  const modes = document.createElement("div");
  modes.className = "seg chart-modes";
  const sortBtn = document.createElement("button");
  sortBtn.type = "button";
  sortBtn.className = "chart-sort";
  const plot = document.createElement("div");
  plot.className = "plot";
  plot.setAttribute("role", "img");
  const foot = document.createElement("div");
  foot.className = "chart-summary";

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

  head.append(tabs, modes, sortBtn);
  figure.append(head, plot, foot);
  requestAnimationFrame(draw);

  return figure;
}
