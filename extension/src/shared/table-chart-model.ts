export type ChartViewMode = "bar" | "hbar" | "line";

export type ChartSortMode = "source" | "desc";

export interface ChartSeries {
  name: string;
  cells: string[];
  values: Array<number | null>;
}

export interface SelectionTable {
  labels: string[];
  series: ChartSeries[];
}

export interface ChartDatum {
  index: number;
  label: string;
  cell: string;
  value: number | null;
}

export interface SeriesSummary {
  max: number;
  min: number;
  maxIndex: number;
  minIndex: number;
  hasNegative: boolean;
  count: number;
}

const TIME_LABEL_RE = /^(?:(?:19|20)\d{2}(?:[年/-]\d{1,2})?|Q[1-4]|第?[一二三四1-4]季度|\d{1,2}月|周[一二三四五六日天]|星期[一二三四五六日天]|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\d{1,2}[/-]\d{1,2})$/i;

export function recommendChartMode(table: SelectionTable): ChartViewMode {
  const labels = table.labels.map((label) => label.trim()).filter(Boolean);

  // WHY: 2-4 discrete periods read more clearly as vertical comparison bars (and preserve bar-first expectations); switch to trend lines automatically from 5+ time points.
  if (labels.length >= 5) {
    const timeHits = labels.filter((label) => TIME_LABEL_RE.test(label)).length;

    if (timeHits * 2 >= labels.length) return "line";
  }

  const avgLen = labels.length ? labels.reduce((sum, label) => sum + label.length, 0) / labels.length : 0;

  if (avgLen >= 6 || labels.length >= 7) return "hbar";

  return "bar";
}

export function orderedSeriesData(
  labels: readonly string[],
  series: ChartSeries,
  sort: ChartSortMode,
): ChartDatum[] {
  const rows: ChartDatum[] = labels.map((label, index) => ({
    index,
    label,
    cell: series.cells[index] ?? "",
    value: series.values[index] ?? null,
  }));

  if (sort !== "desc") return rows;

  return [...rows].sort((a, b) => {
    if (a.value === null && b.value === null) return a.index - b.index;
    if (a.value === null) return 1;
    if (b.value === null) return -1;

    return b.value - a.value || a.index - b.index;
  });
}

export function summarizeSeries(data: readonly ChartDatum[]): SeriesSummary | null {
  let max = -Infinity;
  let min = Infinity;
  let maxIndex = -1;
  let minIndex = -1;
  let count = 0;

  for (let i = 0; i < data.length; i++) {
    const value = data[i]!.value;

    if (value === null || !Number.isFinite(value)) continue;
    count += 1;

    if (value > max) { max = value; maxIndex = i; }
    if (value < min) { min = value; minIndex = i; }
  }

  if (count === 0) return null;

  return { max, min, maxIndex, minIndex, hasNegative: min < 0, count };
}

export function barMagnitudeRatio(value: number | null, summary: SeriesSummary | null): number {
  if (value === null || !summary) return 0;
  const peak = Math.max(Math.abs(summary.max), Math.abs(summary.min));

  if (peak <= 0) return 0;

  return Math.min(1, Math.abs(value) / peak);
}

export function linePoints(
  data: readonly ChartDatum[],
  summary: SeriesSummary,
  width: number,
  height: number,
  padX = 24,
  padY = 22,
): Array<{ x: number; y: number; datum: ChartDatum; index: number }> {
  const usableW = Math.max(1, width - padX * 2);
  const usableH = Math.max(1, height - padY * 2);
  const span = summary.max - summary.min;
  const stepX = data.length > 1 ? usableW / (data.length - 1) : 0;
  const out: Array<{ x: number; y: number; datum: ChartDatum; index: number }> = [];

  for (let i = 0; i < data.length; i++) {
    const datum = data[i]!;

    if (datum.value === null) continue;
    const x = data.length > 1 ? padX + stepX * i : width / 2;
    const ratio = span > 0 ? (datum.value - summary.min) / span : 0.5;
    const y = padY + (1 - ratio) * usableH;
    out.push({ x, y, datum, index: i });
  }

  return out;
}

function csvEscape(cell: string): string {
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function tableToCsv(table: SelectionTable): string {
  const header = ["项目", ...table.series.map((s) => s.name)].map(csvEscape).join(",");
  const rows = table.labels.map((label, rowIndex) =>
    [label, ...table.series.map((s) => s.cells[rowIndex] ?? "")].map(csvEscape).join(","),
  );

  return [header, ...rows].join("\n");
}

function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

function clipLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function renderChartExportSvg(
  table: SelectionTable,
  seriesIndex: number,
  viewMode: ChartViewMode,
  sortMode: ChartSortMode,
): string {
  const series = table.series[seriesIndex] ?? table.series[0];

  if (!series) return "";
  const activeSort: ChartSortMode = viewMode === "line" ? "source" : sortMode;
  const data = orderedSeriesData(table.labels, series, activeSort);
  const summary = summarizeSeries(data);
  const padX = 28;
  const titleY = 30;
  const font = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif';
  let width = 560;
  let height = 280;
  let body = "";

  if (viewMode === "hbar") {
    const rowH = 30;
    height = Math.max(160, 82 + data.length * rowH);
    const trackX = 148;
    const trackW = width - trackX - 96;

    for (let i = 0; i < data.length; i++) {
      const d = data[i]!;
      const y = 58 + i * rowH;
      const ratio = barMagnitudeRatio(d.value, summary);
      const fillW = ratio > 0 ? Math.max(4, Math.round(ratio * trackW)) : 0;
      const color = d.value !== null && d.value < 0 ? "#b74536" : "#2d4a86";
      const opacity = summary && i === summary.maxIndex ? "1" : "0.78";
      body += `<text x="${padX}" y="${y + 13}" fill="#484640" font-size="12" font-family='${font}'>${xmlEscape(clipLabel(d.label, 12))}</text>`;
      body += `<rect x="${trackX}" y="${y + 3}" width="${trackW}" height="12" rx="6" fill="#ece8de"/>`;
      body += `<rect x="${trackX}" y="${y + 3}" width="${fillW}" height="12" rx="6" fill="${color}" fill-opacity="${opacity}"/>`;
      body += `<text x="${width - padX}" y="${y + 13}" text-anchor="end" fill="#141413" font-size="12" font-weight="600" font-family='${font}'>${xmlEscape(d.cell)}</text>`;
    }
  } else if (viewMode === "line" && summary) {
    width = Math.max(520, data.length * 76 + padX * 2);
    height = 250;
    const pts = linePoints(data, summary, width - padX * 2, 136, 26, 26).map((p) => ({ ...p, x: p.x + padX, y: p.y + 46 }));
    body += `<line x1="${padX}" y1="186" x2="${width - padX}" y2="186" stroke="rgba(20,20,19,0.14)" stroke-width="1"/>`;

    if (pts.length >= 2) {
      const dPath = pts.map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
      body += `<path d="${dPath}" fill="none" stroke="#2d4a86" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    for (const p of pts) {
      const peak = p.index === summary.maxIndex;
      body += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${peak ? 4.5 : 3.5}" fill="${peak ? "#2d4a86" : "#fbfaf7"}" stroke="#2d4a86" stroke-width="2"/>`;
      body += `<text x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}" text-anchor="middle" fill="#141413" font-size="11.5" font-weight="600" font-family='${font}'>${xmlEscape(p.datum.cell)}</text>`;
      body += `<text x="${p.x.toFixed(1)}" y="204" text-anchor="middle" fill="#6d695f" font-size="11" font-family='${font}'>${xmlEscape(clipLabel(p.datum.label, 9))}</text>`;
    }
  } else {
    width = Math.max(520, data.length * 72 + padX * 2);
    height = 264;
    const baseY = 198;
    const maxBarH = 124;
    const slotW = (width - padX * 2) / Math.max(1, data.length);
    const barW = Math.min(44, Math.max(18, slotW * 0.56));
    body += `<line x1="${padX}" y1="${baseY}" x2="${width - padX}" y2="${baseY}" stroke="rgba(20,20,19,0.14)" stroke-width="1"/>`;

    for (let i = 0; i < data.length; i++) {
      const d = data[i]!;
      const cx = padX + slotW * (i + 0.5);
      const ratio = barMagnitudeRatio(d.value, summary);
      const barH = ratio > 0 ? Math.max(4, Math.round(ratio * maxBarH)) : 0;
      const color = d.value !== null && d.value < 0 ? "#b74536" : "#2d4a86";
      const opacity = summary && i === summary.maxIndex ? "1" : "0.78";
      body += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${baseY - barH}" width="${barW.toFixed(1)}" height="${barH}" rx="5" fill="${color}" fill-opacity="${opacity}"/>`;
      body += `<text x="${cx.toFixed(1)}" y="${baseY - barH - 7}" text-anchor="middle" fill="#141413" font-size="11.5" font-weight="600" font-family='${font}'>${xmlEscape(d.cell)}</text>`;
      body += `<text x="${cx.toFixed(1)}" y="${baseY + 18}" text-anchor="middle" fill="#6d695f" font-size="11" font-family='${font}'>${xmlEscape(clipLabel(d.label, 9))}</text>`;
    }
  }

  const footText = summary && summary.count >= 3 && summary.maxIndex >= 0 && summary.minIndex >= 0
    ? `最高 ${data[summary.maxIndex]!.label}（${data[summary.maxIndex]!.cell}） · 最低 ${data[summary.minIndex]!.label}（${data[summary.minIndex]!.cell}）`
    : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" rx="12" fill="#fbfaf7"/>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="none" stroke="rgba(20,20,19,0.1)"/>`,
    `<text x="${padX}" y="${titleY}" fill="#141413" font-size="14" font-weight="700" font-family='${font}'>${xmlEscape(series.name)}</text>`,
    body,
    footText ? `<text x="${padX}" y="${height - 16}" fill="#6d695f" font-size="11" font-family='${font}'>${xmlEscape(footText)}</text>` : "",
    `</svg>`,
  ].join("");
}
