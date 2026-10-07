/**
 * 离屏文档里的按住说话录音（#125，docs/evals/20261007-ptt-dictation.md R2、R4）。
 * 侧栏关着也能录：离屏文档声明了 USER_MEDIA，麦克风权限按扩展来源授一次即可（10-07 小实验）。
 * 按下就连听写服务、开麦；松开停麦、提交，回听写结果。录音复用侧栏语音的 voice-worklet（24kHz、每帧 20ms）。
 */
import { PTT_TARGET, type PttCommand, type PttReply } from "../shared/ptt.js";
import { createDictation, type Dictation, type DictationSocket } from "./ptt-dictation.js";

/** 浏览器 WebSocket 包成听写要的样子。鉴权头由后台的 declarativeNetRequest 规则补上。 */
function openSocket(url: string): DictationSocket {
  const ws = new WebSocket(url);
  const socket: DictationSocket = { send: data => ws.send(data), close: () => ws.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = event => socket.onmessage?.(String(event.data));
  ws.onclose = () => socket.onclose?.();
  ws.onerror = () => socket.onerror?.();

  return socket;
}

interface Recording { dictation: Dictation; release: () => void }

async function openMicrophone(onFrame: (frame: ArrayBuffer) => void): Promise<() => void> {
  const context = new AudioContext({ sampleRate: 24_000 });
  let stream: MediaStream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (error) {
    await context.close();
    throw error;
  }

  await context.audioWorklet.addModule(chrome.runtime.getURL("voice-worklet.js"));
  const worklet = new AudioWorkletNode(context, "voice-capture");
  // SAFETY: voice-worklet.js 每帧只发 { pcm: ArrayBuffer, rms: number }。
  worklet.port.onmessage = ({ data }) => onFrame((data as { pcm: ArrayBuffer }).pcm);
  context.createMediaStreamSource(stream).connect(worklet);

  return () => {
    stream.getTracks().forEach(track => track.stop());
    worklet.port.onmessage = null;
    void context.close();
  };
}

export function installPushToTalk(): void {
  let current: Recording | null = null;

  const start = async (): Promise<PttReply> => {
    current?.dictation.cancel();
    current?.release();
    const dictation = createDictation({ open: openSocket });
    const recording: Recording = { dictation, release: () => {} };
    current = recording;
    dictation.start();

    try {
      recording.release = await openMicrophone(frame => dictation.push(frame));
    } catch (error) {
      dictation.cancel();

      if (current === recording) current = null;

      return error instanceof DOMException && error.name === "NotAllowedError" ? { ok: false, reason: "permission" } : { ok: false, reason: "device", message: error instanceof Error ? error.message : String(error) };
    }

    // 开麦期间已经松开或取消：马上收掉。
    if (current !== recording) recording.release();

    return { ok: true };
  };

  const stop = async (): Promise<PttReply> => {
    const recording = current;
    current = null;

    if (!recording) return { ok: false, reason: "cancelled" };
    recording.release();

    return recording.dictation.stop();
  };

  chrome.runtime.onMessage.addListener((command: Partial<PttCommand> | undefined, sender, sendResponse) => {
    // 只认本扩展发来、带 PTT_TARGET 的命令。
    if (sender.id !== chrome.runtime.id || command?.target !== PTT_TARGET) return;

    if (command.phase === "cancel") {
      current?.dictation.cancel();
      current?.release();
      current = null;
      sendResponse({ ok: true });

      return;
    }

    void (command.phase === "start" ? start() : stop()).then(sendResponse);

    return true;
  });
}
