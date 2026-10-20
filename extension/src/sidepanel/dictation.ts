/**
 * 输入框里边说边出字：点话筒开始，字和声波实时出现在输入框里；
 * 点 ✓ / 回车，字留在输入框，由用户自己发；点 × / Esc，输入框回到说之前。
 * 识别先用 Chrome 自带的（侧栏里实测可用、开口约 1 秒出字）；它连不上服务时改用离屏文档里的阶跃听写，那条路说完才出字。
 */
import { PTT_LEVEL, PTT_TARGET, type PttCommand, type PttLevelMessage, type PttReply } from "../shared/ptt.js";
import { microphonePermissionState } from "./voice-permission.js";
import { bindMotionIcon, setMotionActive } from "./motion-icon.js";

type Engine = "chrome" | "stepfun";

interface SpeechResultList { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } }
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: SpeechResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Chrome 自带识别连不上服务时报的错：换阶跃。 */
const UNREACHABLE = new Set(["network", "service-not-allowed", "language-not-supported"]);

/** Chrome 一段静音后会自己停，接着重开；一直没有字还反复停，就是出了问题，别无限重开。 */
const MAX_EMPTY_RESTARTS = 3;

/** 声波每 60ms 推一根，画布从右往左滚。 */
const STEP_MS = 60;
const BAR = 3;
const GAP = 2;

const MIC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export function mountDictation(opts: {
  composer: HTMLElement;
  inputEl: HTMLTextAreaElement;
  /** 话筒按钮放在这个元素前面。 */
  before: HTMLElement;
  notice: (text: string) => void;
  /** 当前会话：说话期间换了会话，字不写进新会话。 */
  conversation: () => string;
  /** 语音对话正在用麦克风时，不再开第二路。 */
  voiceBusy: () => boolean;
}): { busy: () => boolean; cancel: () => void } {
  const { composer, inputEl } = opts;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "dictate-btn";
  button.className = "composer-icon-btn";
  button.title = "说话输入：边说边出字，说完确认再发";
  button.setAttribute("aria-label", "说话输入");
  button.innerHTML = MIC_ICON;
  bindMotionIcon(button, "mic");
  opts.before.before(button);

  const live = document.createElement("div");
  live.id = "dictation-text";
  live.hidden = true;
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  inputEl.after(live);

  const row = document.createElement("div");
  row.id = "dictation-row";
  row.hidden = true;
  const canvas = document.createElement("canvas");
  canvas.className = "dictation-wave";
  canvas.setAttribute("aria-hidden", "true");
  const clock = document.createElement("span");
  clock.className = "dictation-time";
  const hint = document.createElement("span");
  hint.className = "dictation-hint";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "dictation-cancel";
  cancelBtn.title = "不要了（Esc）";
  cancelBtn.setAttribute("aria-label", "不要这次说的");
  cancelBtn.innerHTML = CLOSE_ICON;
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "dictation-ok";
  okBtn.title = "说完了（回车）";
  okBtn.setAttribute("aria-label", "说完了，放进输入框");
  okBtn.innerHTML = CHECK_ICON;
  row.append(canvas, hint, clock, cancelBtn, okBtn);
  composer.querySelector("#composer-bar")!.after(row);

  let active = false;
  /** 每次开始加一：上一次的识别、麦克风、阶跃回复晚到时认得出自己已过期。 */
  let session = 0;
  let engine: Engine = "chrome";
  /** 开始说话前输入框里的字；取消时原样放回。 */
  let before = "";
  /** Chrome 自己停了又重开时，前几段已经认出的字。 */
  let carried = "";
  let finalText = "";
  let interim = "";
  let conversationAtStart = "";
  let startedAt = 0;
  let raf = 0;
  let lastPush = 0;
  let level = 0;
  let emptyRestarts = 0;
  const bars: number[] = [];
  let rec: SpeechRecognitionLike | null = null;
  let stream: MediaStream | null = null;
  let audio: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let stepfunRecording = false;

  const spoken = (): string => carried + finalText + interim;

  const render = (): void => {
    live.replaceChildren();
    if (before) live.append(document.createTextNode(before));
    const fin = document.createElement("span");
    fin.className = "dictation-final";
    fin.textContent = carried + finalText;
    const mid = document.createElement("span");
    mid.className = "dictation-interim";
    mid.textContent = interim;
    const caret = document.createElement("span");
    caret.className = "dictation-caret";
    live.append(fin, mid, caret);
    if (!before && !spoken()) live.dataset.empty = "true";
    else delete live.dataset.empty;
    live.scrollTop = live.scrollHeight;
  };

  const readLevel = (): number => {
    if (!analyser) return level;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;

    // 和侧栏语音同样的换算（rms×5，封顶 1）。
    return Math.min(1, Math.sqrt(sum / buf.length) * 5);
  };

  const draw = (now: number): void => {
    if (!active) return;
    if (now - lastPush >= STEP_MS) {
      bars.push(readLevel());
      lastPush = now;
      if (bars.length > 240) bars.shift();
    }
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext("2d");
    if (g) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const css = getComputedStyle(canvas);
      g.fillStyle = css.getPropertyValue("--wave-base").trim() || "#e3e1da";
      g.fillRect(0, h / 2 - 0.5, w, 1);
      const frac = Math.min(1, (now - lastPush) / STEP_MS);
      for (let k = 0; k < bars.length; k++) {
        const x = w - (k + frac) * (BAR + GAP) - BAR;
        if (x < 0) break;
        const v = bars[bars.length - 1 - k]!;
        // 没声音时不画柱子，只留基线：声波只说“我听到了”。
        if (v < 0.03) continue;
        const bh = Math.max(2, v * (h - 4));
        g.globalAlpha = Math.min(1, x / 40);
        g.fillStyle = css.getPropertyValue(k < 6 && v > 0.1 ? "--wave-hot" : "--wave").trim() || "#b9b6ad";
        g.beginPath();
        g.roundRect(x, h / 2 - bh / 2, BAR, bh, 1.5);
        g.fill();
      }
      g.globalAlpha = 1;
    }
    const s = Math.floor((now - startedAt) / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    raf = requestAnimationFrame(draw);
  };

  chrome.runtime.onMessage.addListener((raw: Partial<PttLevelMessage> | undefined) => {
    if (active && engine === "stepfun" && raw?.type === PTT_LEVEL && typeof raw.level === "number") level = raw.level;
  });

  const releaseMic = (): void => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    void audio?.close();
    audio = null;
    analyser = null;
  };

  /** 只给声波用的麦克风；拿不到就只画基线，不影响识别。 */
  const openWaveMic = async (mine: number): Promise<void> => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!active || session !== mine || engine !== "chrome") { media.getTracks().forEach((track) => track.stop()); return; }
      stream = media;
      audio = new AudioContext();
      analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      audio.createMediaStreamSource(media).connect(analyser);
    } catch {
      releaseMic();
    }
  };

  const ptt = (phase: PttCommand["phase"]): Promise<PttReply | undefined> =>
    // SAFETY: 离屏文档对 PttCommand 只回 PttReply；没有接收方时 sendMessage 会抛错。
    (chrome.runtime.sendMessage({ target: PTT_TARGET, phase } satisfies PttCommand) as Promise<PttReply | undefined>).catch(() => undefined);

  const stopRecognition = (abort: boolean): void => {
    const r = rec;
    rec = null;
    if (!r) return;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    try { abort ? r.abort() : r.stop(); } catch { /* 已停 */ }
  };

  /** Chrome 自带识别连不上：改用阶跃听写，说完才出字；已经认出的字留着。 */
  const switchToStepfun = async (): Promise<void> => {
    if (!active || engine === "stepfun") return;
    const mine = session;
    engine = "stepfun";
    stopRecognition(true);
    releaseMic();
    carried = carried + finalText;
    finalText = "";
    interim = "";
    render();
    stepfunRecording = true;
    const reply = await ptt("start");
    if (!active || session !== mine) return;
    if (reply?.ok) { hint.textContent = "改用阶跃 · 说完出字"; return; }
    stepfunRecording = false;
    stop(false);
    if (reply && !reply.ok && reply.reason === "permission") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("voice-permission.html") });
      opts.notice("麦克风还没授权，已打开授权页。");
      return;
    }
    opts.notice("说话输入没接上：Chrome 识别连不上，阶跃听写也没启动，稍后再试。");
  };

  const startChrome = (mine: number): void => {
    const ctor = ((window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition);
    if (!ctor) { void switchToStepfun(); return; }
    // 识别先开，声波的麦克风随后接上：别让开麦的几百毫秒挡住第一个字。
    void openWaveMic(mine);
    const r = new ctor();
    r.lang = "zh-CN";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => {
      if (rec !== r) return;
      let fin = "";
      let mid = "";
      for (let i = 0; i < event.results.length; i++) {
        const item = event.results[i]!;
        if (item.isFinal) fin += item[0].transcript;
        else mid += item[0].transcript;
      }
      emptyRestarts = 0;
      finalText = fin;
      interim = mid;
      render();
    };
    r.onerror = (event) => {
      if (rec !== r) return;
      if (UNREACHABLE.has(event.error)) { void switchToStepfun(); return; }
      if (event.error === "audio-capture") { stop(false); opts.notice("没找到麦克风。连上麦克风后再试。"); return; }
      if (event.error === "not-allowed") {
        stop(false);
        void chrome.tabs.create({ url: chrome.runtime.getURL("voice-permission.html") });
        opts.notice("麦克风还没授权，已打开授权页。");
      }
    };
    // Chrome 一段静音后会自己停：还在说话输入就接着听，前一段认出的字记进 carried。
    r.onend = () => {
      if (!active || rec !== r) return;
      const had = finalText + interim;
      emptyRestarts = had ? 0 : emptyRestarts + 1;
      if (emptyRestarts > MAX_EMPTY_RESTARTS) { stop(true); opts.notice("一直没听到声音，说话输入先停了。"); return; }
      carried = carried + had;
      finalText = "";
      interim = "";
      try { r.start(); } catch { void switchToStepfun(); }
    };
    rec = r;
    try { r.start(); } catch { void switchToStepfun(); }
  };

  const start = async (): Promise<void> => {
    if (active) return;
    if (opts.voiceBusy()) { opts.notice("语音对话正在用麦克风。先结束语音对话，再用说话输入。"); return; }
    if (await microphonePermissionState() === "denied") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("voice-permission.html") });
      opts.notice("麦克风还没授权，已打开授权页。");
      return;
    }
    if (active) return;
    active = true;
    session += 1;
    engine = "chrome";
    conversationAtStart = opts.conversation();
    before = inputEl.value;
    carried = "";
    finalText = "";
    interim = "";
    level = 0;
    emptyRestarts = 0;
    bars.length = 0;
    hint.textContent = "";
    startedAt = performance.now();
    lastPush = startedAt;
    composer.classList.add("dictating");
    live.hidden = false;
    row.hidden = false;
    button.setAttribute("aria-pressed", "true");
    setMotionActive(button, true);
    render();
    raf = requestAnimationFrame(draw);
    startChrome(session);
  };

  /** keep：把说的字放进输入框（不发）；否则输入框回到说之前。 */
  const stop = (keep: boolean): void => {
    if (!active) return;
    active = false;
    const mine = session;
    cancelAnimationFrame(raf);
    stopRecognition(!keep);
    releaseMic();
    const said = spoken().trim();
    const wasStepfun = engine === "stepfun" && stepfunRecording;
    stepfunRecording = false;
    composer.classList.remove("dictating");
    live.hidden = true;
    row.hidden = true;
    button.removeAttribute("aria-pressed");
    setMotionActive(button, false);
    const settle = (text: string): void => {
      inputEl.value = text;
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.focus();
      inputEl.setSelectionRange(text.length, text.length);
    };
    // 说话期间换了会话：输入框已经是另一个会话的草稿，不写进去。
    const sameConversation = opts.conversation() === conversationAtStart;

    if (!wasStepfun) {
      if (sameConversation) settle(keep ? before + said : before);
      else if (keep && said) opts.notice(`换了会话，这次说的没放进输入框：「${said}」`);
      return;
    }
    if (!keep) { void ptt("cancel"); if (sameConversation) settle(before); return; }
    // 阶跃听写说完才出字：先回到输入框，字到了接在后面；这期间用户自己打的字不覆盖。
    if (sameConversation) settle(before + said);
    const placeholder = inputEl.placeholder;
    inputEl.placeholder = "正在转成文字…";
    void ptt("stop").then((reply) => {
      if (inputEl.placeholder === "正在转成文字…") inputEl.placeholder = placeholder;
      if (active && session !== mine) return;
      if (reply?.ok && reply.text) {
        if (opts.conversation() === conversationAtStart) settle(inputEl.value + reply.text);
        else opts.notice(`换会话前说的这句没放进输入框：「${reply.text}」`);
      }
      else if (!reply) opts.notice("阶跃听写没接上：助手还没启动好，稍后再试。");
      else if (!reply.ok && reply.reason === "empty") opts.notice("没听清，再说一次。");
      else if (!reply.ok && reply.reason !== "cancelled") opts.notice(`阶跃听写没成功：${("message" in reply && reply.message) || "未知原因"}`);
    });
  };

  button.addEventListener("click", () => { if (active) stop(true); else void start(); });
  okBtn.addEventListener("click", () => stop(true));
  cancelBtn.addEventListener("click", () => stop(false));
  document.addEventListener("keydown", (event) => {
    if (!active || event.isComposing) return;
    // 焦点在 × 上按回车是“不要了”，交给按钮自己。
    if (event.key === "Enter" && document.activeElement !== cancelBtn) { event.preventDefault(); event.stopImmediatePropagation(); stop(true); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); stop(false); }
  }, true);
  // 侧栏关掉：识别、麦克风、离屏的阶跃录音都收掉。
  addEventListener("pagehide", () => stop(false));

  return { busy: () => active, cancel: () => stop(false) };
}
