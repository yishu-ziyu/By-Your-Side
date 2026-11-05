export const PROGRAM_WAIT_BUDGET_MS = 10 * 60_000;

export class ProgramBudget {
  private readonly activeUntil: number;
  private waited = 0;

  constructor(private readonly now: () => number, activeMs: number, private readonly waitBudgetMs = PROGRAM_WAIT_BUDGET_MS) {
    this.activeUntil = now() + activeMs;
  }

  get deadline(): number { return this.activeUntil + this.waited; }

  expired(): boolean { return this.now() >= this.deadline; }

  waitBudgetUsed(): boolean { return this.waited >= this.waitBudgetMs; }

  creditWait(ms: number): void { this.waited = Math.min(this.waitBudgetMs, this.waited + Math.max(0, ms)); }
}
