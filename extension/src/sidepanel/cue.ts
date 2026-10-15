/**
 * 提示音（docs/evals/20261015-attention-cues.md）：用户没在看侧栏所在的窗口时，任务做完响一声，
 * 要用户出手（确认发送、教学一步、记忆询问、页面交给用户）时响另一声。用户在看就不响。
 *
 * 声音用 Web Audio 现场合成，不带音频文件。设置页「提示音」关掉就不响。
 */
import type { AgentUiEvent } from "../../../shared/protocol.js";

/** chrome.storage.local：false 才关（默认开）。 */
export const ATTENTION_CUES_KEY = "sideagent_attention_cues";

/** 一个音：频率（Hz）、相对起点的开始时间（秒）、衰减到无声的时长（秒）。 */
type Note = readonly [hz: number, at: number, decay: number];

const DONE: readonly Note[] = [[523.25, 0, 0.6], [659.25, 0.09, 0.6], [783.99, 0.18, 0.8]];

const NEEDS_YOU: readonly Note[] = [[659.25, 0, 0.4], [587.33, 0.2, 0.6]];

const PEAK_GAIN = 0.18;

let ctx: AudioContext | null = null;

/** 用户停下的这一轮：随后到的 agent_end 是停下的尾声，不是做完。 */
let stopped = false;

/** 这一轮已为做完响过：同一轮再到的 agent_end 不再响。 */
let doneCued = false;

/** 正在等用户的那件事（同一件事重复通知不再响）；等着时这一轮的收尾也不响，因为刚响过「要你出手」。 */
let waitingFor: string | null = null;

const askedMemory = new Set<string>();

/** 侧栏收到的每个主会话事件都过一遍；补放的历史不要传进来。 */
export function observeForCue(ev: AgentUiEvent): void {
  switch (ev.kind) {
    case "agent_start":
      stopped = false;
      doneCued = false;
      waitingFor = null;
      break;
    case "run_stopped":
      stopped = true;
      break;
    case "agent_end":
      if (stopped || doneCued || waitingFor) break;
      doneCued = true;
      void play(DONE);
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
    case "memory_ask":
      if (ev.outcome || askedMemory.has(ev.askId)) break;
      askedMemory.add(ev.askId);
      void play(NEEDS_YOU);
      break;
    default:
      break;
  }
}

function waitOn(key: string | null): void {
  if (key && key !== waitingFor) void play(NEEDS_YOU);
  waitingFor = key;
}

async function play(notes: readonly Note[]): Promise<void> {
  if (!(await enabled()) || !(await userAway()) || agentSpeaking()) return;
  ctx ??= new AudioContext();
  const running = ctx.state === "running" || await ctx.resume().then(() => true, () => false);

  if (!running) return;
  const start = ctx.currentTime;

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
  }
}

async function enabled(): Promise<boolean> {
  try {
    return (await chrome.storage.local.get(ATTENTION_CUES_KEY))[ATTENTION_CUES_KEY] !== false;
  } catch {
    return true;
  }
}

/**
 * 看的是侧栏所在的窗口，不是侧栏本身：用户看着侧栏旁边的网页时 document.hasFocus() 是 false，但侧栏就在眼前。
 * 窗口在不在前台由 chrome.windows 报；侧栏收起或窗口最小化时页面是 hidden。
 */
async function userAway(): Promise<boolean> {
  if (document.visibilityState === "hidden") return true;

  try {
    return !(await chrome.windows.getCurrent()).focused;
  } catch {
    return false;
  }
}

/** 语音对话里助手正在说话：提示音会盖住它。 */
function agentSpeaking(): boolean {
  return document.querySelector<HTMLElement>(".voice-progress")?.dataset.state === "speaking";
}
