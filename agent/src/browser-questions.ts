import { clickableRoles, type BrowserControl, type BrowserMaterial, type BrowserObservation, type BrowserScopeSummary } from '../../shared/browser-decision.js';
import type { TabInfo } from '../../shared/protocol.js';
import { BROWSER_DECISION_CONFIDENCE_THRESHOLD } from './browser-action-selection.js';
import type { JevAnswer, JevAnswers, JevRequest } from './jev-client.js';

/**
 * Narrow Jev questions for browser_loop and the realtime judge (2026-09-26 redesign). Code owns the flow:
 * each observation gets one request of small typed questions that share one small state; code composes the
 * answers into reveal, act, keep reading or stop. Structural rules live here, not in question prose:
 * hover only reveals, every part is read before "not found", a control is acted on once, and a click that
 * deletes, pays, sends or publishes is never automatic.
 */

/** Action gate for the target and opener choices (unchanged product threshold). */
export const ACT_THRESHOLD = BROWSER_DECISION_CONFIDENCE_THRESHOLD;

/** Noul P(yes) needed to report the request done. */
export const GOAL_DONE_THRESHOLD = 0.85;

/** Noul P(yes) at or above which a click counts as a risky write: ask the user instead. */
export const RISK_BLOCK = 0.5;

/** Noul P(yes) that the requested control is listed; below it the target choice is not trusted. */
export const LISTED_MIN = 0.5;

/** Toggle direction must be this clear either way. */
const TOGGLE_CLEAR = 0.85;

const FILL_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const TOGGLE_ROLES = new Set(['checkbox', 'switch', 'menuitemcheckbox']);

/** Roles the observation layer uses for unnamed wrappers; a label that is only one of these says nothing. */
const WRAPPER_ROLES = new Set(['generic', 'none', 'presentation', 'group']);

const ASK = '`request.task`';

// ── request context ────────────────────────────────────────────────────────

/** `userTask` may be the session's JSON context ({originalGoal, pendingCorrections, …}) or plain text. */
function taskContext(userTask: unknown): { whole?: string; corrections?: string[] } {
  let value = userTask;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;

      if (parsed && typeof parsed === 'object') value = parsed;
    } catch { /* plain text */ }
  }

  if (typeof value === 'string') return value.trim() ? { whole: value } : {};

  if (!value || typeof value !== 'object') return {};
  const o = value as { originalGoal?: unknown; pendingCorrections?: unknown };
  const corrections = Array.isArray(o.pendingCorrections) ? o.pendingCorrections.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [];

  return { ...(typeof o.originalGoal === 'string' && o.originalGoal.trim() ? { whole: o.originalGoal } : {}), ...(corrections.length ? { corrections } : {}) };
}

/** `request` state: the step to judge, plus the user's whole task and corrections only when they differ. */
export function questionRequest(task: string, userTask?: unknown): Record<string, unknown> {
  const context = taskContext(userTask);
  const request: Record<string, unknown> = { task };

  if (context.whole && context.whole.trim() !== task.trim()) request.whole_task = context.whole;

  if (context.corrections) request.corrections = context.corrections;

  return request;
}

/** browser_loop goals arrive as JSON {userTask, localGoal}; the local goal is what the loop must finish. */
export function loopQuestionRequest(goal: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(goal) as { userTask?: unknown; localGoal?: unknown };

    if (parsed && typeof parsed === 'object' && typeof parsed.localGoal === 'string' && parsed.localGoal.trim()) return questionRequest(parsed.localGoal, parsed.userTask);
  } catch { /* plain goal */ }

  return questionRequest(goal);
}

// ── controls ───────────────────────────────────────────────────────────────

/** Section name without wrapper noise: `generic` / `none` alone say nothing, `region "Late"` does. */
export function sectionName(label: string | undefined): string | undefined {
  const text = label?.trim();

  if (!text) return undefined;
  const space = text.indexOf(' ');

  if (space < 0) return undefined;
  const role = text.slice(0, space);
  const name = text.slice(space + 1).trim();

  if (!name) return undefined;

  return WRAPPER_ROLES.has(role) ? `"${name}"` : `${role} "${name}"`;
}

/** Identity for "already acted on / hovered": survives re-renders that change refs. */
export const controlKey = (c: BrowserControl) => `${c.role}|${c.name}|${sectionName(c.scopeLabel) ?? ''}`;

/** Remember a control by name and by ref: a hover can rename its trigger (a menu's text joins its name). */
export function markControl(set: Set<string>, c: BrowserControl): void {
  set.add(controlKey(c));
  set.add(`ref:${c.ref}`);
}

export const isMarked = (set: ReadonlySet<string>, c: BrowserControl) => set.has(controlKey(c)) || set.has(`ref:${c.ref}`);

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One plain line per control: role, quoted name, section and state. No page prose, no instructions. */
export function describeControl(c: BrowserControl): string {
  const state: string[] = [];

  if (c.checked !== undefined) state.push(c.checked === 'mixed' ? 'partly checked' : c.checked ? 'checked' : 'not checked');

  if (c.selected !== undefined) state.push(c.selected ? 'selected' : 'not selected');

  if (c.expanded) state.push('expanded');

  if (FILL_ROLES.has(c.role)) state.push(c.value ? `value "${clip(c.value, 80)}"` : 'empty');

  if (c.options?.length) state.push(`${c.options.length} options`);
  const section = sectionName(c.scopeLabel);

  return `${c.role} "${clip(c.name, 120)}"${section ? ` in ${section}` : ''}${state.length ? ` (${state.join(', ')})` : ''}`;
}

/** Role, name and section only: action facts name the control without its state before the action. */
export function nameControl(c: BrowserControl): string {
  const section = sectionName(c.scopeLabel);

  return `${c.role} "${clip(c.name, 120)}"${section ? ` in ${section}` : ''}`;
}

/** Controls a question may point at: enabled, not protected, not an option owned by a dropdown, not acted on yet. */
export function actionableControls(page: BrowserObservation, acted: ReadonlySet<string> = new Set()): BrowserControl[] {
  const owned = new Set(page.controls.flatMap(c => c.options?.map(o => o.ref) ?? []));

  return page.controls.filter(c => !c.disabled && !c.protected && !owned.has(c.ref)
    && (clickableRoles.has(c.role) || (FILL_ROLES.has(c.role) && !c.readOnly)) && !isMarked(acted, c));
}

/** Same controls in the same view means the same answers: a re-read window is skipped, not asked again. */
export function controlSetSignature(controls: readonly BrowserControl[]): string {
  return controls.map(controlKey).sort().join('\n');
}

export type ActKind = 'click' | 'toggle' | 'select' | 'fill';

/** What acting on a control means is a role rule, not a judgment. */
export function actKind(c: BrowserControl): ActKind {
  if (TOGGLE_ROLES.has(c.role)) return 'toggle';

  if (c.role === 'combobox' && c.options?.length) return 'select';

  if (FILL_ROLES.has(c.role) && !c.readOnly) return 'fill';

  return 'click';
}

// ── locate: one request per observation ────────────────────────────────────

export interface LocateInput {
  request: Record<string, unknown>;
  page: BrowserObservation;
  actionsDone: readonly string[];
  acted: ReadonlySet<string>;
  /** Partitions not read yet (none when the whole page is in view); offered to `part` when there are two or more. */
  unreadScopes: readonly BrowserScopeSummary[];
  /** Other browser tabs, only when the request is about tabs. */
  tabs?: readonly TabInfo[];
}

export interface LocateRequest {
  request: JevRequest;
  ids: Map<string, BrowserControl>;
  tabIds: Map<string, TabInfo>;
  partIds: Map<string, BrowserScopeSummary>;
}

export function buildLocateRequest(input: LocateInput): LocateRequest {
  // Acted-on controls stay in the state (the facts refer to them) but are no longer options.
  const all = actionableControls(input.page);
  const numbered = all.map((c, i) => [`c${i + 1}`, c] as const);
  const described = Object.fromEntries(numbered.map(([id, c]) => [id, describeControl(c)]));
  const ids = new Map(numbered.filter(([, c]) => !isMarked(input.acted, c)));
  const options = Object.fromEntries([...ids].map(([id]) => [id, described[id]!]));
  const tabIds = new Map((input.tabs ?? []).map(t => [`t${t.id}`, t] as const));
  const partIds = new Map(input.unreadScopes.length > 1 ? input.unreadScopes.map((s, i) => [`p${i + 1}`, s] as const) : []);

  const state: Record<string, unknown> = {
    request: input.request,
    page: { url: input.page.url, part_shown: input.page.viewScopeId ? (sectionName(input.page.viewScopeLabel) ?? 'one section') : 'whole page' },
    controls: described,
  };

  if (input.actionsDone.length) state.actions_done = [...input.actionsDone];

  if (tabIds.size) state.tabs = Object.fromEntries([...tabIds].map(([id, t]) => [id, `"${clip(t.title, 120)}" (${clip(t.url, 160)})`]));

  const questions: Record<string, unknown> = {
    target: {
      type: 'choice',
      instructions: {
        question: `Which control in \`controls\` does ${ASK} ask to click, press, choose, switch on or off, or type into next? When it asks for several, pick the earliest one it names.`,
        not_the_target: 'A menu, dropdown, tab or section that only has to be opened to reach that control.',
      },
      criteria: { ...options, none: `None of \`controls\` is a control ${ASK} asks to click, press, choose, switch or type into.` },
    },
    target_listed: {
      type: 'noul',
      instructions: `Is a control that ${ASK} asks to click, press, choose, switch on or off, or type into listed in \`controls\`?`,
    },
    opener: {
      type: 'choice',
      instructions: `Which control in \`controls\` is the menu, dropdown, tab or section that ${ASK} says to open, or that has to be opened to reach a control ${ASK} asks to act on?`,
      criteria: { ...options, none: 'No listed control is such a menu, dropdown, tab or section.' },
    },
  };

  if (partIds.size) {
    questions.part = {
      type: 'choice',
      instructions: `Which part of the page most likely contains a control ${ASK} asks to act on?`,
      criteria: Object.fromEntries([...partIds].map(([id, s]) => [id, `${sectionName(s.label) ?? 'an unnamed section'} (${s.count} controls)`])),
    };
  }

  if (input.actionsDone.length) {
    questions.goal_done = {
      type: 'noul',
      instructions: `Do the actions in \`actions_done\` complete everything ${ASK} asks for?`,
      criteria: {
        true: 'Every control the request asks to click, choose, switch or type into has been, and every menu it asks to open has been opened.',
        false: 'A click, choice, switch, typing or opening the request asks for has not happened yet, or a different control was acted on.',
      },
    };
  }

  if (tabIds.size) {
    questions.browser_tab = {
      type: 'choice',
      instructions: `Which browser tab in \`tabs\` does ${ASK} ask to switch to?`,
      criteria: { ...Object.fromEntries([...tabIds].map(([id]) => [id, (state.tabs as Record<string, string>)[id]!])), none: `${ASK} does not ask to switch to any tab in \`tabs\`.` },
    };
  }

  return { request: { state, questions }, ids, tabIds, partIds };
}

export type LocateVerdict =
  | { kind: 'done'; confidence: number }
  | { kind: 'switch_tab'; tab: TabInfo; confidence: number }
  | { kind: 'act'; control: BrowserControl; confidence: number }
  | { kind: 'reveal'; control: BrowserControl; confidence: number }
  | { kind: 'open'; control: BrowserControl; confidence: number }
  | { kind: 'unsure'; control: BrowserControl; confidence: number }
  /** `order`: unread partition ids, most likely first (only when `part` was asked). */
  | { kind: 'read'; order: string[]; confidence: number };

export class InvalidAnswer extends Error {}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : NaN);

function choice(answer: JevAnswer | undefined, ids: ReadonlyMap<string, unknown>, name: string): { id: string | 'none'; confidence: number } {
  const confidence = num(answer?.confidence);

  if (!answer?.choice || !Number.isFinite(confidence)) throw new InvalidAnswer(`Jev 未回答 ${name}`);

  if (answer.choice !== 'none' && !ids.has(answer.choice)) throw new InvalidAnswer(`Jev 在 ${name} 选了未知选项`);

  return { id: answer.choice, confidence };
}

function noul(answer: JevAnswer | undefined, name: string): number {
  const value = num(answer?.noul);

  if (!Number.isFinite(value)) throw new InvalidAnswer(`Jev 未回答 ${name}`);

  return value;
}

export interface LocateContext {
  hasActions: boolean;
  /** Openers already hovered in this loop. */
  hovered: ReadonlySet<string>;
  /** Of those, the ones whose hover showed nothing new: opening them takes a click. */
  hoverShowedNothing: ReadonlySet<string>;
}

/**
 * Order: done → switch to a named tab → act on a confident listed target → reveal a confident opener by
 * hovering → click an opener hovering did not open → stop on an unsure listed target → read on.
 * A target that is also the confident, not yet hovered opener is revealed first (hover changes nothing);
 * it is acted on at a later observation if it is still the target.
 */
export function composeLocate(answers: JevAnswers, located: LocateRequest, ctx: LocateContext): LocateVerdict {
  if (ctx.hasActions) {
    const done = noul(answers.goal_done, 'goal_done');

    if (done >= GOAL_DONE_THRESHOLD) return { kind: 'done', confidence: done };
  }

  if (located.tabIds.size) {
    const tab = choice(answers.browser_tab, located.tabIds, 'browser_tab');

    if (tab.id !== 'none' && tab.confidence >= ACT_THRESHOLD) return { kind: 'switch_tab', tab: located.tabIds.get(tab.id)!, confidence: tab.confidence };
  }

  const target = choice(answers.target, located.ids, 'target');
  const listed = noul(answers.target_listed, 'target_listed');
  const opener = choice(answers.opener, located.ids, 'opener');
  const tControl = target.id !== 'none' ? located.ids.get(target.id) : undefined;
  const oControl = opener.id !== 'none' && opener.confidence >= ACT_THRESHOLD ? located.ids.get(opener.id) : undefined;
  // Only something clicked can hide a menu behind it; a dropdown with observed options, a field or a toggle is acted on directly.
  const canReveal = !!oControl && actKind(oControl) === 'click' && !isMarked(ctx.hovered, oControl);

  if (tControl && listed >= LISTED_MIN && target.confidence >= ACT_THRESHOLD && !(canReveal && oControl === tControl)) {
    return { kind: 'act', control: tControl, confidence: target.confidence };
  }

  if (oControl && canReveal) return { kind: 'reveal', control: oControl, confidence: opener.confidence };

  if (oControl && actKind(oControl) === 'click' && isMarked(ctx.hoverShowedNothing, oControl)) return { kind: 'open', control: oControl, confidence: opener.confidence };

  if (tControl && listed >= LISTED_MIN) return { kind: 'unsure', control: tControl, confidence: target.confidence };
  const part = answers.part?.probabilities;
  const order = part ? Object.entries(part).filter(([id]) => located.partIds.has(id)).sort((a, b) => b[1] - a[1]).map(([id]) => located.partIds.get(id)!.id) : [];

  // A pick the presence Noul disagrees with is not acted on: keep reading.
  return { kind: 'read', order, confidence: 1 - listed };
}

// ── act: one small request about the chosen control ────────────────────────

export interface ActInput {
  request: Record<string, unknown>;
  control: BrowserControl;
  kind: ActKind;
  actionsDone: readonly string[];
  materials: readonly BrowserMaterial[];
}

export interface ActRequest {
  request: JevRequest;
  optionIds: Map<string, NonNullable<BrowserControl['options']>[number]>;
  materialIds: Map<string, BrowserMaterial>;
}

/** Null when nothing needs asking (a fill with no supplied material goes to the text helper). */
export function buildActRequest(input: ActInput): ActRequest | null {
  const { control, kind } = input;
  const state: Record<string, unknown> = { request: input.request, control: describeControl(control) };

  if (input.actionsDone.length) state.actions_done = [...input.actionsDone];
  const questions: Record<string, unknown> = {};
  const optionIds = new Map((control.options ?? []).filter(o => !o.disabled).map((o, i) => [`o${i + 1}`, o] as const));
  const materialIds = new Map(input.materials.map((m, i) => [`m${i + 1}`, m] as const));

  if (kind === 'click' || kind === 'toggle') {
    questions.risky = {
      type: 'noul',
      instructions: 'Would activating `control` delete or permanently remove something, pay or buy something, send a message or invitation, or publish or post something?',
      criteria: {
        true: 'It deletes or removes data or an account, pays or buys, sends a message, email or invitation, or publishes or posts content.',
        false: 'It opens, shows, selects, saves, switches a setting or navigates, or makes another change that can simply be undone.',
      },
    };
  }

  if (kind === 'toggle') {
    questions.turn_on = {
      type: 'noul',
      instructions: `Does ${ASK} ask for \`control\` to end up switched on (checked)?`,
      criteria: { true: 'The request asks to turn it on, enable, check or select it.', false: 'The request asks to turn it off, disable, uncheck or clear it.' },
    };
  }

  if (kind === 'select') {
    state.options = Object.fromEntries([...optionIds].map(([id, o]) => [id, clip(o.label, 160)]));
    questions.option = {
      type: 'choice',
      instructions: `Which option in \`options\` does ${ASK} ask to choose for \`control\`?`,
      criteria: { ...(state.options as Record<string, string>), none: `${ASK} does not name any option in \`options\`.` },
    };
  }

  if (kind === 'fill') {
    if (!materialIds.size) return null;
    state.materials = Object.fromEntries([...materialIds].map(([id, m]) => [id, `${clip(m.purpose, 120)}: "${clip(m.value, 160)}"`]));
    questions.value = {
      type: 'choice',
      instructions: `Which text in \`materials\` does ${ASK} ask to type into \`control\`?`,
      criteria: { ...(state.materials as Record<string, string>), none: `None of \`materials\` is the text ${ASK} asks to type into \`control\`.` },
    };
  }

  return { request: { state, questions }, optionIds, materialIds };
}

export type ActVerdict =
  | { kind: 'click'; risk: number }
  | { kind: 'risky'; risk: number }
  | { kind: 'already'; on: boolean }
  | { kind: 'toggle'; on: boolean; risk: number }
  | { kind: 'select'; option: NonNullable<BrowserControl['options']>[number]; confidence: number }
  | { kind: 'fill'; material: BrowserMaterial; confidence: number }
  | { kind: 'generate' }
  | { kind: 'unsure'; confidence: number };

export function composeAct(kind: ActKind, control: BrowserControl, answers: JevAnswers, asked: ActRequest | null): ActVerdict {
  if (kind === 'click' || kind === 'toggle') {
    const risk = noul(answers.risky, 'risky');

    if (risk >= RISK_BLOCK) return { kind: 'risky', risk };

    if (kind === 'click') return { kind: 'click', risk };
    const on = noul(answers.turn_on, 'turn_on');

    if (on < TOGGLE_CLEAR && on > 1 - TOGGLE_CLEAR) return { kind: 'unsure', confidence: Math.max(on, 1 - on) };
    const want = on >= TOGGLE_CLEAR;

    return (control.checked === true) === want ? { kind: 'already', on: want } : { kind: 'toggle', on: want, risk };
  }

  if (kind === 'select') {
    const picked = choice(answers.option, asked!.optionIds, 'option');

    if (picked.id === 'none' || picked.confidence < ACT_THRESHOLD) return { kind: 'unsure', confidence: picked.confidence };

    return { kind: 'select', option: asked!.optionIds.get(picked.id)!, confidence: picked.confidence };
  }

  if (!asked) return { kind: 'generate' };
  const picked = choice(answers.value, asked.materialIds, 'value');

  if (picked.id === 'none' || picked.confidence < ACT_THRESHOLD) return { kind: 'generate' };

  return { kind: 'fill', material: asked.materialIds.get(picked.id)!, confidence: picked.confidence };
}
