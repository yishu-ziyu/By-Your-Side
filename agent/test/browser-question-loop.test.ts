import { describe, expect, it, vi } from 'vitest';
import { runBrowserDecisionLoop } from '../src/browser-decision-loop.js';
import { browserLoopSelfDeliveryText } from '../src/browser-loop-delivery.js';
import type { BrowserControl, BrowserLoopOutcome, BrowserObservation, BrowserScopeSummary } from '../../shared/browser-decision.js';
import type { JevAnswers, JevRequest } from '../src/jev-client.js';

/**
 * Narrow-question loop (browser-questions.ts + browser-decision-loop.ts) against a scripted page and a
 * scripted Jev. Expected values are written by hand from the design rules, not recomputed by the code.
 * Ways it could fail:
 *  1. it clicks a target Jev picked below 0.85, or one the presence Noul says is not listed;
 *  2. it clicks a control Jev judged a risky write (delete / pay / send / publish);
 *  3. it reports "not found" before reading every unread window, or asks Jev again about a window
 *     whose controls it already judged;
 *  4. it clicks the same control twice, or hovers the same opener twice;
 *  5. it reports needs_verification without goal_done ≥ 0.85, or drops the facts direct delivery needs;
 *  6. it clicks a toggle that is already in the requested state;
 *  7. it writes a clipped material preview instead of the full host value;
 *  8. provider errors, unknown answer ids or cancellation lead to a write;
 *  9. a disabled tool is used anyway, or the Jev request budget is exceeded;
 * 10. wrapper section labels ("generic", "none") leak into what Jev reads, or `part` is asked when the
 *     whole page is already in view.
 */

type Part = { id: string; label: string; controls: BrowserControl[] };

const button = (ref: string, name: string, extra: Partial<BrowserControl> = {}): BrowserControl => ({ ref, role: 'button', name, disabled: false, ...extra });

/** A page split into partitions; the default view is the first partition when there are several. */
function fakePage(parts: Part[], opts: { onClick?: (ref: string, page: FakePage) => void; onHover?: (ref: string, page: FakePage) => void } = {}) {
  let seq = 0;

  const page = {
    parts,
    calls: [] as Array<{ name: string; params: Record<string, unknown> }>,
    view(viewScopeId?: string): BrowserObservation {
      const all = page.parts.flatMap(p => p.controls);
      const whole = page.parts.length === 1;
      const part = whole ? undefined : page.parts.find(p => p.id === viewScopeId) ?? page.parts[0]!;
      const scopes: BrowserScopeSummary[] = page.parts.map(p => ({ id: p.id, label: p.label, count: p.controls.length, complete: true }));

      return {
        id: `o${++seq}`, tabId: 7, documentId: 'd1', url: 'https://fixture.test/', observedAt: seq, source: 'accessibility', text: '', truncated: false,
        textTruncated: false, controlsTruncated: false,
        controls: part ? part.controls : all,
        ...(part ? { viewScopeId: part.id, viewScopeLabel: part.label, scopes } : whole ? {} : { scopes }),
      };
    },
    call: vi.fn(async (name: string, params: Record<string, unknown>) => {
      page.calls.push({ name, params });

      if (name === 'snapshot') return { observation: page.view(params.viewScopeId as string | undefined) };

      if (name === 'click') { opts.onClick?.(params.target as string, page);

 return { clicked: true }; }

      if (name === 'hover') { opts.onHover?.(params.target as string, page);

 return { hovered: true }; }

      if (name === 'fill') {
        const control = page.parts.flatMap(p => p.controls).find(c => c.ref === params.target);

        if (control) control.value = String(params.value);

        return { filled: true };
      }

      if (name === 'read_element') {
        const control = page.parts.flatMap(p => p.controls).find(c => c.ref === params.target);
        const expected = (params.expect as { equals?: string } | undefined)?.equals;

        return { tagName: control?.role === 'combobox' ? 'select' : 'input', value: control?.value, ...(expected !== undefined ? { check: { matched: control?.value === expected } } : {}) };
      }

      throw new Error(`unexpected ${name}`);
    }),
    writes: () => page.calls.filter(c => ['click', 'fill', 'press_key', 'switch_tab'].includes(c.name)),
  };

  return page;
}

type FakePage = ReturnType<typeof fakePage>;

/**
 * Scripted Jev: answers each question from a policy keyed by question name. Like the real API, a choice
 * can only name one of that question's criteria, so ids resolve by control name among them.
 */
function fakeJev(policy: (state: Record<string, any>, name: string, byName: (n: string) => string | undefined) => unknown) {
  const requests: JevRequest[] = [];

  const ask = vi.fn(async (request: JevRequest): Promise<JevAnswers> => {
    requests.push(structuredClone(request));
    const answers: JevAnswers = {};

    for (const [name, question] of Object.entries(request.questions)) {
      const criteria = ((question as { criteria?: Record<string, string> }).criteria ?? request.state.controls ?? {}) as Record<string, string>;
      const byName = (n: string) => Object.entries(criteria).find(([id, d]) => id !== 'none' && d.includes(`"${n}"`))?.[0];
      answers[name] = policy(request.state, name, byName) as JevAnswers[string];
    }

    return answers;
  });

  return { ask, requests };
}

const pick = (choice: string | undefined, confidence = 1) => ({ choice: choice ?? 'none', confidence });

const yes = (p: number) => ({ noul: p });

const run = (page: FakePage, ask: ReturnType<typeof fakeJev>['ask'], goal: string, extra: Partial<Parameters<typeof runBrowserDecisionLoop>[0]> = {}) =>
  runBrowserDecisionLoop({ parentCallId: 'p', goal, materials: [], signal: new AbortController().signal, call: page.call as never, ask, ...extra });

/** Jev that finds `name`, calls it low risk, and says done once a click on it is in actions_done. */
const clickPolicy = (name: string, over: Partial<Record<string, unknown>> = {}) => (state: Record<string, any>, q: string, byName: (n: string) => string | undefined) => {
  if (q in over) return over[q];
  const clicked = (state.actions_done ?? []).some((f: string) => f.startsWith(`Clicked button "${name}"`));

  switch (q) {
    case 'target': return pick(byName(name));
    case 'target_listed': return yes(byName(name) ? 0.99 : 0.02);
    case 'opener': return pick('none', 0.99);
    case 'goal_done': return yes(clicked ? 0.97 : 0.04);
    case 'risky': return yes(0.05);
    case 'part': return { choice: 'p1', confidence: 0.5, probabilities: {} };
    default: throw new Error(`unexpected question ${q}`);
  }
};

describe('narrow-question browser loop', () => {
  it('clicks a confident, listed, low-risk target once and ends with its own completion facts', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Cancel'), button('@2', 'Save profile')] }]);
    const jev = fakeJev(clickPolicy('Save profile'));
    const outcome = await run(page, jev.ask, 'Click Save profile');

    expect(page.writes().map(c => c.params.target)).toEqual(['@2']);
    expect(page.writes()[0]!.params.decisionGuard).toMatchObject({ operation: 'click', target: '@2', observationId: 'o1' });
    expect(outcome.status).toBe('needs_verification');
    expect(outcome.completion).toMatchObject({ confidence: 0.97, lowRiskWrites: true, clicked: ['Save profile'] });
    expect(outcome.completion!.facts).toEqual(['Clicked button "Save profile" once; the browser confirmed the click was delivered.']);
    expect(jev.ask).toHaveBeenCalledTimes(3); // locate, risk, locate+done
  });

  it.each([
    ['target below 0.85', { target: { choice: 'c2', confidence: 0.84 } }, 'low_confidence'],
    ['risky write', { risky: yes(0.62) }, 'permission_required'],
  ])('never clicks on %s', async (_label, over, code) => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Rename'), button('@2', 'Delete project')] }]);
    const outcome = await run(page, fakeJev(clickPolicy('Delete project', over)).ask, 'Delete project');

    expect(page.writes()).toEqual([]);
    expect(outcome).toMatchObject({ status: 'handoff', reasonCode: code });
  });

  it('does not act on a pick the presence Noul rejects; it reads every partition before no_match', async () => {
    const page = fakePage([
      { id: 's1', label: 'region Inbox', controls: [button('@1', 'Inbox 1'), button('@2', 'Inbox 2')] },
      { id: 's2', label: 'region Archive', controls: [button('@3', 'Archive 1')] },
      { id: 's3', label: 'region Spam', controls: [button('@4', 'Spam 1')] },
    ]);

    const jev = fakeJev(clickPolicy('Missing', { target: pick('c1', 0.95), target_listed: yes(0.1) }));
    const outcome = await run(page, jev.ask, 'Click Missing');

    expect(page.writes()).toEqual([]);
    expect(outcome).toMatchObject({ status: 'handoff', reasonCode: 'no_match' });
    const viewed = page.calls.filter(c => c.name === 'snapshot').map(c => c.params.viewScopeId ?? 'default');
    expect(new Set(viewed)).toEqual(new Set(['default', 's2', 's3']));
    expect(jev.ask).toHaveBeenCalledTimes(3);
  });

  it('reads the partition Jev ranks most likely first', async () => {
    const page = fakePage([
      { id: 's1', label: 'region Inbox', controls: [button('@1', 'Inbox 1')] },
      { id: 's2', label: 'region Archive', controls: [button('@3', 'Invoice March')] },
      { id: 's3', label: 'region Spam', controls: [button('@4', 'Spam 1')] },
    ]);

    const jev = fakeJev(clickPolicy('Invoice March', { part: { choice: 'p2', confidence: 0.8, probabilities: { p1: 0.8, p2: 0.2 } } }));
    await run(page, jev.ask, 'Click Invoice March in the Archive');

    // p1 = first unread part (Archive), so Archive is read before Spam and the target is found there.
    expect(page.calls.filter(c => c.name === 'snapshot').map(c => c.params.viewScopeId)).toEqual([undefined, 's2', 's2']);
    expect(page.writes().map(c => c.params.target)).toEqual(['@3']);
  });

  it('does not ask Jev again about a window whose controls it already judged', async () => {
    const same = [button('@1', 'Noise 1'), button('@2', 'Noise 2')];
    const page = fakePage([{ id: 's1', label: 'generic', controls: same }, { id: 's2', label: 'none', controls: same }]);
    const jev = fakeJev(clickPolicy('Missing'));
    const outcome = await run(page, jev.ask, 'Click Missing');

    expect(outcome.reasonCode).toBe('no_match');
    expect(jev.ask).toHaveBeenCalledTimes(1);
  });

  it('keeps wrapper labels out of control lines and asks `part` only when unread partitions remain', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Go', { scopeLabel: 'generic' }), button('@2', 'Late', { scopeLabel: 'region Late' })] }]);
    const jev = fakeJev(clickPolicy('Missing'));
    await run(page, jev.ask, 'Click Missing');

    expect(jev.requests[0]!.state.controls).toEqual({ c1: 'button "Go"', c2: 'button "Late" in region "Late"' });
    expect(jev.requests[0]!.questions).not.toHaveProperty('part');
  });

  it('hovers an opener once; when hovering shows nothing it clicks the opener, then the revealed target', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Open preferences')] }], {
      onClick: ref => { if (ref === '@1') page.parts[0]!.controls.push({ ref: '@2', role: 'switch', name: 'Dark mode', disabled: false, checked: false }); },
    });

    const jev = fakeJev((state, q, byName) => {
      const done = (state.actions_done ?? []).some((f: string) => f.startsWith('Clicked switch "Dark mode"'));

      if (q === 'target') return pick(byName('Dark mode') ?? byName('Open preferences'), 0.95);

      if (q === 'target_listed') return yes(0.95);

      if (q === 'opener') return pick(byName('Open preferences'), 0.97);

      if (q === 'goal_done') return yes(done ? 0.96 : 0.03);

      if (q === 'risky') return yes(0.03);

      if (q === 'turn_on') return yes(0.98);
      throw new Error(q);
    });

    const outcome = await run(page, jev.ask, "Open preferences and turn on dark mode");

    expect(page.calls.filter(c => c.name === 'hover').map(c => c.params.target)).toEqual(['@1']);
    expect(page.writes().map(c => c.params.target)).toEqual(['@1', '@2']);
    expect(outcome.status).toBe('needs_verification');
  });

  it('does not click a toggle already in the requested state', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [{ ref: '@1', role: 'checkbox', name: 'Email', disabled: false, checked: true }] }]);
    const jev = fakeJev((state, q, byName) => ({ target: pick(byName('Email')), target_listed: yes(0.99), opener: pick('none'), risky: yes(0.02), turn_on: yes(0.97), goal_done: yes((state.actions_done ?? []).length ? 0.93 : 0.02) } as Record<string, unknown>)[q]);
    const outcome = await run(page, jev.ask, 'Turn on email');

    expect(page.writes()).toEqual([]);
    expect(outcome.status).toBe('needs_verification');
    expect(outcome.completion!.facts).toEqual(['checkbox "Email" is already on; it was not clicked.']);
    expect(browserLoopSelfDeliveryText(outcome, 7)).toBeNull();
  });

  it('writes the full host material, not the clipped preview Jev saw', async () => {
    const long = `${'x'.repeat(300)}END`;
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [{ ref: '@1', role: 'textbox', name: 'Bio', disabled: false, value: '' }] }]);
    const jev = fakeJev((state, q, byName) => ({ target: pick(byName('Bio')), target_listed: yes(0.99), opener: pick('none'), value: pick('m1', 0.96), goal_done: yes((state.actions_done ?? []).length ? 0.9 : 0.02) } as Record<string, unknown>)[q]);
    const outcome = await run(page, jev.ask, 'Put my bio in the Bio field', { materials: [{ id: 'bio', value: long, source: 'user', purpose: 'bio' }] });

    expect(page.writes().map(c => c.params.value)).toEqual([long]);
    expect(JSON.stringify(jev.requests)).not.toContain('END');
    expect(outcome.receipts[0]).toMatchObject({ operation: 'fill', executionFact: 'executed', verification: 'verified' });
    expect(browserLoopSelfDeliveryText(outcome, 7)).toBeNull();
  });

  it('chooses an observed native select option through fill and reads it back', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [{ ref: '@1', role: 'combobox', name: 'Country', disabled: false, value: 'Germany', options: [{ ref: '@11', label: 'Germany', disabled: false }, { ref: '@12', label: 'Japan', disabled: false }] }] }]);
    const jev = fakeJev((state, q, byName) => ({ target: pick(byName('Country')), target_listed: yes(0.99), opener: pick(byName('Country')), option: pick('o2', 0.99), goal_done: yes((state.actions_done ?? []).length ? 0.95 : 0.01) } as Record<string, unknown>)[q]);
    const outcome = await run(page, jev.ask, 'Set country to Japan');

    expect(page.calls.filter(c => c.name === 'hover')).toEqual([]);
    expect(page.writes()).toEqual([expect.objectContaining({ name: 'fill', params: expect.objectContaining({ target: '@1', value: 'Japan' }) })]);
    expect(outcome.status).toBe('needs_verification');
  });

  it('never clicks the same control twice even if Jev keeps pointing at it', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Next')] }]);
    const jev = fakeJev(clickPolicy('Next', { goal_done: yes(0.2) }));
    const outcome = await run(page, jev.ask, 'Click Next twice');

    expect(page.writes()).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'handoff', reasonCode: 'no_match' });
  });

  it.each([
    ['provider failure', async () => { throw new Error('fetch failed'); }, 'provider_error'],
    ['unknown answer id', async () => ({ target: pick('c9'), target_listed: yes(0.99), opener: pick('none') }), 'invalid_decision'],
  ])('%s hands back without writing', async (_label, ask, code) => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Go')] }]);
    const outcome = await run(page, vi.fn(ask) as never, 'Click Go');

    expect(page.writes()).toEqual([]);
    expect(outcome).toMatchObject({ status: 'handoff', reasonCode: code });
  });

  it('cancellation during a Jev request prevents writes', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Go')] }]);
    const abort = new AbortController();
    const outcome = await run(page, vi.fn(async () => { abort.abort(); throw new Error('aborted'); }) as never, 'Click Go', { signal: abort.signal });

    expect(outcome.status).toBe('cancelled');
    expect(page.writes()).toEqual([]);
  });

  it('a disabled click tool is never used', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Go')] }]);
    const outcome = await run(page, fakeJev(clickPolicy('Go')).ask, 'Click Go', { canExecute: tool => tool !== 'click' });

    expect(page.writes()).toEqual([]);
    expect(outcome).toMatchObject({ status: 'handoff', reasonCode: 'unsupported_action' });
  });

  it('stops at 16 Jev requests on an endless page', async () => {
    let n = 0;
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Item 0')] }], { onClick: () => { page.parts[0]!.controls = [button(`@${++n + 1}`, `Item ${n}`)]; } });
    const jev = fakeJev((state, q) => ({ target: pick('c1'), target_listed: yes(0.99), opener: pick('none'), risky: yes(0.01), goal_done: yes(0.1) } as Record<string, unknown>)[q]);
    const outcome = await run(page, jev.ask, 'Keep clicking');

    expect(jev.ask.mock.calls.length).toBe(16);
    expect(outcome).toMatchObject({ status: 'handoff', reasonCode: 'candidate_budget' });
  });

  it('an unknown click result stops without replay', async () => {
    const page = fakePage([{ id: 'all', label: 'Page list', controls: [button('@1', 'Pay')] }]);
    page.call.mockImplementation(async (name: string, params: Record<string, unknown>) => {
      page.calls.push({ name, params });

      if (name === 'snapshot') return { observation: page.view() };
      throw Object.assign(new Error('timeout'), { executionFact: 'unknown' });
    });
    const outcome = await run(page, fakeJev(clickPolicy('Pay')).ask, 'Click Pay');

    expect(page.calls.filter(c => c.name === 'click')).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'handoff', reasonCode: 'execution_unknown' });
    expect(outcome.receipts[0]).toMatchObject({ executionFact: 'unknown' });
  });
});

describe('direct delivery gate', () => {
  const base = (over: Partial<BrowserLoopOutcome> = {}): BrowserLoopOutcome => ({
    status: 'needs_verification', reason: 'r', modelCalls: 3, decisions: [],
    lastObservation: { id: 'o', tabId: 7, documentId: 'd', url: 'u', observedAt: 1, text: '', controls: [], truncated: false, source: 'accessibility' },
    receipts: [
      { toolCallId: 'a', observationId: 'o1', candidateId: '@1', operation: 'hover', executionFact: 'executed', verification: 'unverified', detail: '' },
      { toolCallId: 'b', observationId: 'o2', candidateId: '@2', operation: 'click', executionFact: 'executed', verification: 'unverified', detail: '' },
    ],
    completion: { confidence: 0.9, facts: [], lowRiskWrites: true, clicked: ['Settings'] },
    ...over,
  });

  it('delivers a low-risk click the loop judged done on the request page', () => {
    expect(browserLoopSelfDeliveryText(base(), 7)).toBe('已完成：点击了「Settings」。');
  });

  it.each([
    ['below threshold', base({ completion: { confidence: 0.84, facts: [], lowRiskWrites: true, clicked: ['Settings'] } })],
    ['a risky click', base({ completion: { confidence: 0.99, facts: [], lowRiskWrites: false, clicked: ['Settings'] } })],
    ['no completion judgment', base({ completion: undefined })],
    ['a handoff', base({ status: 'handoff' })],
    ['an unknown write', base({ receipts: [{ toolCallId: 'b', observationId: 'o2', candidateId: '@2', operation: 'click', executionFact: 'unknown', verification: 'unverified', detail: '' }] })],
    ['a fill', base({ receipts: [{ toolCallId: 'b', observationId: 'o2', candidateId: '@2', operation: 'fill', executionFact: 'executed', verification: 'verified', verificationToolCallId: 'c', detail: '' }], completion: { confidence: 0.99, facts: [], lowRiskWrites: true, clicked: [] } })],
    ['no click at all', base({ receipts: [], completion: { confidence: 0.99, facts: [], lowRiskWrites: true, clicked: [] } })],
  ])('hands %s to the main model', (_label, outcome) => {
    expect(browserLoopSelfDeliveryText(outcome, 7)).toBeNull();
  });

  it('hands work that ended on another tab to the main model', () => {
    expect(browserLoopSelfDeliveryText(base(), 8)).toBeNull();
  });
});
