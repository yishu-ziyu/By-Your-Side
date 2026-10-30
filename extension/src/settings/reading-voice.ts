import { readVoiceDictationKey } from '../shared/dictation-config.js';
import { openRealtimeDictation, type RealtimeDictation } from '../shared/dictation-realtime.js';
import { INPROC_VOICE_KEY } from '../inproc/shared.js';
import { PTT_KEY, PTT_KEY_CHOICES, pttKeyLabel, pttKeyOf } from '../shared/ptt.js';

export const readingVoiceView = `<section class="sx" aria-labelledby="reading-voice-title"><div class="sx-head"><h2 id="reading-voice-title">读网页时用声音提问</h2><p class="sx-sub">在网页上按住下面这个键说话。试说只显示文字，不发送给助手。语音发给阶跃星辰 Realtime 3，按量计费；朗读未配置也能看文字回答。</p></div><div class="surface rows"><div class="row"><span class="row-main"><span class="row-title">按住说话的键</span><span id="ptt-key-desc" class="row-desc" role="status"></span></span><span class="row-ctl"><button id="ptt-key-change" class="btn" type="button"></button></span></div><label class="row"><span class="row-main">Realtime 3 密钥</span><span class="row-ctl"><input id="reading-voice-key" class="d-input" type="password" autocomplete="off" aria-label="网页语音密钥" /></span></label><div class="row"><span id="reading-voice-state" class="row-main" role="status"></span><span class="row-ctl"><button id="reading-voice-action" class="btn btn-primary" type="button">试说一句</button><button id="reading-voice-return" class="btn" type="button" hidden>回到原文继续提问</button></span></div></div><p id="reading-voice-text" role="status"></p></section>`;

export async function mountReadingVoice(): Promise<void> {
  mountPttKey();
  const key = document.querySelector<HTMLInputElement>('#reading-voice-key')!;
  const action = document.querySelector<HTMLButtonElement>('#reading-voice-action')!;
  const back = document.querySelector<HTMLButtonElement>('#reading-voice-return')!;
  const state = document.querySelector<HTMLElement>('#reading-voice-state')!;
  const text = document.querySelector<HTMLElement>('#reading-voice-text')!;
  let controller: AbortController | undefined;
  let connection: RealtimeDictation | undefined;
  let stream: MediaStream | undefined;
  let audio: AudioContext | undefined;
  const release = () => { stream?.getTracks().forEach(track => track.stop()); stream = undefined; void audio?.close(); audio = undefined; };
  const cancel = () => { controller?.abort(); connection?.cancel(); connection = undefined; release(); };
  const stored = await readVoiceDictationKey();
  state.textContent = stored.key ? '可试说，识别尚未验证。' : '先填写 Realtime 3 密钥，再试说。';
  action.textContent = stored.key ? '试说一句' : '保存并试说';
  const source = Number(new URL(location.href).searchParams.get('readingTab'));
  back.hidden = !Number.isInteger(source) || source <= 0;
  back.addEventListener('click', async () => {
    cancel();
    try {
      const tab = await chrome.tabs.get(source);
      await chrome.tabs.update(source, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { state.textContent = '原网页已关闭，请重新打开原文。'; }
  });
  action.addEventListener('click', async () => {
    action.disabled = true;
    try {
      if (connection) {
        release(); state.textContent = '正在识别…';
        const result = await connection.finish(); connection = undefined;
        text.textContent = result;
        state.textContent = result ? '试说成功，文字未发送。' : '没有听到说话，请再试一次。';
        action.textContent = '再试一句';
        if (result && !back.hidden) { action.classList.remove('btn-primary'); back.classList.add('btn-primary'); }
        return;
      }
      cancel(); controller = new AbortController();
      const credential = key.value.trim() || (await readVoiceDictationKey()).key;
      if (!credential) throw new Error('请先填写 Realtime 3 密钥。');
      if (key.value.trim()) { await chrome.storage.local.set({ [INPROC_VOICE_KEY]: credential }); key.value = ''; }
      state.textContent = '正在连接，请允许麦克风…'; text.textContent = '';
      const signal = controller.signal;
      connection = await openRealtimeDictation(credential, signal, value => { text.textContent = value; }, message => { cancel(); state.textContent = message; action.textContent = '重新试说'; action.disabled = false; });
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
      if (signal.aborted) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      audio = new AudioContext({ sampleRate: 24_000 });
      await audio.audioWorklet.addModule(chrome.runtime.getURL('voice-worklet.js'));
      if (signal.aborted) return;
      const capture = new AudioWorkletNode(audio, 'voice-capture');
      capture.port.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (typeof data === 'object' && data !== null && 'pcm' in data && data.pcm instanceof ArrayBuffer) connection?.push(data.pcm);
      };
      audio.createMediaStreamSource(stream).connect(capture);
      await audio.resume();
      state.textContent = '现在说一句话，说完点击结束。'; action.textContent = '结束试说';
    } catch (error) { cancel(); state.textContent = error instanceof Error ? error.message : '试说失败，请重试。'; action.textContent = '重新试说'; }
    finally { action.disabled = false; }
  });
  addEventListener('pagehide', cancel);
  document.getElementById('settings-nav')?.addEventListener('click', () => { cancel(); action.disabled = false; action.textContent = '试说一句'; state.textContent = '试说已中止。'; });
}

/** 「改…」之后按下的下一个键就是新键；按 Esc 或点别处放弃。 */
function mountPttKey(): void {
  const desc = document.querySelector<HTMLElement>('#ptt-key-desc')!;
  const change = document.querySelector<HTMLButtonElement>('#ptt-key-change')!;
  let current = pttKeyOf(undefined);
  let waiting = false;
  const show = (note?: string) => {
    change.textContent = waiting ? '按下新键…' : `${pttKeyLabel(current)}　改…`;
    desc.textContent = note ?? (waiting ? '按 Esc 放弃。' : '单独按住它说话，松开发出去。');
  };
  const stop = (note?: string) => { waiting = false; show(note); };
  void chrome.storage.local.get(PTT_KEY).then(got => { current = pttKeyOf(got[PTT_KEY]); show(); });
  change.addEventListener('click', () => { waiting = true; show(); });
  change.addEventListener('blur', () => { if (waiting) stop(); });
  change.addEventListener('keydown', event => {
    if (!waiting) return;
    event.preventDefault();
    if (event.code === 'Escape') { stop(); return; }
    if (!PTT_KEY_CHOICES.includes(event.code)) { show(`这个键打字时常用，换一个：${['AltRight', 'ControlRight', 'MetaRight'].map(pttKeyLabel).join('、')}，或 F1–F19。`); return; }
    current = event.code;
    void chrome.storage.local.set({ [PTT_KEY]: current }).then(() => stop(`已改成 ${pttKeyLabel(current)}，打开着的网页马上生效。`), () => stop('没存上，请再试一次。'));
  });
}
