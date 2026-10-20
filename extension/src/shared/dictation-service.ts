import type { CloudDictationProvider } from "./dictation-config.js";

const ENDPOINTS: Record<CloudDictationProvider, string> = {
  stepfun: "https://api.stepfun.com/step_plan/v1/audio/asr/sse",
  siliconflow: "https://api.siliconflow.cn/v1/audio/transcriptions",
};

export function dictationWav(frames: ArrayBuffer[]): Blob {
  const length = frames.reduce((sum, frame) => sum + frame.byteLength, 0);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const label = (at: number, text: string) => [...text].forEach((letter, i) => view.setUint8(at + i, letter.charCodeAt(0)));
  label(0, "RIFF"); view.setUint32(4, length + 36, true); label(8, "WAVE"); label(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, length, true);
  return new Blob([header, ...frames], { type: "audio/wav" });
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export async function transcribeDictation(provider: CloudDictationProvider, key: string, wav: Blob, signal: AbortSignal): Promise<string> {
  if (!key.trim()) throw new Error("请先在「模型与语音 → 语音 → 语音转文字」填写密钥并保存。");
  const headers: Record<string, string> = { Authorization: `Bearer ${key.trim()}` };
  let body: FormData | string;
  if (provider === "stepfun") {
    const bytes = new Uint8Array(await wav.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    body = JSON.stringify({ audio: { data: btoa(binary), input: { transcription: { model: "stepaudio-2.5-asr", language: "zh", enable_itn: true }, format: { type: "wav" } } } });
    headers["Content-Type"] = "application/json";
    headers.Accept = "text/event-stream";
  } else {
    body = new FormData();
    body.append("file", wav, "dictation.wav");
    body.append("model", "FunAudioLLM/SenseVoiceSmall");
  }
  let response: Response;
  try {
    response = await fetch(ENDPOINTS[provider], { method: "POST", headers, body, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), credentials: "omit", redirect: "error" });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("密钥不可用或没有识别权限，请检查密钥和套餐。");
      if (response.status === 404) throw new Error("当前套餐没有开放这个识别模型，请检查服务商的语音识别权限。");
      if (response.status === 402 || response.status === 429) throw new Error("识别服务额度不足或请求过多，请检查套餐后再试。");
      throw new Error(`识别服务暂时不可用（${response.status}），请稍后再试。`);
    }
    if (provider === "siliconflow") {
      const result: unknown = await response.json();
      if (!object(result) || typeof result.text !== "string") throw new Error("识别服务返回的文字格式不正确。");
      return result.text.trim();
    }
    if (!response.body) throw new Error("识别服务没有返回结果。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: string | undefined;
    const consume = (event: string) => {
      const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return;
      const value: unknown = JSON.parse(data);
      if (!object(value)) throw new Error("识别服务返回的文字格式不正确。");
      if (value.type === "error") throw new Error("识别服务处理失败，请检查套餐或稍后再试。");
      if (value.type === "transcript.text.done" && typeof value.text === "string") final = value.text.trim();
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r/g, "");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
        if (done) { if (buffer.trim()) consume(buffer); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (final === undefined) throw new Error("识别服务没有返回完整结果，请重试。");
    return final;
  } catch (error) {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("识别服务等待超时，请检查网络后重试。");
    if (error instanceof TypeError) throw new Error("连不上识别服务，请检查网络后重试。");
    if (error instanceof SyntaxError) throw new Error("识别服务返回的文字格式不正确。");
    throw error;
  }
}

export interface DictationRecording { stop: () => Blob; cancel: () => void }
export async function recordDictation(signal: AbortSignal, onLevel: (level: number) => void, onLimit: () => void, onFrame?: (pcm: ArrayBuffer) => void): Promise<DictationRecording> {
  const frames: ArrayBuffer[] = [];
  const context = new AudioContext({ sampleRate: 24_000 });
  let stream: MediaStream | undefined;
  let node: AudioWorkletNode | undefined;
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    stream?.getTracks().forEach(track => track.stop());
    if (node) { node.port.onmessage = null; node.disconnect(); }
    void context.close();
  };
  const cancel = () => { release(); frames.length = 0; };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); throw new DOMException("已取消", "AbortError"); }
    await context.audioWorklet.addModule(chrome.runtime.getURL("voice-worklet.js"));
    signal.throwIfAborted();
    node = new AudioWorkletNode(context, "voice-capture");
    node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (released || !object(data) || !(data.pcm instanceof ArrayBuffer) || typeof data.rms !== "number") return;
      if (onFrame) onFrame(data.pcm);
      else frames.push(data.pcm);
      onLevel(Math.min(1, data.rms * 5));
    };
    context.createMediaStreamSource(stream).connect(node);
    await context.resume();
    signal.throwIfAborted();
    timer = setTimeout(onLimit, 120_000);
    return { stop: () => { release(); const wav = dictationWav(frames); frames.length = 0; return wav; }, cancel };
  } catch (error) { cancel(); throw error; }
}
