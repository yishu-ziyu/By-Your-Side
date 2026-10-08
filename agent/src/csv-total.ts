/**
 * 只核算完整、带唯一末尾合计行的非负整数数量表。
 * 有小计、平均、百分比、负数或不完整行时不推断加法关系。
 */
export interface CsvTotalMismatch { column: string; reported: number; calculated: number }

export function parseCsvRecords(content: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    if (ch === '"') {
      if (quoted && content[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(field); field = ""; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }

  if (quoted) return null;

  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function csvTotalMismatches(content: string): CsvTotalMismatch[] {
  if (content.length > 12_000) return [];
  const rows = parseCsvRecords(content);
  if (!rows) return [];

  const table = rows.flatMap(r => r.some(cell => cell.trim()) ? [r.map(cell => cell.trim().replace(/^\uFEFF/, ""))] : []);
  const header = table[0], total = table.at(-1);

  if (!header || !total || table.length < 3 || !/^(合计|总计|total|grand total)$/i.test(total[0] ?? "")) return [];
  const body = table.slice(1, -1);

  if (table.some(r => r.length !== header.length) || body.some(r => !r[0] || /合计|总计|小计|平均|比例|百分比|subtotal|total|average|percent/i.test(r[0]!))) return [];
  const mismatches: CsvTotalMismatch[] = [];

  for (let i = 1; i < header.length; i++) {
    if (!/^(数量|计数|count|quantity)$/i.test(header[i]!)) continue;
    const values = [...body.map(r => r[i]!), total[i]!];

    if (!values.every(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))) continue;
    const calculated = body.reduce((sum, r) => sum + Number(r[i]), 0);
    const reported = Number(total[i]);

    if (Number.isSafeInteger(calculated) && calculated !== reported) mismatches.push({ column: header[i]!, reported, calculated });
  }

  return mismatches;
}
