import { performance } from 'node:perf_hooks';
import type { BrowserObservation } from '../../shared/browser-decision.js';
import type { TranslationDisplayState } from '../../shared/page-translation.js';
import { bindSkillInputs, type Skill, type SkillRun } from '../../shared/skill.js';
import {
  capabilities as displayCapabilities,
  composeDisplayDecision,
  questions as displayQuestions,
  type DisplayParams,
} from './display-fast-path.js';
import { skillSourceValues } from './skill-judge.js';
import { composeSkillJudgment, type SkillRouterInput } from './skill-router.js';
import { readTypeSafeKey } from './typesafe-auth.js';

export interface FastTaskSkillOption {
  skill: Skill;
  runs: SkillRun[];
  selected: boolean;
  suppliedInputs?: Record<string, string>;
  allowStale?: boolean;
}

export interface FastTaskDecisionInput {
  request: string;
  observation: BrowserObservation;
  translation?: TranslationDisplayState | null;
  allowSwitch: boolean;
  allowDisplay: boolean;
  skills?: FastTaskSkillOption[];
}

export interface FastTaskDiagnostics {
  actionRequested?: number;
  complete?: number;
  route?: {
    choice?: string;
    confidence?: number;
    selectedProbability?: number;
    probabilities?: Record<string, number>;
  };
  display?: {
    extra?: number;
    partial?: number;
    fontRequested?: number;
    modeRequested?: number;
    fontChoice?: string;
    modeChoice?: string;
  };
}

export type FastTaskMissReason =
  | 'no_candidate'
  | 'tabs_truncated'
  | 'missing_credentials'
  | 'invalid_response'
  | 'request_uncertain'
  | 'coverage_uncertain'
  | 'route_uncertain'
  | 'normal_route'
  | 'timeout'
  | 'late_response'
  | 'network_error'
  | 'skill_unavailable'
  | 'skill_needs_input'
  | `http_${number}`
  | `display_${string}`;

export type FastTaskDecision =
  | {
      kind: 'candidate';
      diagnostics: FastTaskDiagnostics;
      candidate: {
        kind: 'switch_tab';
        tab: { id: number; title: string; url: string };
      } | {
        kind: 'display';
        params: DisplayParams;
      } | {
        kind: 'skill';
        skill: {
          id: string;
          version: number;
          name: string;
          description: string;
          criterion: string;
          inputs: Record<string, string>;
          allowStale?: boolean;
        };
      };
    }
  | { kind: 'miss'; reason: FastTaskMissReason; diagnostics?: FastTaskDiagnostics }
  | { kind: 'cancelled'; diagnostics?: FastTaskDiagnostics };

interface TypeSafeAnswer {
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface TypeSafeResponse {
  answers?: Record<string, TypeSafeAnswer>;
}

const MIN_PROBABILITY = 0.9;

const INPUT_MIN_PROBABILITY = 0.98;

const CALL_TIMEOUT_MS = 1_000;

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function numericProbabilities(value: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!value) return undefined;

  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => probability(entry[1])));
}

function sameDisplayParams(left: DisplayParams, right: DisplayParams): boolean {
  return left.fontFamily === right.fontFamily && left.mode === right.mode;
}

/**
 * One semantic choice for browser-owned, host-verifiable whole-task candidates.
 * Code still binds the selected goal before execution and owns verification,
 * persistence, and delivery.
 */
export async function decideFastTask(input: FastTaskDecisionInput, signal: AbortSignal): Promise<FastTaskDecision> {
  if (signal.aborted) return { kind: 'cancelled' };

  if (!input.request.trim() || input.request.length > 3_000) {
    return { kind: 'miss', reason: 'coverage_uncertain' };
  }

  const tabs = input.allowSwitch && !input.observation.tabsTruncated
    ? (input.observation.tabs ?? [])
    : [];

  const displayAvailable = input.allowDisplay
    && input.translation?.translated
    && input.translation.displayValid;

  const skillOptions = (input.skills ?? []).slice(0, 12);

  if (!tabs.length && !displayAvailable && !skillOptions.length) {
    return { kind: 'miss', reason: input.observation.tabsTruncated ? 'tabs_truncated' : 'no_candidate' };
  }

  const key = readTypeSafeKey();

  if (!key) return { kind: 'miss', reason: 'missing_credentials' };

  const displayRoutes: Record<string, { params: DisplayParams; description: string }> = displayAvailable ? {
    display_translated: {
      params: { action: 'display', mode: 'translated' },
      description: 'On the current page, keep the existing translation visible and hide the original source text. This changes display only and does not translate, summarize, or report page content.',
    },
    display_bilingual: {
      params: { action: 'display', mode: 'bilingual' },
      description: 'On the current page, show the original source text together with its existing translation. This changes display only.',
    },
    display_songti: {
      params: { action: 'display', fontFamily: 'songti' },
      description: 'On the current page, render the existing translated text in Songti/宋体 while preserving the current original-versus-translation display mode.',
    },
    display_translated_songti: {
      params: { action: 'display', mode: 'translated', fontFamily: 'songti' },
      description: 'On the current page, hide the original source text, keep the existing translation visible, and render that translation in Songti/宋体.',
    },
    display_bilingual_songti: {
      params: { action: 'display', mode: 'bilingual', fontFamily: 'songti' },
      description: 'On the current page, show original and existing translation together, and render the translation in Songti/宋体.',
    },
  } : {};

  const candidates: Record<string, string> = {
    ...Object.fromEntries(tabs.map((tab, index) => [
      `tab_${index}`,
      `Make the already observed browser tab titled ${JSON.stringify(tab.title)} at ${JSON.stringify(tab.url)} the actual active Chrome tab. The only user reply is a verified switch acknowledgment; this candidate does not summarize or answer questions about that page.`,
    ])),
    ...Object.fromEntries(Object.entries(displayRoutes).map(([id, route]) => [id, route.description])),
    ...Object.fromEntries(skillOptions.map((option, index) => [
      `skill_${index}`,
      `Run the parameterized saved workflow ${JSON.stringify(option.skill.requestTemplate ?? option.skill.intent)} on the current site. Replace its placeholders ${JSON.stringify(Object.keys(option.skill.inputs))} with values explicitly supplied in this request. Different supplied values are normal arguments to the same workflow, not extra work. Every required value must be present before execution. The workflow leaves its real result visible in the browser and verifies it with ${JSON.stringify(option.skill.check.text)}. The assistant's notification is only a generic verified completion acknowledgment; it does not quote, read aloud, list, or summarize the visible result.`,
    ])),
    normal: 'No direct candidate fully satisfies the request: it is a question, negative instruction, correction, ambiguous reference, compound task, or needs another operation or user-visible answer.',
  };

  const values = skillSourceValues(input.request);

  const questions: Record<string, unknown> = {
    action_requested: {
      type: 'noul',
      instructions: 'Does `request` ask the assistant to perform an action now? Polite phrasing such as “I want to see X, switch to it” is a present action request. Questions about whether a tab is open or what is on a page, quoted instructions, future conditions, corrections without a clear target, and explicit do-not-act requests are not present action requests.',
      criteria: {
        true: 'A present request to perform one concrete action now.',
        false: 'Discussion, question, quotation, future condition, cancellation, negative instruction, or unclear correction.',
      },
    },
    complete: {
      type: 'noul',
      instructions: 'Would one complete outcome listed in `candidateOutcomes`, followed only by its short verified completion acknowledgment, fully satisfy every part of `request`? A display candidate includes the exact visible effect written in that candidate. A saved workflow accepts new values for its named placeholders: changing those argument values still requests the same workflow, while missing values prevent execution. The workflow itself produces and verifies its browser-visible result, so an ordinary request to perform that workflow is complete. If the user additionally asks the assistant to quote, read aloud, list, explain, or summarize that result, the generic acknowledgment is insufficient. Answer no for switch-then-summarize, multiple outcomes, negative commands, status questions, ambiguous targets, or any extra condition the candidate does not deliver.',
      criteria: {
        true: 'One listed candidate outcome and its verified acknowledgment fully satisfy the whole request.',
        false: 'The request needs an answer, summary, another action, unresolved reference, or unsupported constraint.',
      },
    },
    route: {
      type: 'choice',
      instructions: 'Select the single candidate whose written outcome fully matches the whole request. For a saved parameterized workflow, changed placeholder values are allowed when the request explicitly supplies them; extra operations or constraints are not. Select normal when no one candidate covers every requested outcome, the target is ambiguous, or the user asks a question or says not to act.',
      criteria: candidates,
    },
  };

  if (displayAvailable) {
    questions.display_extra = displayQuestions.extra;
    questions.display_partial = displayQuestions.partial;
    questions.font_requested = displayQuestions.font_requested;
    questions.mode_requested = displayQuestions.mode_requested;
    questions.font = displayQuestions.font;
    questions.mode = displayQuestions.mode;
  }

  skillOptions.forEach((option, index) => {
    if (option.selected) return;
    Object.keys(option.skill.inputs).forEach((name, inputIndex) => {
      questions[`skill_input_${index}_${inputIndex}`] = {
        type: 'choice',
        instructions: `For saved workflow ${index}, select the value explicitly supplied for required input ${JSON.stringify(name)}. Do not use a historical default or infer missing material.`,
        criteria: {
          missing: 'Not explicitly provided, ambiguous, or irrelevant.',
          ...Object.fromEntries(values.map((value, valueIndex) => [`value_${valueIndex}`, value])),
        },
      };
    });
  });

  const body = JSON.stringify({
    model: 'jev-1.13.0',
    state: {
      request: input.request,
      candidateOutcomes: candidates,
      browserTabs: tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active })),
      currentPage: { tabId: input.observation.tabId, url: input.observation.url },
      ...(displayAvailable ? {
        existingTranslation: input.translation,
        supportedDisplayEffects: Object.fromEntries(Object.entries(displayRoutes).map(([id, route]) => [id, route.description])),
        displayCapabilities,
      } : {}),
      ...(skillOptions.length ? {
        savedSkills: skillOptions.map(option => ({
          id: option.skill.id,
          task: option.skill.requestTemplate ?? option.skill.intent,
          requiredInputKeys: Object.keys(option.skill.inputs),
          explicitlySelected: option.selected,
        })),
        explicitSourceValues: values,
      } : {}),
    },
    questions,
  });

  if (Buffer.byteLength(body) > 64_000) return { kind: 'miss', reason: 'coverage_uncertain' };

  const startedAt = performance.now();

  try {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    });

    if (signal.aborted) return { kind: 'cancelled' };

    if (!response.ok) return { kind: 'miss', reason: `http_${response.status}` };

    let raw: TypeSafeResponse;

    try {
      raw = await response.json() as TypeSafeResponse;
    } catch {
      return { kind: 'miss', reason: 'invalid_response' };
    }

    if (signal.aborted) return { kind: 'cancelled' };

    if (performance.now() - startedAt >= CALL_TIMEOUT_MS) return { kind: 'miss', reason: 'late_response' };

    const answers = raw.answers ?? {};
    const route = answers.route;
    const selectedProbability = route?.choice ? route.probabilities?.[route.choice] : undefined;

    const diagnostics: FastTaskDiagnostics = {
      actionRequested: answers.action_requested?.noul,
      complete: answers.complete?.noul,
      route: {
        choice: route?.choice,
        confidence: route?.confidence,
        selectedProbability,
        probabilities: numericProbabilities(route?.probabilities),
      },
      ...(displayAvailable ? {
        display: {
          extra: answers.display_extra?.noul,
          partial: answers.display_partial?.noul,
          fontRequested: answers.font_requested?.noul,
          modeRequested: answers.mode_requested?.noul,
          fontChoice: answers.font?.choice,
          modeChoice: answers.mode?.choice,
        },
      } : {}),
    };

    const miss = (reason: FastTaskMissReason): FastTaskDecision => ({ kind: 'miss', reason, diagnostics });

    if (!probability(diagnostics.actionRequested) || diagnostics.actionRequested < MIN_PROBABILITY) {
      return miss('request_uncertain');
    }

    if (!probability(diagnostics.complete) || diagnostics.complete < MIN_PROBABILITY) {
      return miss('coverage_uncertain');
    }

    if (!route?.choice || !Object.hasOwn(candidates, route.choice)
      || !probability(route.confidence) || route.confidence < MIN_PROBABILITY
      || !probability(selectedProbability) || selectedProbability < MIN_PROBABILITY) {
      return miss('route_uncertain');
    }

    if (route.choice === 'normal') return miss('normal_route');

    const displayRoute = displayRoutes[route.choice];

    if (displayRoute) {
      const display = composeDisplayDecision({
        direct: answers.action_requested,
        extra: answers.display_extra,
        partial: answers.display_partial,
        font_requested: answers.font_requested,
        mode_requested: answers.mode_requested,
        font: answers.font,
        mode: answers.mode,
      }, true);

      if (display.kind === 'cancelled') return { kind: 'cancelled', diagnostics };

      if (display.kind === 'fallback') return miss(`display_${display.reason}`);

      if (!sameDisplayParams(display.params, displayRoute.params)) return miss('route_uncertain');

      return { kind: 'candidate', diagnostics, candidate: { kind: 'display', params: display.params } };
    }

    const skillMatch = /^skill_(\d+)$/.exec(route.choice);

    if (skillMatch) {
      const selectedIndex = Number(skillMatch[1]);
      const option = skillOptions[selectedIndex];

      if (!option) return miss('invalid_response');
      let inputs: Record<string, string>;

      if (option.selected) {
        try {
          inputs = bindSkillInputs(option.skill, option.suppliedInputs);
        } catch {
          return miss('skill_needs_input');
        }
      } else {
        const extracted: Record<string, string> = {};
        Object.keys(option.skill.inputs).forEach((name, inputIndex) => {
          const answer = answers[`skill_input_${selectedIndex}_${inputIndex}`];
          const selected = /^value_(\d+)$/.exec(answer?.choice ?? '');
          const selectedInputProbability = answer?.choice ? answer.probabilities?.[answer.choice] : undefined;

          if (selected && probability(selectedInputProbability) && selectedInputProbability >= INPUT_MIN_PROBABILITY) {
            const value = values[Number(selected[1])];

            if (value !== undefined) extracted[name] = value;
          }
        });

        const skillInput: SkillRouterInput = {
          userText: input.request,
          hostname: option.skill.hostname,
          skills: skillOptions.map(item => item.skill),
          runs: Object.fromEntries(skillOptions.map(item => [item.skill.id, item.runs])),
        };

        const composed = composeSkillJudgment(skillInput, {
          direct: diagnostics.actionRequested,
          complete: diagnostics.complete,
          candidates: skillOptions.map((item, index) => ({
            skillId: item.skill.id,
            probability: route.probabilities?.[`skill_${index}`] ?? 0,
            inputs: index === selectedIndex ? extracted : {},
          })),
        });

        if (composed.status === 'needs_input') return miss('skill_needs_input');

        if (composed.status !== 'match' || composed.skillId !== option.skill.id) return miss('skill_unavailable');
        inputs = composed.inputs;
      }

      return {
        kind: 'candidate',
        diagnostics,
        candidate: {
          kind: 'skill',
          skill: {
            id: option.skill.id,
            version: option.skill.version,
            name: option.skill.name,
            description: option.skill.intent,
            criterion: option.skill.check.text,
            inputs,
            ...(option.allowStale ? { allowStale: true } : {}),
          },
        },
      };
    }

    const tabMatch = /^tab_(\d+)$/.exec(route.choice);
    const tab = tabMatch ? tabs[Number(tabMatch[1])] : undefined;

    if (!tab) return miss('invalid_response');

    return {
      kind: 'candidate',
      diagnostics,
      candidate: { kind: 'switch_tab', tab: { id: tab.id, title: tab.title, url: tab.url } },
    };
  } catch (error) {
    if (signal.aborted) return { kind: 'cancelled' };

    const timeout = error instanceof Error
      && (error.name === 'TimeoutError' || /timed? ?out/i.test(error.message));

    return { kind: 'miss', reason: timeout ? 'timeout' : 'network_error' };
  }
}
