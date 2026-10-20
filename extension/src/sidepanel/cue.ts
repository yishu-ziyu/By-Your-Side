import { isPanelUrl } from "../shared/panel-url.js";
/**
 * 提示音：用户没在看任何开着侧栏的窗口时，任务做完响一声，
 * 要用户出手（确认发送、教学一步、页面交给用户、目标核对判「等你」）时响另一声。用户在看就不响。
 *
 * 声音用 Web Audio 现场合成，不带音频文件。设置页「提示音」关掉就不响。
 */
import type { AgentUiEvent } from "../../../shared/protocol.js";
import { ATTENTION_CUES_KEY, isCuesOn } from "../shared/cues.js";

/** 一个音：频率（Hz）、相对起点的开始时间（秒）、衰减到无声的时长（秒）。 */
type Note = readonly [hz: number, at: number, decay: number];

const DONE: readonly Note[] = [[523.25, 0, 0.6], [659.25, 0.09, 0.6], [783.99, 0.18, 0.8]];

const NEEDS_YOU: readonly Note[] = [[659.25, 0, 0.4], [587.33, 0.2, 0.6]];

const PEAK_GAIN = 0.18;

/** 最后一个音结束后多久让 AudioContext 休眠（毫秒），不让它一直占着音频设备。 */
const SUSPEND_AFTER_MS = 1_000;

/** 问其他侧栏在哪个窗口时最多等多久（毫秒）。 */
const PRESENCE_WAIT_MS = 300;

let ctx: AudioContext | null = null;

let suspendTimer: ReturnType<typeof setTimeout> | undefined;

/** 用户停下的这一轮：随后到的 agent_end 和核对结论都是停下的尾声，不响。 */
let stopped = false;

/** 这一轮已为做完响过：同一轮再到的 agent_end 或结论不再响。 */
let doneCued = false;

/** 正在等用户的那件事（同一件事重复通知不再响）；等着时这一轮的收尾也不响，因为刚响过「要你出手」。 */
let waitingFor: string | null = null;

/** 宿主说这一轮要核对：agent_end 先不响，等结论再决定响哪一声，因为结论可能是「接着做」或「等你」。 */
let awaitingVerdict = false;

/** 侧栏收到的每个主会话事件都过一遍；补放的历史不要传进来。 */
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

      // 结论只认这一轮在等的那次核对；用户已经开始下一轮时，晚到的结论不响。
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

/**
 * 每个开着的侧栏都收到同样的事件。用户在看任何一个开着侧栏的窗口就不响；不在看时只让窗口 id 最小的那个侧栏响，
 * 不然几个侧栏会一起响。看的是侧栏所在的窗口，不是侧栏本身：用户看着侧栏旁边的网页时 document.hasFocus() 是 false。
 */
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

// 别的侧栏问「谁开着」时报上自己的窗口。
const presence = new BroadcastChannel(PRESENCE_CHANNEL);

presence.onmessage = (event: MessageEvent<unknown>) => {
  if (event.data === "who") void myWindow.then(id => { if (id !== null) presence.postMessage({ windowId: id }); });
};

/**
 * 开着侧栏的窗口。chrome.runtime.getContexts 只报得出侧栏有几个，报不出在哪个窗口（windowId 一律是 -1），
 * 所以用它定要等几个回答，窗口由各个侧栏自己报。单独窗口里的会话是标签页里的侧栏页，也算一个。
 */
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

/** 语音对话里助手正在说话：提示音会盖住它。 */
function agentSpeaking(): boolean {
  return document.querySelector<HTMLElement>(".voice-progress")?.dataset.state === "speaking";
}
