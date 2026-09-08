export interface BudgetObservation {
  budget: number;
  prices: number[];
  sort?: string;
}
export function judgeBudgetRun(input: {
  mode: string;
  baseline?: BudgetObservation;
  page?: BudgetObservation;
  starts: number;
  receipts: number;
  receiptAt?: number;
  firstAudioAt?: number;
}): {checks: Record<string, boolean>; ok: boolean};
