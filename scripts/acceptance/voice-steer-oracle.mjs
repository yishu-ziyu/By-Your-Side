export function judgeBudgetRun({mode, baseline, page, starts, receipts, receiptAt, firstAudioAt}) {
  const checks = {
    baseline: baseline?.budget === 1000 && JSON.stringify(baseline.prices) === '[899,699,799]',
    budget: page?.budget === 800,
    prices: JSON.stringify(page?.prices) === '[699,799]',
    sort: page?.sort === 'asc',
    singleStart: starts === 1,
    receipt: mode === 'text' || receipts === 1,
    receiptBeforeAudio: mode === 'text' || (Number.isFinite(receiptAt) && Number.isFinite(firstAudioAt) && receiptAt <= firstAudioAt),
  };
  return {checks, ok: Object.values(checks).every(Boolean)};
}
