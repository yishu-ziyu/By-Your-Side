import {describe,expect,it} from 'vitest';
import {
  BROWSER_DECISION_CANDIDATE_LIMIT,
  BROWSER_DECISION_CONFIDENCE_THRESHOLD,
  BROWSER_DECISION_PAYLOAD_BYTES,
  estimateDecisionPayloadBytes,
  isReliableDecisionConfidence,
  selectBrowserActionCandidates,
} from '../src/browser-action-selection.js';
import {browserCandidates,type BrowserMaterial,type BrowserObservation} from '../../shared/browser-decision.js';

function page(controls: BrowserObservation['controls'], extra: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    id: 'obs-1',
    tabId: 7,
    documentId: 'd1',
    url: 'https://form.test/',
    observedAt: Date.now(),
    source: 'accessibility',
    text: 'form',
    truncated: false,
    controls,
    ...extra,
  };
}

function materials(count: number): BrowserMaterial[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    value: `FULL-ORIGINAL-VALUE-${i + 1}-${'x'.repeat(40)}`,
    source: 'user' as const,
    purpose: `field material ${i + 1}`,
  }));
}

describe('SEL-02 bounded action selection', () => {
  it('keeps fan-out operation+target candidates in one request when under budget', () => {
    const obs = page([
      { ref: '@1', role: 'button', name: 'Save', disabled: false },
      { ref: '@2', role: 'textbox', name: 'Name', value: '', disabled: false },
    ]);
    const mats = materials(2);
    const selection = selectBrowserActionCandidates({
      goal: 'fill name',
      page: obs,
      materials: mats,
      history: [],
      canGenerateText: false,
    });
    expect(selection.bounded).toBe(false);
    expect(selection.candidates.some(c => c.operation === 'click' && c.target === '@1')).toBe(true);
    expect(selection.candidates.filter(c => c.operation === 'fill' && c.valueId).length).toBe(2);
    expect(selection.decisionMaterials).toEqual(mats);
    expect(selection.candidates.length).toBeLessThanOrEqual(BROWSER_DECISION_CANDIDATE_LIMIT);
    expect(estimateDecisionPayloadBytes({
      goal: 'fill name',
      page: obs,
      candidates: selection.candidates,
      materials: selection.decisionMaterials,
      history: [],
    })).toBeLessThanOrEqual(BROWSER_DECISION_PAYLOAD_BYTES);
  });

  it('30 fields × 12 materials does not throw and stays within candidate/byte budgets', () => {
    const controls = Array.from({ length: 30 }, (_, i) => ({
      ref: `@${i + 1}`,
      role: 'textbox',
      name: `Field ${i + 1}`,
      value: '',
      disabled: false,
    }));
    const mats = materials(12);
    const cartesian = browserCandidates(page(controls), mats, false);
    expect(cartesian.filter(c => c.operation === 'fill').length).toBe(360);
    expect(cartesian.length).toBeGreaterThan(BROWSER_DECISION_CANDIDATE_LIMIT);

    const selection = selectBrowserActionCandidates({
      goal: 'fill field 30 with material 12',
      page: page(controls),
      materials: mats,
      history: [],
      canGenerateText: true,
    });
    expect(selection.bounded).toBe(true);
    expect(selection.candidates.length).toBeLessThanOrEqual(BROWSER_DECISION_CANDIDATE_LIMIT);
    expect(estimateDecisionPayloadBytes({
      goal: 'fill field 30 with material 12',
      page: page(controls),
      candidates: selection.candidates,
      materials: selection.decisionMaterials,
      history: [],
    })).toBeLessThanOrEqual(BROWSER_DECISION_PAYLOAD_BYTES);
    expect(selection.candidates.some(c => c.operation === 'select_materials')).toBe(true);
    expect(selection.candidates.some(c => c.operation === 'handoff')).toBe(true);
    // Focused window restores cartesian fills for only those materials; host originals untouched.
    const focus = selection.candidates.find(c => c.operation === 'select_materials' && c.materialIds?.includes('m12'))!;
    expect(focus.materialIds?.every(id => mats.some(m => m.id === id && m.value.startsWith('FULL-ORIGINAL')))).toBe(true);
    const focused = selectBrowserActionCandidates({
      goal: 'fill field 30 with material 12',
      page: page(controls),
      materials: mats,
      history: [],
      canGenerateText: false,
      focusedMaterialIds: focus.materialIds,
    });
    const fill = focused.candidates.find(c => c.operation === 'fill' && c.target === '@30' && c.valueId === 'm12');
    expect(fill).toBeTruthy();
    expect(mats.find(m => m.id === 'm12')!.value).toBe(`FULL-ORIGINAL-VALUE-12-${'x'.repeat(40)}`);
  });

  it('disabled tools do not become executable candidates; other direct actions stay', () => {
    const obs = page([
      { ref: '@1', role: 'button', name: 'Go', disabled: false },
      { ref: '@2', role: 'textbox', name: 'Q', value: '', disabled: false },
    ]);
    const selection = selectBrowserActionCandidates({
      goal: 'click go',
      page: obs,
      materials: materials(1),
      history: [],
      canGenerateText: false,
      canExecute: name => name !== 'click',
    });
    expect(selection.candidates.some(c => c.operation === 'click')).toBe(false);
    // hover is a separate tool; disabling click must not remove an allowed hover capability.
    expect(selection.candidates.some(c => c.operation === 'hover')).toBe(true);
    expect(selection.candidates.some(c => c.operation === 'fill')).toBe(true);
    expect(selection.candidates.some(c => c.operation === 'scroll')).toBe(true);
    const noHover = selectBrowserActionCandidates({
      goal: 'click go',
      page: obs,
      materials: materials(1),
      history: [],
      canGenerateText: false,
      canExecute: name => name !== 'hover',
    });
    expect(noHover.candidates.some(c => c.operation === 'hover')).toBe(false);
    expect(noHover.candidates.some(c => c.operation === 'click')).toBe(true);
  });

  it('offers continue_read / select_scope when observation reports more windows', () => {
    const selection = selectBrowserActionCandidates({
      goal: 'find late control',
      page: page(
        [{ ref: '@1', role: 'button', name: 'A', disabled: false }],
        {
          hasMore: true,
          nextCursor: 'cursor-controls-2',
          collectedCount: 240,
          visibleCount: 100,
          scopes: [{ id: 'page:region-b', label: 'Region B', count: 140, complete: true }],
          viewScopeId: 'page:region-a',
        },
      ),
      materials: [],
      history: [],
    });
    expect(selection.candidates.some(c => c.operation === 'continue_read' && c.cursor === 'cursor-controls-2')).toBe(true);
    expect(selection.candidates.some(c => c.operation === 'select_scope' && c.viewScopeId === 'page:region-b')).toBe(true);
  });

  it('preserves 0.85 confidence threshold and raw probabilities are not rewritten here', () => {
    expect(BROWSER_DECISION_CONFIDENCE_THRESHOLD).toBe(0.85);
    expect(isReliableDecisionConfidence(0.84)).toBe(false);
    expect(isReliableDecisionConfidence(0.85)).toBe(true);
    expect(isReliableDecisionConfidence(NaN)).toBe(false);
  });
});
