import { isPanelUrl } from "../shared/panel-url.js";
import type { AgentUiEvent } from "../../../shared/protocol.js";
import { ATTENTION_CUES_KEY, isCuesOn } from "../shared/cues.js";

type Note = readonly [hz: number, at: number, decay: number];

const DONE: readonly Note[] = [[523.25, 0, 0.6], [659.25, 0.09, 0.6], [783.99, 0.18, 0.8]];

const NEEDS_YOU: readonly Note[] = [[659.25, 0, 0.4], [587.33, 0.2, 0.6]];

const PEAK_GAIN = 0.18;

const SUSPEND_AFTER_MS = 1_000;

const PRESENCE_WAIT_MS = 300;

let ctx: AudioContext | null = null;

let suspendTimer: ReturnType<typeof setTimeout> | undefined;

let stopped = false;

let doneCued = false;

let waitingFor: string | null = null;

let awaitingVerdict = false;

export function observeForCue(ev: AgentUiEvent): void {
  switch (ev.kind) {
    case "agent_start":
      stopped = false;
      doneCued = false;
      waitingFor = null;
      awaitingVerdict = false;
      break;
    case "run_stopped":
      stopped = true;
      break;
    case "agent_end":
      if (!awaitingVerdict) cueDone();
      break;
    case "goal_check":
      if (ev.status === "checking") {
        awaitingVerdict = true;
        break;
      }

      if (!awaitingVerdict) break;
      awaitingVerdict = false;

      if (stopped || ev.status === "continue") break;

      if (ev.status === "needs_user") waitOn("goal-needs-user");
      else cueDone();
      break;
    case "send_confirm_wait":
      waitOn(ev.waiting ? "send" : null);
      break;
    case "guide_wait":
      waitOn(ev.waiting ? `guide-${ev.guide?.step ?? ""}` : null);
      break;
    case "tool_start":
      if (ev.name === "hand_to_user") waitOn(`hand-${ev.toolCallId}`);
      break;
    default:
      break;
  }
}

function cueDone(): void {
  if (stopped || doneCued || waitingFor) return;
  doneCued = true;
  void play(DONE);
}

function waitOn(key: string | null): void {
  if (key && key !== waitingFor && !stopped) void play(NEEDS_YOU);
  waitingFor = key;
}

async function play(notes: readonly Note[]): Promise<void> {
  if (!(await enabled()) || !(await playsHere()) || agentSpeaking()) return;
  ctx ??= new AudioContext();
  const running = ctx.state === "running" || await ctx.resume().then(() => true, () => false);

  if (!running) return;
  const start = ctx.currentTime;
  let end = 0;

  for (const [hz, at, decay] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, start + at);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + decay);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start + at);
    osc.stop(start + at + decay + 0.05);
    end = Math.max(end, at + decay + 0.05);
  }

  clearTimeout(suspendTimer);
  const playing = ctx;
  suspendTimer = setTimeout(() => void playing.suspend().catch(() => {}), end * 1000 + SUSPEND_AFTER_MS);
}

async function enabled(): Promise<boolean> {
  try {
    return isCuesOn((await chrome.storage.local.get(ATTENTION_CUES_KEY))[ATTENTION_CUES_KEY]);
  } catch {
    return true;
  }
}

async function playsHere(): Promise<boolean> {
  const mine = await myWindow;
  const focused = await chrome.windows.getLastFocused().catch(() => null);

  if (mine === null || !focused) return false;
  const windows = await panelWindows(mine);
  const watched = focused.focused && focused.id !== undefined && windows.includes(focused.id);

  return !watched && mine === Math.min(...windows);
}

const PRESENCE_CHANNEL = "sideagent-cue-presence";

const myWindow: Promise<number | null> = chrome.windows.getCurrent().then(w => w.id ?? null, () => null);

const windowIdOf = (data: unknown): number | null => typeof data === "object" && data !== null && "windowId" in data && typeof data.windowId === "number" ? data.windowId : null;

const presence = new BroadcastChannel(PRESENCE_CHANNEL);

presence.onmessage = (event: MessageEvent<unknown>) => {
  if (event.data === "who") void myWindow.then(id => { if (id !== null) presence.postMessage({ windowId: id }); });
};

async function panelWindows(mine: number): Promise<number[]> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL, chrome.runtime.ContextType.TAB] }).catch(() => []);
  const count = contexts.filter(c => c.contextType === chrome.runtime.ContextType.SIDE_PANEL || isPanelUrl(c.documentUrl)).length;
  const windows = new Set([mine]);

  if (count <= 1) return [...windows];
  const ask = new BroadcastChannel(PRESENCE_CHANNEL);
  await new Promise<void>(done => {
    const timer = setTimeout(done, PRESENCE_WAIT_MS);
    ask.onmessage = (event: MessageEvent<unknown>) => {
      const id = windowIdOf(event.data);

      if (id !== null) windows.add(id);

      if (windows.size >= count) {
        clearTimeout(timer);
        done();
      }
    };
    ask.postMessage("who");
  });
  ask.close();

  return [...windows];
}

function agentSpeaking(): boolean {
  return document.querySelector<HTMLElement>(".voice-progress")?.dataset.state === "speaking";
}
