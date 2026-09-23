/**
 * SEL-03 counter-examples. Expected values are hand-written; no implementation-as-oracle.
 * Control must branch on reasonCode, never on Chinese reason strings.
 */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  BROWSER_DECISION_CONFIDENCE_THRESHOLD,
  humanReasonForCode,
  piContinueHint,
  realtimeContinueHint,
  resolveBrowserDecision,
} from '../src/browser-action-selection.js';
import {runBrowserDecisionLoop} from '../src/browser-decision-loop.js';
import {judgeRealtimeBrowserAction} from '../src/realtime-browser-judge.js';
import {generalBrowserLoopEnabled} from '../src/config.js';
import {createBrowserTools} from '../src/tools.js';
import {REALTIME_BROWSER_TOOL_NAMES} from '../src/realtime-browser-tools.js';
import type {BrowserActionGuard, BrowserObservation} from '../../shared/browser-decision.js';
import type {ToolRpc} from '../src/rpc.js';
import type {BrowserDecisionInput} from '../src/browser-decision-model.js';

/**
 * Host tool arguments that `runBrowserDecisionLoop`'s call() sites actually build
 * (browser-decision-loop.ts: snapshot / action / read_element / switch_tab). Each call site sets
 * only a subset, and one stub serves every tool name, so the shapes are flattened with optional
 * fields instead of an unparsed dictionary.
 */
interface BrowserLoopToolParams {
  decision?: boolean;
  cursor?: string;
  viewScopeId?: string;
  tabId?: number;
  target?: string;
  key?: string;
  dy?: number;
  value?: string;
  decisionGuard?: BrowserActionGuard;
  expect?: {property: string; equals: string};
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const page = (over: Partial<BrowserObservation> = {}): BrowserObservation => ({
  id: 'o1', tabId: 7, documentId: 'd1', url: 'https://test.invalid/', observedAt: 1,
  source: 'accessibility', text: 'UI', truncated: false,
  controls: [{ref: '@1', role: 'button', name: 'Open', disabled: false}],
  ...over,
});

describe('SEL-03 reasonCode classification (hand-written expectations)', () => {
  const candidates = [
    {id: 'c1', operation: 'click' as const, label: 'Click Open', target: '@1'},
    {id: 'c2', operation: 'click' as const, label: 'Click Other', target: '@2'},
  ];

  it('none → no_match; never execute', () => {
    const v = resolveBrowserDecision(
      {observationId: 'o1', candidateId: 'none', confidence: 0.99, model: 'fixture'},
      candidates, 'o1',
    );

    expect(v).toEqual({kind: 'reject', reasonCode: 'no_match', reason: expect.any(String)});
  });

  it('confidence below 0.85 → low_confidence; threshold unchanged', () => {
    expect(BROWSER_DECISION_CONFIDENCE_THRESHOLD).toBe(0.85);

    const v = resolveBrowserDecision(
      {observationId: 'o1', candidateId: 'c1', confidence: 0.84, model: 'fixture'},
      candidates, 'o1',
    );

    expect(v).toEqual({kind: 'reject', reasonCode: 'low_confidence', reason: expect.any(String)});
  });

  it('fabricated id → invalid_decision', () => {
    const v = resolveBrowserDecision(
      {observationId: 'o1', candidateId: 'fabricated', confidence: 0.99, model: 'f'},
      candidates, 'o1',
    );

    expect(v).toMatchObject({kind: 'reject', reasonCode: 'invalid_decision'});
  });

  it('NaN confidence → invalid_decision', () => {
    const v = resolveBrowserDecision(
      {observationId: 'o1', candidateId: 'c1', confidence: NaN, model: 'f'},
      candidates, 'o1',
    );

    expect(v).toMatchObject({kind: 'reject', reasonCode: 'invalid_decision'});
  });

  it('stale observationId → stale_observation', () => {
    const v = resolveBrowserDecision(
      {observationId: 'old', candidateId: 'c1', confidence: 0.99, model: 'f'},
      candidates, 'o1',
    );

    expect(v).toMatchObject({kind: 'reject', reasonCode: 'stale_observation'});
  });

  it('continue hints are typed actions/tools, independent of Chinese reason copy', () => {
    const pi = piContinueHint('no_match', {observationIds: ['o1'], cursors: [], scopeIds: []}, false);
    expect(pi.action).toBe('session_prompt');
    expect(pi).not.toHaveProperty('reason');
    // Provider failure must not be rewritten as a page miss.
    expect(piContinueHint('provider_error', undefined, false).action).toBe('session_prompt');
    expect(humanReasonForCode('provider_error')).not.toMatch(/找不到目标|目标不存在/);
  });
});

describe('SEL-03 loop: typed reasons and real continue_read', () => {
  it('no_match with unread cursor actually continues reading before handoff', async () => {
    const first = page({
      id: 'v1', hasMore: true, nextCursor: 'c-next', collectedCount: 200, visibleCount: 1,
      controls: [{ref: '@1', role: 'button', name: 'Early', disabled: false}],
    });

    const second = page({
      id: 'v2', controls: [{ref: '@150', role: 'button', name: 'Late Target', disabled: false}],
    });

    const call = vi.fn(async (name: string, params: BrowserLoopToolParams = {}) => {
      if (name === 'snapshot') {
        if (params.cursor === 'c-next') return {observation: second};

        return {observation: first};
      }

      return {effect: {changed: true}};
    });

    let round = 0;

    const decide = vi.fn(async (input: {page: BrowserObservation; candidates: Array<{id: string; operation: string; target?: string}>}) => {
      round++;

      if (round === 1) {
        return {observationId: input.page.id, candidateId: 'none', confidence: 0.95, model: 'fixture'};
      }

      const click = input.candidates.find(c => c.operation === 'click' && c.target === '@150');

      if (click) return {observationId: input.page.id, candidateId: click.id, confidence: 0.99, model: 'fixture'};

      return {observationId: input.page.id, candidateId: 'done', confidence: 0.99, model: 'fixture'};
    });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'parent', goal: 'Click Late Target', materials: [],
      signal: new AbortController().signal, call, decide,
    });

    expect(call.mock.calls.some(c => c[0] === 'snapshot' && (c[1] as {cursor?: string})?.cursor === 'c-next')).toBe(true);
    expect(result.receipts.map(r => r.operation)).toEqual(['click']);
    expect(result.status).toBe('needs_verification');
    expect(result.continue?.checkedRange?.cursors).toContain('c-next');
    expect(result.continue?.checkedRange?.observationIds).toEqual(expect.arrayContaining(['v1', 'v2']));
  });

  it('exhausted views hand off with no_match + checkedRange', async () => {
    const only = page({id: 'only', hasMore: false});
    const call = vi.fn(async (_name: string, _params: BrowserLoopToolParams = {}, _id?: string) => ({observation: only}));

    const decide = vi.fn(async (i: {page: BrowserObservation}) => ({
      observationId: i.page.id, candidateId: 'none', confidence: 0.9, model: 'f',
    }));

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'Find missing', materials: [], signal: new AbortController().signal, call, decide,
    });

    expect(result.status).toBe('handoff');
    expect(result.reasonCode).toBe('no_match');
    expect(result.continue?.action).toBe('session_prompt');
    expect(result.continue?.checkedRange?.observationIds).toContain('only');
    expect(call.mock.calls.filter(c => c[0] === 'click')).toHaveLength(0);
  });

  it.each([
    ['low-confidence', 'c1', 0.5, 'low_confidence'],
    ['fabricated', 'nope', 0.99, 'invalid_decision'],
    ['nan', 'c1', NaN, 'invalid_decision'],
  ] as const)('%s decision yields %s and zero writes', async (_label, candidateId, confidence, code) => {
    const call = vi.fn(async (_name: string, _params: BrowserLoopToolParams = {}, _id?: string) => ({observation: page()}));

    const decide = vi.fn(async (i: {page: BrowserObservation}) => ({
      observationId: i.page.id, candidateId, confidence, model: 'f',
    }));

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'x', materials: [], signal: new AbortController().signal, call, decide,
    });

    expect(result.reasonCode).toBe(code);
    expect(call.mock.calls.some(c => ['click', 'fill', 'hover'].includes(c[0] as string))).toBe(false);
  });

  it('provider timeout/error → provider_error, not a page miss', async () => {
    const call = vi.fn(async (_name: string, _params: BrowserLoopToolParams = {}, _id?: string) => ({observation: page()}));
    const decide = vi.fn(async () => { throw new Error('Jev HTTP 503'); });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'x', materials: [], signal: new AbortController().signal, call, decide,
    });

    expect(result.reasonCode).toBe('provider_error');
    expect(result.continue?.action).toBe('session_prompt');
    expect(call.mock.calls.some(c => c[0] === 'click')).toBe(false);
  });

  it('held permission → permission_required; no further business writes', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'snapshot') return {observation: page()};

      return {held: true};
    });

    const decide = vi.fn(async (i: {page: BrowserObservation}) => ({
      observationId: i.page.id, candidateId: 'c1', confidence: 0.99, model: 'f',
    }));

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'click', materials: [], signal: new AbortController().signal, call, decide,
    });

    expect(result.reasonCode).toBe('permission_required');
    expect(result.continue?.action).toBe('permission_path');
    expect(result.receipts[0]?.executionFact).toBe('not_executed');
    expect(call.mock.calls.filter(c => c[0] === 'click')).toHaveLength(1);
  });

  it('unknown write → execution_unknown; continue is readonly_verify; no replay', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'snapshot') return {observation: page()};
      throw Object.assign(new Error('timeout'), {executionFact: 'unknown'});
    });

    const decide = vi.fn(async (i: {page: BrowserObservation}) => ({
      observationId: i.page.id, candidateId: 'c1', confidence: 0.99, model: 'f',
    }));

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'click', materials: [], signal: new AbortController().signal, call, decide,
    });

    expect(result.reasonCode).toBe('execution_unknown');
    expect(result.continue?.action).toBe('readonly_verify');
    expect(result.continue?.preserveFacts).toBe(true);
    expect(result.receipts[0]?.executionFact).toBe('unknown');
    expect(call.mock.calls.filter(c => c[0] === 'click')).toHaveLength(1);
  });

  it('successful step then handoff keeps the receipt once', async () => {
    let snaps = 0;

    const call = vi.fn(async (name: string) => {
      if (name === 'snapshot') return {observation: page({id: `o${++snaps}`})};

      return {effect: {changed: true}};
    });

    let round = 0;

    const decide = vi.fn(async (input: {page: BrowserObservation; candidates: Array<{id: string; operation: string}>}) => {
      round++;

      if (round === 1) return {observationId: input.page.id, candidateId: 'c1', confidence: 0.99, model: 'f'};
      const handoff = input.candidates.find(c => c.operation === 'handoff');

      return {observationId: input.page.id, candidateId: handoff!.id, confidence: 0.99, model: 'f'};
    });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'partial', materials: [], signal: new AbortController().signal, call, decide,
    });

    expect(result.reasonCode).toBe('unsupported_action');
    expect(result.receipts.filter(r => r.operation === 'click')).toHaveLength(1);
    expect(result.receipts[0]?.executionFact).toBe('executed');
    expect(call.mock.calls.filter(c => c[0] === 'click')).toHaveLength(1);
  });

  it('cancel during decide → cancelled with no business side effects', async () => {
    const abort = new AbortController();
    const call = vi.fn(async (_name: string, _params: BrowserLoopToolParams = {}, _id?: string) => ({observation: page()}));

    const decide = vi.fn(async (i: {page: BrowserObservation}) => {
      abort.abort();

      return {observationId: i.page.id, candidateId: 'c1', confidence: 0.99, model: 'f'};
    });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'x', materials: [], signal: abort.signal, call, decide,
    });

    expect(result.status).toBe('cancelled');
    expect(call.mock.calls.some(c => c[0] === 'click')).toBe(false);
  });
});

describe('SEL-03 Realtime continue mounts (no phantom tools)', () => {
  it('with task_action mounted, unsupported_action recommends task_action not browser_loop', async () => {
    const rpc = {getPageTarget: () => 7, call: vi.fn(async () => ({observation: page({controls: []})}))} as unknown as ToolRpc;

    const decide = vi.fn(async (input: BrowserDecisionInput) => {
      const handoff = input.candidates.find(c => c.operation === 'handoff');

      return {observationId: input.page.id, candidateId: handoff!.id, confidence: 0.99, model: 'f'};
    });

    const result = await judgeRealtimeBrowserAction(
      rpc,
      {request: 'do drag', userTask: 'drag file', history: [], continueMount: {directBrowser: true, taskAction: true, browserRequest: true}},
      new AbortController().signal,
      decide,
    );

    expect(result.status).toBe('needs_context');
    expect(result).toMatchObject({reasonCode: 'unsupported_action'});
    expect(result.continue?.tools).toContain('task_action');
    expect(result.continue?.tools ?? []).not.toContain('browser_loop');
  });

  it('without task_action, fallback is browser_request only', () => {
    const hint = realtimeContinueHint('unsupported_action', page(), {
      directBrowser: true, taskAction: false, browserRequest: true,
    });

    expect(hint.tools).toEqual(['browser_request']);
    expect(hint.tools).not.toContain('browser_loop');
    expect(hint.tools).not.toContain('task_action');
  });

  it('no_match with hasMore recommends snapshot continue', async () => {
    const obs = page({hasMore: true, nextCursor: 'more-1'});
    const rpc = {getPageTarget: () => 7, call: vi.fn(async () => ({observation: obs}))} as unknown as ToolRpc;
    const decide = vi.fn(async () => ({observationId: 'o1', candidateId: 'none', confidence: 0.92, model: 'f'}));

    const result = await judgeRealtimeBrowserAction(
      rpc,
      {request: 'find late', userTask: 'find late', history: [], continueMount: {directBrowser: true, taskAction: false, browserRequest: true}},
      new AbortController().signal,
      decide,
    );

    expect(result).toMatchObject({status: 'uncertain', reasonCode: 'no_match'});
    expect(result.continue?.tools).toContain('snapshot');
    expect(result.continue?.cursor).toBe('more-1');
    expect(result.continue?.tools ?? []).not.toContain('browser_loop');
  });

  it('generalBrowserLoop on: Pi has browser_loop; Realtime tool list never includes it', () => {
    vi.stubEnv('SIDEAGENT_GENERAL_BROWSER_LOOP', '1');
    expect(generalBrowserLoopEnabled()).toBe(true);
    const rpc = {call: vi.fn(), ensureToolCall: vi.fn(), markCallRejected: vi.fn(), noteToolFact: vi.fn()};

    const withLoop = createBrowserTools(rpc as any, undefined, undefined, () => true, {
      epoch: () => 0, canWrite: () => true, goal: () => 'g', userText: () => 't', reserveDecision: vi.fn(),
    });

    expect(withLoop.some(t => t.name === 'browser_loop')).toBe(true);
    expect([...REALTIME_BROWSER_TOOL_NAMES]).not.toContain('browser_loop');

    // Realtime delegate entry when loop is off still exists as browser_request / task_action.
    const hint = realtimeContinueHint('no_match', page({hasMore: false}), {
      directBrowser: true, taskAction: true, browserRequest: true,
    });

    expect(hint.tools?.some(t => t === 'task_action' || t === 'browser_request' || t === 'snapshot')).toBe(true);
    expect(hint.tools ?? []).not.toContain('browser_loop');
  });

  it('generalBrowserLoop off: Pi tools omit browser_loop; continue still names task_action/browser_request', () => {
    vi.stubEnv('SIDEAGENT_GENERAL_BROWSER_LOOP', '0');
    expect(generalBrowserLoopEnabled()).toBe(false);
    const rpc = {call: vi.fn(), ensureToolCall: vi.fn(), markCallRejected: vi.fn(), noteToolFact: vi.fn()};

    const tools = createBrowserTools(rpc as any, undefined, undefined, () => true, {
      epoch: () => 0, canWrite: () => true, goal: () => 'g', userText: () => 't', reserveDecision: vi.fn(),
    });

    expect(tools.some(t => t.name === 'browser_loop')).toBe(false);

    const withTask = realtimeContinueHint('unsupported_action', page(), {
      directBrowser: false, taskAction: true, browserRequest: true,
    });

    expect(withTask.tools).toEqual(['task_action']);

    const withRequest = realtimeContinueHint('unsupported_action', page(), {
      directBrowser: false, taskAction: false, browserRequest: true,
    });

    expect(withRequest.tools).toEqual(['browser_request']);
  });
});
