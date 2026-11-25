import type { PageTransformAction } from "../../../shared/page-phase2.js";
import { cssPathOf } from "../shared/css-path.js";

interface UndoRecord {
  restore: () => void;
}

const TRANSFORM_UI_ATTR = "data-sideagent-transform-ui";
const SITE_SORTS_ITSELF = ".sortable, .tablesorter, .dataTable, [data-sortable]";
const REGIONS = "nav, aside, header, footer, [role=navigation], [role=complementary], [role=banner], [role=contentinfo]";

function queryAll(selector: string): HTMLElement[] {
  try {
    return [...document.querySelectorAll<HTMLElement>(selector)];
  } catch {
    return [];
  }
}

function keepAttribute(el: Element, name: string): () => void {
  const before = el.getAttribute(name);

  return () => {
    if (before === null) el.removeAttribute(name);
    else el.setAttribute(name, before);
  };
}

function squash(text: string | null | undefined, max = 30): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function shown(el: Element): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function describe(el: HTMLElement): string {
  const label = squash(el.getAttribute("aria-label") || el.innerText, 24);

  return `${cssPathOf(el)}${label ? `「${label}」` : ""}${shown(el) ? "" : " (not visible now)"}`;
}

function describeHidden(el: HTMLElement, all: HTMLElement[]): string {
  const region = el.parentElement?.closest<HTMLElement>(REGIONS);
  const stays = region && shown(region) && !all.some((other) => other === region || other.contains(region));

  return `${describe(el)}${stays ? ` — only part of ${describe(region)}, which stays visible` : ""}`;
}

function pageRegions(): string {
  return queryAll(REGIONS).filter((el) => !el.parentElement?.closest(REGIONS)).slice(0, 10).map(describe).join(", ") || "none found";
}

function tableName(table: HTMLTableElement): string {
  const head = table.tHead?.rows[0] ?? table.rows[0];
  return squash(table.caption?.innerText) || squash(head ? [...head.cells].map((cell) => cell.innerText.trim()).filter(Boolean).join(" | ") : "", 60) || "未命名表格";
}

function usableTables(nodes: HTMLElement[]): HTMLTableElement[] {
  return [...new Set(nodes.map((el) => el.closest("table")))].filter((el): el is HTMLTableElement => !!el?.tBodies[0] && shown(el));
}

function sortKey(cell: HTMLTableCellElement | undefined): { text: string; value: number } {
  const text = cell?.innerText.trim() ?? "";

  return { text, value: text ? parseFloat(text.replace(/[,，¥$€£\s]/g, "")) : NaN };
}

export class PageTransformLedger {
  private readonly records: UndoRecord[] = [];
  private readonly enhanced = new Set<HTMLTableElement>();

  applyMany(actions: PageTransformAction[]): { affected: number; counts: number[]; report: string[] } {
    const report: string[] = [];
    const counts = actions.map((action) => this.apply(action, report));

    return { affected: counts.reduce((sum, n) => sum + n, 0), counts, report };
  }

  restoreAll(): number {
    const count = this.records.length;
    while (this.records.length > 0) {
      this.records.pop()!.restore();
    }
    this.enhanced.clear();
    return count;
  }

  get count(): number {
    return this.records.length;
  }

  private apply(action: PageTransformAction, report: string[]): number {
    if (action.type === "enhance_table") return this.enhanceTable(action.selector, action.text, report);
    const nodes = queryAll(action.selector);

    if (nodes.length === 0) {
      report.push(`${action.type} "${action.selector}": nothing matched. Page regions: ${pageRegions()}`);
      return 0;
    }
    report.push(`${action.type} "${action.selector}": ${nodes.slice(0, 4).map((el) => describeHidden(el, nodes)).join(", ")}${nodes.length > 4 ? ` and ${nodes.length - 4} more` : ""}`);

    return action.type === "hide_elements" ? this.hideElements(nodes) : this.collapseElements(nodes, action.label);
  }

  private hideElements(nodes: HTMLElement[]): number {
    for (const el of nodes) {
      const restore = keepAttribute(el, "style");
      el.style.setProperty("display", "none", "important");
      this.records.push({ restore });
    }
    return nodes.length;
  }

  private collapseElements(nodes: HTMLElement[], label = "展开已折叠内容"): number {
    for (const el of nodes) {
      const restoreStyle = keepAttribute(el, "style");
      const prevDisplay = el.style.display;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.setAttribute(TRANSFORM_UI_ATTR, "collapse");
      toggle.textContent = label;
      toggle.style.cssText = "display:inline-block;margin:4px 0;padding:4px 10px;border:1px solid rgba(15,23,42,.18);border-radius:6px;background:#fbf8f1;color:#1f2328;font:12px/1.4 sans-serif;cursor:pointer;";
      let collapsed = true;
      el.style.display = "none";
      el.parentElement?.insertBefore(toggle, el);

      toggle.addEventListener("click", () => {
        collapsed = !collapsed;
        el.style.display = collapsed ? "none" : prevDisplay;
        toggle.textContent = collapsed ? label : "收起内容";
      });

      this.records.push({
        restore: () => {
          toggle.remove();
          restoreStyle();
        },
      });
    }
    return nodes.length;
  }

  private enhanceTable(selector: string, text: string | undefined, report: string[]): number {
    const byText = selector.startsWith("text=") ? selector.slice("text=".length).trim() : "";
    const wanted = (text || byText).replace(/\s+/g, "");
    const fromSelector = byText ? [] : usableTables(queryAll(selector));
    const tables = fromSelector.length > 0 ? fromSelector : wanted ? usableTables(queryAll("table")) : [];
    const table = wanted ? tables.find((item) => `${item.caption?.innerText ?? ""}${item.rows[0]?.innerText ?? ""}`.replace(/\s+/g, "").includes(wanted)) : tables[0];
    const tbody = table?.tBodies[0];

    if (!table || !tbody) {
      const onPage = usableTables(queryAll("table")).slice(0, 8).map((item) => `「${tableName(item)}」`).join("");
      report.push(`enhance_table "${selector}"${text ? ` text "${text}"` : ""}: no table matched; visible tables on this page: ${onPage || "none"}`);
      return 0;
    }
    if (this.enhanced.has(table)) {
      report.push(`enhance_table "${selector}": 「${tableName(table)}」 is already sortable and filterable`);
      return 0;
    }
    const others = tables.filter((item) => item !== table).slice(0, 8).map((item) => `「${tableName(item)}」`).join("");
    this.enhanced.add(table);
    report.push(`enhance_table "${selector}": made 「${tableName(table)}」 (${tbody.rows.length} rows) sortable and filterable${others ? `; other tables this selector matches: ${others} — pass text to pick one of them` : ""}`);

    const originalRows = [...tbody.rows];
    const originalNodes = [...tbody.childNodes];
    const headInBody = !table.tHead && originalRows[0] && [...originalRows[0].cells].every((cell) => cell.tagName === "TH") ? originalRows[0] : null;
    const headRow = table.tHead?.rows[table.tHead.rows.length - 1] ?? headInBody;
    const dataRows = (): HTMLTableRowElement[] => [...tbody.rows].filter((row) => row !== headInBody);
    const sortable = !!headRow && !table.matches(SITE_SORTS_ITSELF) && !table.querySelector("[rowspan], [colspan]");
    const cleanups: Array<() => void> = [];

    const bar = document.createElement("div");
    bar.setAttribute(TRANSFORM_UI_ATTR, "table-filter");
    bar.style.cssText = "display:flex;gap:8px;align-items:center;margin:6px 0;font:12px/1.4 sans-serif;";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "筛选表格内容…";
    input.style.cssText = "padding:4px 8px;border:1px solid rgba(15,23,42,.2);border-radius:6px;background:#fff;color:#111;font:inherit;";
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.textContent = "恢复原表";
    restoreBtn.style.cssText = "padding:4px 10px;border:1px solid rgba(15,23,42,.18);border-radius:6px;background:#fbf8f1;color:#1f2328;cursor:pointer;font:inherit;";

    const rowStyles = originalRows.map((row) => keepAttribute(row, "style"));
    const rowDisplays = new Map<HTMLTableRowElement, string>();
    for (const row of originalRows) rowDisplays.set(row, row.style.display);

    const onFilter = () => {
      const q = input.value.trim().toLowerCase();
      for (const row of dataRows()) {
        const match = !q || row.innerText.toLowerCase().includes(q);
        row.style.display = match ? (rowDisplays.get(row) ?? "") : "none";
      }
    };
    input.addEventListener("input", onFilter);
    bar.append(input, restoreBtn);
    table.parentElement?.insertBefore(bar, table);
    const shift = table.getBoundingClientRect().left - bar.getBoundingClientRect().left;
    if (shift > 0) bar.style.marginLeft = `${Math.round(shift)}px`;

    if (sortable && headRow) {
      const headers = [...headRow.cells];

      headers.forEach((th, colIdx) => {
        let asc = true;
        const restoreStyle = keepAttribute(th, "style");
        const restoreSort = keepAttribute(th, "aria-sort");
        th.style.cursor = "pointer";
        const onClick = () => {
          const sorted = dataRows().sort((a, b) => {
            const ak = sortKey(a.cells[colIdx]);
            const bk = sortKey(b.cells[colIdx]);
            const cmp = Number.isFinite(ak.value) && Number.isFinite(bk.value) && ak.value !== bk.value
              ? ak.value - bk.value
              : ak.text.localeCompare(bk.text, "zh", { numeric: true });
            return asc ? cmp : -cmp;
          });
          for (const other of headers) other.removeAttribute("aria-sort");
          th.setAttribute("aria-sort", asc ? "ascending" : "descending");
          asc = !asc;
          tbody.replaceChildren(...(headInBody ? [headInBody] : []), ...sorted);
        };
        th.addEventListener("click", onClick);
        cleanups.push(() => {
          th.removeEventListener("click", onClick);
          restoreSort();
          restoreStyle();
        });
      });
    }

    const restoreThis = () => {
      input.removeEventListener("input", onFilter);
      bar.remove();
      cleanups.forEach((fn) => fn());
      rowStyles.forEach((fn) => fn());
      tbody.replaceChildren(...originalNodes);
      this.enhanced.delete(table);
    };

    restoreBtn.addEventListener("click", restoreThis);
    this.records.push({ restore: restoreThis });
    return 1;
  }
}
