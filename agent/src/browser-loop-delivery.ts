import type { BrowserLoopOutcome } from '../../shared/browser-decision.js';
import { GOAL_DONE_THRESHOLD } from './browser-questions.js';

const DELIVERY_TEXT_MAX = 600;

/**
 * Direct delivery of the loop's own completion (behind `browserLoopDirectDelivery`, off by default):
 * Jev judged the request done at or above the threshold from code-written action facts, every write was
 * a click the executor confirmed delivered and Jev judged low risk, and the work stayed on the request's
 * page. Anything else — fills, selects, tab switches, unknown or held steps — goes to the main model.
 */
export function browserLoopSelfDeliveryText(outcome: BrowserLoopOutcome | undefined, tabId: number): string | null {
  const completion = outcome?.completion;

  if (!outcome || outcome.status !== 'needs_verification' || !completion) return null;

  if (!(completion.confidence >= GOAL_DONE_THRESHOLD) || !completion.lowRiskWrites) return null;

  if (outcome.lastObservation?.tabId !== tabId) return null;
  const { receipts } = outcome;

  if (!receipts.length || receipts.some(r => r.executionFact !== 'executed' || (r.operation !== 'click' && r.operation !== 'hover'))) return null;

  if (!receipts.some(r => r.operation === 'click') || completion.clicked.length !== receipts.filter(r => r.operation === 'click').length) return null;
  const text = `已完成：点击了${completion.clicked.map(name => `「${name}」`).join('、')}。`;

  return text.length <= DELIVERY_TEXT_MAX ? text : null;
}
