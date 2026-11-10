export const CHART_QUESTION = '这张表里的数字说明了什么？用一两句话说。';

export interface SelectionTable {
  labels: string[];
  series: Array<{ name: string; cells: string[]; values: Array<number | null> }>;
}

const MAX_ROWS = 24;

const PLOT_HEIGHT = 104;

const SCALE: Record<string, number> = { 万: 1e4, 亿: 1e8, k: 1e3, K: 1e3, m: 1e6, M: 1e6 };

function numberOf(cell: string): number | null {
  const match = /^[¥$€£]?\s*(-?\d[\d,]*(?:\.\d+)?)\s*([%万亿kKmM])?$/.exec(cell.trim());

  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ''));

  return Number.isFinite(value) ? value * (SCALE[match[2] ?? ''] ?? 1) : null;
}

export function parseSelectionTable(text: string): SelectionTable | null {
  const rows = text.split('\n').map(line => line.split('\t').map(cell => cell.trim())).filter(row => row.length > 1 && row.some(Boolean));

  if (rows.length < 2) return null;
  const headed = rows[0]!.slice(1).every(cell => numberOf(cell) === null);
  const body = headed ? rows.slice(1) : rows;

  if (body.length < 2 || body.length > MAX_ROWS) return null;
  const width = Math.max(...rows.map(row => row.length));
  const series: SelectionTable['series'] = [];

  for (let column = 1; column < width; column++) {
    const cells = body.map(row => row[column] ?? '');
    const values = cells.map(numberOf);
    const numeric = values.filter(value => value !== null).length;

    if (numeric >= 2 && numeric * 2 > body.length) series.push({ name: (headed && rows[0]![column]) || `第 ${column + 1} 列`, cells, values });
  }

  return series.length ? { labels: body.map(row => row[0] ?? ''), series } : null;
}

export function renderSelectionChart(table: SelectionTable): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'chart';
  const tabs = document.createElement('div');
  tabs.className = 'seg';
  tabs.hidden = table.series.length < 2;
  const plot = document.createElement('div');
  plot.className = 'plot';
  const columns = table.labels.map(label => {
    const column = document.createElement('div');
    const value = document.createElement('b');
    const bar = document.createElement('i');
    const name = document.createElement('span');
    name.textContent = label;
    name.title = label;
    column.append(value, bar, name);
    plot.append(column);

    return { value, bar };
  });

  const draw = (index: number) => {
    const series = table.series[index]!;
    const max = Math.max(...series.values.map(value => value ?? 0), 0);

    for (const [row, column] of columns.entries()) {
      const value = series.values[row] ?? null;
      column.value.textContent = series.cells[row] ?? '';
      column.bar.style.height = `${value !== null && max > 0 ? Math.max(2, Math.round(Math.max(0, value) / max * PLOT_HEIGHT)) : 0}px`;
    }

    for (const [at, tab] of [...tabs.children].entries()) tab.setAttribute('aria-pressed', String(at === index));
    plot.setAttribute('aria-label', `${series.name}：${table.labels.map((label, row) => `${label} ${series.cells[row] ?? ''}`).join('，')}`);
  };

  for (const [index, series] of table.series.entries()) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.textContent = series.name;
    tab.addEventListener('click', event => {
      event.stopPropagation();
      draw(index);
    });
    tabs.append(tab);
  }

  plot.setAttribute('role', 'img');
  figure.append(tabs, plot);
  requestAnimationFrame(() => draw(0));

  return figure;
}
