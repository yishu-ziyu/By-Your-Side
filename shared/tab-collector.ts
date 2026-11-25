export interface CollectedCell {
  value: string;
  quote: string;
}

export interface CollectedRow {
  tabId: number;
  url: string;
  title: string;
  cells: Record<string, CollectedCell>;
}

export interface CollectorSession {
  active: boolean;
  fields: string[];
  rows: CollectedRow[];
}

export class TabCollectorController {
  private session: CollectorSession = { active: false, fields: [], rows: [] };

  constructor(
    private readonly extractRow: (tabId: number, fields: string[]) => Promise<CollectedRow | null>,
    private readonly jumpToSource: (tabId: number, quote: string) => Promise<void>,
    private readonly onUpdate: (session: CollectorSession) => void,
  ) {}

  get snapshot(): CollectorSession {
    return this.session;
  }

  start(fields: string[]): void {
    const cleaned = fields.map((f) => f.trim()).filter(Boolean).slice(0, 6);
    this.session = { active: cleaned.length > 0, fields: cleaned, rows: [] };
    this.onUpdate(this.session);
  }

  stop(): void {
    this.session = { ...this.session, active: false };
    this.onUpdate(this.session);
  }

  async onTabVisited(tabId: number, url: string): Promise<boolean> {
    if (!this.session.active) return false;
    if (!/^https?:\/\//i.test(url)) return false;
    if (this.session.rows.some((row) => row.url === url)) return false;

    const row = await this.extractRow(tabId, this.session.fields);
    if (!row) return false;
    this.session = { ...this.session, rows: [...this.session.rows, row] };
    this.onUpdate(this.session);
    return true;
  }

  async inspectCell(row: CollectedRow, field: string): Promise<boolean> {
    const cell = row.cells[field];
    if (!cell?.quote) return false;
    await this.jumpToSource(row.tabId, cell.quote);
    return true;
  }
}
