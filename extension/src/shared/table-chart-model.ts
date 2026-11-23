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

  if (labels.length >= 3) {
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
