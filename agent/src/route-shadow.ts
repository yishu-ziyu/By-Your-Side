import {appendFileSync, existsSync, mkdirSync, readFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {readTypeSafeKey} from "./typesafe-auth.js";
import {routeShadowDailyLimit, routeShadowEnabled} from "./config.js";

/** Same endpoint/model as agent/src/goal-evidence-judge.ts and docs/evals/20260921-routing-experiment/route-compare.py. */
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const TIMEOUT_MS = 4000;

/** 8 lanes, copied verbatim from route-compare.py's LANES so a week of shadow data compares directly with the offline experiment. */
const LANES: Record<string, string> = {
  chat: "Greeting, acknowledgement, emotion or commentary that asks for nothing to be done or looked up",
  answer: "A general knowledge or opinion question answerable without the browser or the current page",
  page_question: "Asks what is on the current page or whether the assistant can see it; answerable by reading the current page text without changing the page",
  task: "Asks the assistant to act in the browser or produce a result on the page: open, switch, close, refresh, click, search, translate the page, mark or highlight on the page, copy into another site, take a screenshot, list or count tabs",
  steer: 'Corrects, narrows or adds a constraint to something the assistant is already doing or just did wrong, including "not like that, do it this way"',
  control: "Pause, resume, cancel or drop the current task, or stop speaking",
  status: "Asks how the running task is going or asks for a progress report",
  incomplete: "A fragment or cut-off phrase that does not yet state a complete request",
};

/** Same two questions as route-compare.py's route_questions(1): lane_0 (choice over the 8 lanes) and pagechange_0 (noul). */
function routeQuestions(): Record<string, unknown> {
  return {
    lane_0: {
      type: "choice",
      instructions: {
        question: "For the utterance at `utterances[0]`, decide which handling lane a browser copilot should use. The copilot sits beside the user's current browser tab and can reply by voice or text, read the current page text, or hand the request to a browser task engine that performs actions or changes what the page shows and then verifies the result. Utterances come from speech recognition or typed text and may contain recognition errors; judge the intended request. Use `utterances[0].previous` (earlier utterances in the same session, oldest first) and `utterances[0].taskRunning` when they help.",
      },
      criteria: LANES,
    },
    pagechange_0: {
      type: "noul",
      instructions: "Does the user in `utterances[0]` want something to change or appear on the web page itself, rather than only being told or read to them?",
      criteria: {
        true: "The user expects a visible result on the page: navigation, a switch, marks, translation shown in the page, filled text, and so on",
        false: "A spoken or written reply satisfies the request, or no request is made",
      },
    },
  };
}

export interface RouteShadowObserveInput {
  channel: "voice" | "text";
  conversationId: string;
  voiceId?: string;
  turn?: number;
  itemId?: string;
  text: string;
  previous: string[];
  taskRunning: boolean | "unknown";
  taskState?: string;
  page?: {title?: string; url?: string};
}

export interface RouteShadowActualInput {
  channel: "voice" | "text";
  conversationId: string;
  voiceId?: string;
  turn?: number;
  itemId?: string;
  kind: "tool" | "dispatch" | "entry";
  name?: string;
  action?: string;
  status?: string;
  note?: string;
}

export interface RouteShadowOptions {
  enabled: () => boolean;
  dailyLimit: () => number;
  root?: string;
  key?: () => string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface JevAnswer {choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number}
interface JevResponse {answers?: {lane_0?: JevAnswer; pagechange_0?: JevAnswer}; usage?: Record<string, number>}

function dayKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Same state shape as route-compare.py: {channel, utterances:[{text, previous, taskRunning}]}; page/taskState are additive. */
function buildState(input: RouteShadowObserveInput): Record<string, unknown> {
  return {
    channel: input.channel,
    utterances: [{
      text: input.text,
      previous: input.previous,
      taskRunning: input.taskRunning,
      ...(input.taskState !== undefined ? {taskState: input.taskState} : {}),
      ...(input.page !== undefined ? {page: input.page} : {}),
    }],
  };
}

/**
 * Observability-only shadow router: on every utterance, asks Jev which lane it belongs to in parallel
 * with the real host, and separately records what the host actually did — for offline comparison only.
 * Never influences routing, never throws to its caller, and is a strict no-op while `enabled()` is false.
 */
export class RouteShadow {
  private readonly root: string;
  private readonly enabled: () => boolean;
  private readonly dailyLimit: () => number;
  private readonly key: () => string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private callsToday = 0;
  private countedDay = "";

  constructor(options: RouteShadowOptions) {
    this.enabled = options.enabled;
    this.dailyLimit = options.dailyLimit;
    this.root = options.root ?? process.env.SIDEAGENT_ROUTE_SHADOW_DIR ?? join(homedir(), ".sideagent", "route-shadow");
    this.key = options.key ?? readTypeSafeKey;
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Fire-and-forget: never awaited by callers, never throws. Zero calls and zero writes while disabled. */
  observe(input: RouteShadowObserveInput): void {
    if (!this.enabled()) return;
    const at = this.now();
    const base = {at, channel: input.channel, conversationId: input.conversationId, voiceId: input.voiceId, turn: input.turn, itemId: input.itemId, text: input.text};
    let key = "";
    try { key = this.key(); } catch { key = ""; }
    if (!key) { this.write({type: "skipped", ...base, reason: "no_credential"}); return; }
    if (!this.reserveCallSlot(dayKey(at))) { this.write({type: "skipped", ...base, reason: "daily_limit"}); return; }
    void this.callJev(input, base, key);
  }

  /** Synchronous, local-only write of what actually happened. Zero writes while disabled. */
  actual(input: RouteShadowActualInput): void {
    if (!this.enabled()) return;
    this.write({type: "actual", at: this.now(), ...input});
  }

  private async callJev(input: RouteShadowObserveInput, base: {at: number} & Record<string, unknown>, key: string): Promise<void> {
    try {
      const started = this.now();
      const body = JSON.stringify({model: MODEL, state: buildState(input), questions: routeQuestions()});
      const response = await this.doFetch(ENDPOINT, {
        method: "POST",
        headers: {Authorization: `Bearer ${key}`, "Content-Type": "application/json"},
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) { this.write({type: "skipped", ...base, reason: `http_${response.status}`}); return; }
      const data = await response.json() as JevResponse;
      const lane = data.answers?.lane_0;
      if (!lane || typeof lane.choice !== "string") { this.write({type: "skipped", ...base, reason: "invalid_response"}); return; }
      const pagechange = data.answers?.pagechange_0;
      this.write({
        type: "utterance", at: base.at, channel: input.channel, conversationId: input.conversationId, voiceId: input.voiceId, turn: input.turn, itemId: input.itemId,
        text: input.text, previous: input.previous, taskRunning: input.taskRunning, taskState: input.taskState, page: input.page,
        jev: {lane: lane.choice, confidence: lane.confidence, probabilities: lane.probabilities, pageChange: pagechange?.noul, ms: this.now() - started, usage: data.usage},
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      this.write({type: "skipped", ...base, reason: timedOut ? "timeout" : "fetch_error"});
    }
  }

  /** True (and reserves a slot) while today's Jev-call budget has room; false once it is exhausted. */
  private reserveCallSlot(day: string): boolean {
    if (day !== this.countedDay) { this.countedDay = day; this.callsToday = this.countExistingCalls(day); }
    if (this.callsToday >= this.dailyLimit()) return false;
    this.callsToday++;
    return true;
  }

  /** Recovers today's already-spent call budget from disk, so a process restart mid-day does not reopen it. */
  private countExistingCalls(day: string): number {
    const path = this.pathFor(day);
    if (!existsSync(path)) return 0;
    let count = 0;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as {type?: string; reason?: string};
          if (record.type === "utterance" || (record.type === "skipped" && record.reason !== "daily_limit" && record.reason !== "no_credential")) count++;
        } catch { /* malformed line: ignore, do not fail the count */ }
      }
    } catch { return 0; }
    return count;
  }

  private pathFor(day: string): string {
    return join(this.root, `${day}.jsonl`);
  }

  private write(record: {at: number} & Record<string, unknown>): void {
    try {
      mkdirSync(this.root, {recursive: true});
      appendFileSync(this.pathFor(dayKey(record.at)), `${JSON.stringify(record)}\n`);
    } catch { /* local diagnostics only; never break the caller */ }
  }
}

let shared: RouteShadow | null = null;
/** One process-wide instance so voice and text entry points share the same daily Jev-call budget. */
export function sharedRouteShadow(): RouteShadow {
  if (!shared) shared = new RouteShadow({enabled: routeShadowEnabled, dailyLimit: routeShadowDailyLimit});
  return shared;
}
