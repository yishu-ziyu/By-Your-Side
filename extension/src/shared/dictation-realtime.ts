const MODEL = "stepaudio-3-realtime-preview";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export interface RealtimeDictation {
  push: (pcm: ArrayBuffer) => void;
  finish: () => Promise<string>;
  cancel: () => void;
}

export async function openRealtimeDictation(key: string, signal: AbortSignal, onText: (text: string) => void, onError: (message: string) => void): Promise<RealtimeDictation> {
  if (!key.trim()) throw new Error("请先配置 Realtime 3 密钥，或选择沿用语音对话密钥。");
  signal.throwIfAborted();
  const nonce = crypto.randomUUID();
  const ruleId = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000_000 + 100_000;
  // 每次握手独占规则；不覆盖右侧语音凭据，也不给网页发起的连接补头。
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [{
    id: ruleId, priority: 2,
    action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: "Authorization", operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: `Bearer ${key.trim()}` }] },
    condition: { regexFilter: `^wss://api\\.stepfun\\.com/v1/realtime\\?model=${MODEL}&dictation=${nonce}$`, initiatorDomains: [chrome.runtime.id], resourceTypes: [chrome.declarativeNetRequest.ResourceType.WEBSOCKET] },
  }] }).catch(() => { throw new Error("无法准备听写鉴权，请重新打开页面后重试。"); });
  const removeRule = () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  if (signal.aborted) { await removeRule(); signal.throwIfAborted(); }
  let socket: WebSocket;
  try { socket = new WebSocket(`wss://api.stepfun.com/v1/realtime?model=${MODEL}&dictation=${nonce}`); }
  catch { await removeRule(); throw new Error("无法创建听写连接，请重试。"); }
  let ready = false;
  let ended = false;
  let committed = false;
  let text = "";
  let timer: ReturnType<typeof setTimeout>;
  let readyResolve: (value: RealtimeDictation) => void;
  let readyReject: (error: Error) => void;
  let resultResolve: (value: string) => void;
  let resultReject: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  void result.catch(() => {});
  const connection = new Promise<RealtimeDictation>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const cleanup = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    socket.close();
    void removeRule().catch(() => {});
  };
  const fail = (message: string, cancelled = false) => {
    if (ended) return;
    ended = true;
    const error = cancelled ? new DOMException("已取消", "AbortError") : new Error(message);
    cleanup(); readyReject(error); resultReject(error);
    if (ready && !cancelled) onError(message);
  };
  const cancel = () => fail("已取消", true);
  const send = (event: object) => {
    if (socket.readyState !== WebSocket.OPEN) { fail("听写连接已断开，请重试。"); return; }
    socket.send(JSON.stringify(event));
  };
  const api: RealtimeDictation = {
    push(pcm) {
      if (!ready || ended || committed) return;
      const bytes = new Uint8Array(pcm);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      send({ type: "input_audio_buffer.append", audio: btoa(binary) });
    },
    finish() {
      if (!committed && !ended) {
        committed = true;
        send({ type: "input_audio_buffer.commit" });
        timer = setTimeout(() => fail("听写服务没有返回完整文字，请重试。"), 15_000);
      }
      return result;
    },
    cancel,
  };
  timer = setTimeout(() => fail("听写连接超时，请检查网络和 Realtime 3 权限。"), 15_000);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  socket.onopen = () => { void removeRule().catch(() => fail("无法清理听写鉴权，请重试。")); };
  socket.onerror = () => fail("连不上 Realtime 3，请检查密钥、余额和网络。");
  socket.onclose = () => { if (!ended) fail("听写连接已断开，请重试。"); };
  socket.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (ended) return;
    try {
      const event: unknown = typeof data === "string" ? JSON.parse(data) : null;
      if (!record(event) || typeof event.type !== "string") throw new Error("invalid event");
      if (event.type.startsWith("response.")) { fail("服务返回了非听写内容，已中止本次连接。"); return; }
      if (event.type === "error") { fail("Realtime 3 识别失败，请检查密钥、余额和语音权限。"); return; }
      if (event.type === "session.created") {
        if (!record(event.session) || event.session.model !== MODEL) { fail("听写服务返回了不同模型，已中止连接。"); return; }
        send({ type: "session.update", session: { modalities: ["text", "audio"], input_audio_format: "pcm16", output_audio_format: "pcm16", turn_detection: null, tools: [] } });
      } else if (event.type === "session.updated" && !ready) {
        const session = record(event.session) ? event.session : null;
        const vad = session?.turn_detection;
        // 服务端把关闭 VAD 的 null 回显为 { type: "" }。
        if (!session || session.model !== MODEL || session.input_audio_format !== "pcm16" || !Array.isArray(session.modalities) || !session.modalities.includes("text") || !(vad === null || record(vad) && vad.type === "")) { fail("听写服务没有关闭自动回复，已中止连接。"); return; }
        ready = true; clearTimeout(timer); readyResolve(api);
      } else if (event.type === "conversation.item.input_audio_transcription.delta") {
        if (typeof event.delta !== "string") throw new Error("invalid transcript delta");
        // Realtime 3 的 delta 是当前整句快照，可能回改数字和标点。
        text = event.delta; onText(text);
      } else if (event.type === "conversation.item.input_audio_transcription.completed") {
        if (!committed || typeof event.transcript !== "string") throw new Error("unexpected transcript");
        text = event.transcript.trim(); ended = true; cleanup(); resultResolve(text);
      }
    } catch { fail("听写服务返回格式不正确，请重试。"); }
  };
  return connection;
}
