/**
 * SEL-03 counter-examples. Expected values are hand-written; no implementation-as-oracle.
 * Control must branch on reasonCode, never on Chinese reason strings.
 */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  humanReasonForCode,
  piContinueHint,
  realtimeContinueHint,
} from '../src/browser-action-selection.js';
import {runBrowserDecisionLoop} from '../src/browser-decision-loop.js';
import {judgeRealtimeBrowserAction} from '../src/realtime-browser-judge.js';
import {generalBrowserLoopEnabled} from '../src/config.js';
import {createBrowserTools} from '../src/tools.js';
import {REALTIME_BROWSER_TOOL_NAMES} from '../src/realtime-browser-tools.js';
import type {BrowserActionGuard, BrowserObservation} from '../../shared/browser-decision.js';
import type {ToolRpc} from '../src/rpc.js';
import type {JevAnswers, JevRequest} from '../src/jev-client.js';

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

/** Scripted Jev by question name; a choice names a criteria key, resolved by control name. */
function jev(policy: (q: string, state: Record<string, any>, id: (name: string) => string) => unknown) {
  return vi.fn(async (request: JevRequest): Promise<JevAnswers> => Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
    const criteria = ((question as {criteria?: Record<string, string>}).criteria ?? {}) as Record<string, string>;
    const id = (n: string) => Object.entries(criteria).find(([key, d]) => key !== 'none' && d.includes(`"${n}"`))?.[0] ?? 'none';

    return [name, policy(name, request.state, id)];
  })) as JevAnswers);
}

const pick = (choice: string, confidence = 0.99) => ({choice, confidence});

const yes = (noul: number) => ({noul});

const listed = (state: Record<string, any>, name: string) => yes(Object.values(state.controls ?? {}).some(d => String(d).includes(`"${name}"`)) ? 0.99 : 0.02);

/** Clicks `name` when it is in view (low risk); done once anything was clicked. */
const clickWhenSeen = (name: string, doneAfterClick = true) => (q: string, state: Record<string, any>, id: (n: string) => string) =>
  ({target: pick(id(name)), target_listed: listed(state, name), opener: pick('none'), risky: yes(0.02), goal_done: yes(doneAfterClick && (state.actions_done ?? []).length ? 0.95 : 0.03)} as Record<string, unknown>)[q];

describe('SEL-03 typed reasons', () => {
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
  it('a miss with an unread cursor actually continues reading before handoff', async () => {
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

      return {clicked: true};
    });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'parent', goal: 'Click Late Target', materials: [],
      signal: new AbortController().signal, call, ask: jev(clickWhenSeen('Late Target')),
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

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'Find missing', materials: [], signal: new AbortController().signal, call, ask: jev(clickWhenSeen('Missing')),
    });

    expect(result.status).toBe('handoff');
    expect(result.reasonCode).toBe('no_match');
    expect(result.continue?.action).toBe('session_prompt');
    expect(result.continue?.checkedRange?.observationIds).toContain('only');
    expect(call.mock.calls.filter(c => c[0] === 'click')).toHaveLength(0);
  });

  it.each([
    ['low-confidence', 'Open', 0.5, 'low_confidence'],
    ['fabricated', 'nope', 0.99, 'invalid_decision'],
    ['nan', 'Open', NaN, 'invalid_decision'],
  ] as const)('%s pick yields %s and zero writes', async (_label, name, confidence, code) => {
    const call = vi.fn(async (_name: string, _params: BrowserLoopToolParams = {}, _id?: string) => ({observation: page()}));
    const ask = jev((q, state, id) => q === 'target' ? pick(name === 'nope' ? 'c7' : id(name), confidence) : clickWhenSeen('Open')(q, state, id));

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'x', materials: [], signal: new AbortController().signal, call, ask,
    });

    expect(result.reasonCode).toBe(code);
    expect(call.mock.calls.some(c => ['click', 'fill', 'hover'].includes(c[0] as string))).toBe(false);
  });

  it('provider timeout/error → provider_error, not a page miss', async () => {
    const call = vi.fn(async (_name: string, _params: BrowserLoopToolParams = {}, _id?: string) => ({observation: page()}));
    const ask = vi.fn(async () => { throw new Error('Jev HTTP 503'); });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'x', materials: [], signal: new AbortController().signal, call, ask,
    });

    expect(result.reasonCode).toBe('provider_error');
    expect(result.continue?.action).toBe('session_prompt');
    expect(call.mock.calls.some(c => c[0] === 'click')).toBe(false);
  });

  it('held permission → permission_required; no further business writes', async () => {
    const call = vi.fn(async (name: string) => {
      if (name === 'snapshot') return {observation: page()};

      return {clicked: false, held: true};
    });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'click', materials: [], signal: new AbortController().signal, call, ask: jev(clickWhenSeen('Open')),
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

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'click', materials: [], signal: new AbortController().signal, call, ask: jev(clickWhenSeen('Open')),
    });

    expect(result.reasonCode).toBe('execution_unknown');
    expect(result.continue?.action).toBe('readonly_verify');
    expect(result.continue?.preserveFacts).toBe(true);
    expect(result.receipts[0]?.executionFact).toBe('unknown');
    expect(call.mock.calls.filter(c => c[0] === 'click')).toHaveLength(1);
  });

  it('a successful step that does not finish the request hands back with the receipt kept once', async () => {
    let snaps = 0;

    const call = vi.fn(async (name: string) => {
      if (name === 'snapshot') return {observation: page({id: `o${++snaps}`})};

      return {clicked: true};
    });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'partial', materials: [], signal: new AbortController().signal, call, ask: jev(clickWhenSeen('Open', false)),
    });

    expect(result.reasonCode).toBe('no_match');
    expect(result.receipts.filter(r => r.operation === 'click')).toHaveLength(1);
    expect(result.receipts[0]?.executionFact).toBe('executed');
    expect(call.mock.calls.filter(c => c[0] === 'click')).toHaveLength(1);
  });

  it('cancel during a judgment → cancelled with no business side effects', async () => {
    const abort = new AbortController();
    const call = vi.fn(async (_name: string, _params: BrowserLoopToolParams = {}, _id?: string) => ({observation: page()}));

    const ask = jev((q, state, id) => { abort.abort();

      return clickWhenSeen('Open')(q, state, id); });

    const result = await runBrowserDecisionLoop({
      parentCallId: 'p', goal: 'x', materials: [], signal: abort.signal, call, ask,
    });

    expect(result.status).toBe('cancelled');
    expect(call.mock.calls.some(c => c[0] === 'click')).toBe(false);
  });
});

describe('SEL-03 Realtime continue mounts (no phantom tools)', () => {
  it('with task_action mounted, an action the voice session cannot run recommends task_action not browser_loop', async () => {
    const rpc = {getPageTarget: () => 7, call: vi.fn(async () => ({observation: page()}))} as unknown as ToolRpc;

    const result = await judgeRealtimeBrowserAction(
      rpc,
      {request: 'click open', userTask: 'click open', history: [], canExecute: tool => tool !== 'click', continueMount: {directBrowser: true, taskAction: true, browserRequest: true}},
      new AbortController().signal,
      jev(clickWhenSeen('Open')),
    );

    expect(result).toMatchObject({status: 'uncertain', reasonCode: 'unsupported_action'});
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

  it('no_match after reading the next window still recommends snapshot continue', async () => {
    const obs = page({hasMore: true, nextCursor: 'more-1'});
    const rpc = {getPageTarget: () => 7, call: vi.fn(async () => ({observation: obs}))} as unknown as ToolRpc;

    const result = await judgeRealtimeBrowserAction(
      rpc,
      {request: 'find late', userTask: 'find late', history: [], continueMount: {directBrowser: true, taskAction: false, browserRequest: true}},
      new AbortController().signal,
      jev(clickWhenSeen('Late')),
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
