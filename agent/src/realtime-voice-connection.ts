/**
 * Realtime 3 实时连接。生产与隔离试用共用；任务权限由注入的宿主处理。
 * 只做三件事：连 StepFun Realtime、转发事件、把工具调用交给注入的桥。
 * key 只出现在服务端连接头，不写日志、不转发；原始音频只在内存过一次，不落盘。
 *
 * 前端 → handle():
 *   {type:'audio', data} base64 PCM16 24kHz 单声道 | {type:'text', text}
 *   {type:'stop_speech'} 只停当前语音（cancel + 清播放队列）；response.created 还没到也拦住这一轮，
 *   下一次真实用户输入（开口/发文字）才解锁；不取消后台任务
 *   {type:'playback_done', responseId} 前端确实把该轮播完 | {type:'stop'} 结束通话（只关语音）
 * 本模块 → send():
 *   ready{model} status{text} transcript{role,text,final,responseId?} audio{data,responseId}
 *   response_done{responseId,status} clear_audio{} metric{name,value,unit} error{message} closed{}
 * error 只用于会结束通话的故障（后面跟 closed）；可恢复的 provider 报错走 status，便于前端区分。
 *
 * transcript.text 是该 item/response 目前的累计文本，final 表示已定稿。
 * metric 只是服务端事件到达本进程的时刻（相对 ready），不是真人说完到听见；实际播放由 UI 侧测。
 * response.done 只是生成结束，播放结束以前端 playback_done 为准；该轮没有音频时直接算播完。
 *
 * 已知限制：不做断线重连；provider 30 分钟会话上限由外部处理；同一实例只持一条会话。
 */
import WebSocket, {type RawData} from 'ws';

export const MODEL = 'stepaudio-3-realtime-preview';
const ENDPOINT = `wss://api.stepfun.com/v1/realtime?model=${MODEL}`;
export const STEP_VOICE = 'wenrounansheng';
const VOICE = STEP_VOICE;
const SAMPLE_RATE = 24_000;
const CONNECT_TIMEOUT_MS = 15_000;
const RESPONSE_WATCHDOG_MS = 12_000;
const ASR_WAIT_MS = 3_000;
const PLAYBACK_TAIL_MS = 10_000;
const PLAYBACK_MAX_WAIT_MS = 90_000;
const MAX_SEEN_EVENTS = 2_048;
const MAX_TOOL_OUTPUT_CHARS = 12_000;
const BUSY_RETRY_MS = 800;
const MAX_BUSY_RETRIES = 3;

const INSTRUCTIONS = `你是 By Your Side 的语音搭子，边聊边帮用户操作当前网页。
- 普通聊天直接自然回答，简短（一到两句），不要长篇大论。
- 只有用户明确要求点击、输入、翻页、查找等操作浏览器时，才调用 browser_request。它不需要参数，系统会把用户刚说的原话交给页面任务引擎；同一个请求只交一次。
- 想了解当前页面内容或后台任务状态时，调用 read_page / task_status。read_page 只返回当前可见文字，不包含图片理解；不要把可见范围说成全文。图片、空间位置或资料不足的问题交给 browser_request 让任务引擎核查，不猜答案。
- 用户只要求停止说话时不要暂停或取消任务；附和不创建、恢复或取消任务。需要暂停/继续/取消实际任务时才交 browser_request。
- 后台任务进行中照常聊天。任务进展会以【系统通知】出现；收到通知时用一句话自然告诉用户，只有通知或工具结果明确说了才可以说“已完成”。
- 你没有任何付款、提交或代替用户确认的工具；遇到这类要求，请让用户自己确认。
- 没听清、用户还没说完整时，不要猜着执行操作。`;

const TOOL_DEFINITIONS = [
  {type: 'function', function: {name: 'browser_request', description: '把用户刚提出、需要用浏览器完成的请求交给真实页面任务引擎；不需要参数，系统使用用户最新原话。只在用户确实要求操作网页时调用。', parameters: {type: 'object', properties: {}}}},
  {type: 'function', function: {name: 'read_page', description: '读取当前浏览器页面内容，用于回答页面相关问题；不需要参数。', parameters: {type: 'object', properties: {}}}},
  {type: 'function', function: {name: 'task_status', description: '查询后台网页任务的最新状态；不需要参数。', parameters: {type: 'object', properties: {}}}},
];

export interface RealtimeVoiceTools {
  browser_request: (text: string) => Promise<unknown>;
  read_page: () => Promise<unknown>;
  task_status: () => Promise<unknown>;
}

export interface RealtimeVoiceConnectionOptions {
  key: string;
  diagnostic?: boolean;
  connect?: (key: string) => WebSocket;
  send: (event: Record<string, unknown>) => void;
  tools: RealtimeVoiceTools;
  log?: (event: Record<string, unknown>) => void;
}

type Phase = 'idle' | 'connecting' | 'configuring' | 'ready' | 'closed';

interface UserInput {
  id: string;
  text: string;
}

interface PendingToolCall {
  speechSeq: number;
  callId: string;
  name: string;
  responseId: string | null;
  output: string | null;
  settled: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function serializeToolOutput(value: unknown): string {
  let text: string;
  try {
    const json = JSON.stringify(value);
    text = typeof json === 'string' ? json : String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…[输出过长已截断]` : text;
}

/** session.updated 的 echo 必须和请求一致才允许 ready。纯函数，便于离线用反例检查。 */
export function configurationIssues(createdModel: string | null, session: Record<string, unknown>, serverVad = true): string[] {
  const issues: string[] = [];
  if (createdModel !== MODEL) issues.push(`session.created 返回的模型是 ${createdModel ?? '缺失'}`);
  const updatedModel = asString(session.model);
  if (updatedModel !== null && updatedModel !== '' && updatedModel !== MODEL) issues.push(`session.updated 返回的模型是 ${updatedModel}`);
  if (session.voice !== VOICE) issues.push(`音色未生效：${String(session.voice ?? '缺失')}`);
  if (session.input_audio_format !== 'pcm16') issues.push(`输入格式不是 pcm16：${String(session.input_audio_format ?? '缺失')}`);
  if (session.output_audio_format !== 'pcm16') issues.push(`输出格式不是 pcm16：${String(session.output_audio_format ?? '缺失')}`);
  if (serverVad && asRecord(session.turn_detection)?.type !== 'server_vad') issues.push(`VAD 未生效：${String(asRecord(session.turn_detection)?.type ?? '缺失')}`);
  return issues;
}

export class RealtimeVoiceConnection {
  private readonly options: RealtimeVoiceConnectionOptions;
  private ws: WebSocket | null = null;
  private phase: Phase = 'idle';
  private closed = false;
  private createdModel: string | null = null;
  private readyAt = 0;
  private responseSeq = 0;
  private textSeq = 0;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenCallIds = new Set<string>();
  private activeResponseId: string | null = null;
  private sendingResponse = false;
  private busyRetries = 0;
  private readonly doneResponses = new Set<string>();
  private readonly playedResponses = new Set<string>();
  private readonly audioBytes = new Map<string, number>();
  private readonly assistantText = new Map<string, string>();
  private readonly finalizedResponses = new Set<string>();
  private userSpeaking = false;
  private speechStopAt: number | null = null;
  private firstTextNoted = false;
  private firstAudioNoted = false;
  private latestInput: UserInput | null = null;
  private speechSeq = 0;
  private speechItemId:string|null=null;
  private readonly responseInputs=new Map<string,number>();
  private asrSeq = 0;
  private readonly consumedInputIds = new Set<string>();
  private inputWaiters: Array<(input: UserInput | null) => void> = [];
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private wantResponse = false;
  private queuedNotify: Array<{text:string;id?:string;valid?:()=>boolean}> = [];
  private creatingDeliveryId: string | undefined;
  /** 后台通知触发的这一轮不允许再派发 browser_request；该轮 response.done 时解除。 */
  private suppressDispatch = false;
  /** stop_speech 后属于该轮的迟到音频不再下发给前端。 */
  private localCancelResponseId: string | null = null;
  /** stop 时 response.created 还没到：迟到的 created 立即取消、音频不下发，下一次真实用户输入解锁。 */
  private pendingStop = false;

  constructor(options: RealtimeVoiceConnectionOptions) {
    this.options = options;
  }

  /** 只建立一条真实连接；重复调用被忽略。 */
  start(): void {
    if (this.phase !== 'idle') return this.log({type: 'start_ignored', phase: this.phase});
    this.phase = 'connecting';
    this.sendToClient({type: 'status', text: '正在连接语音服务…'});
    this.log({type: 'connecting'});
    const socket = this.options.connect?.(this.options.key) ?? new WebSocket(ENDPOINT, {headers: {Authorization: `Bearer ${this.options.key}`}});
    this.ws = socket;
    socket.on('message', (data: RawData) => this.onProviderMessage(data));
    socket.on('error', (error: Error) => {
      if (!this.closed) this.fatal(`语音服务连接出错：${error.message}`);
    });
    socket.on('close', (code: number, reason: Buffer) => this.onSocketClose(code, reason.toString()));
    this.armTimer('connect', CONNECT_TIMEOUT_MS, () => this.fatal('连接语音服务超时，请重试'));
  }

  /** 处理前端消息；工具在后台异步执行，不阻塞音频进出。 */
  handle(message: Record<string, unknown>): void {
    const type = asString(message.type);
    if (type === 'stop') return this.close();
    if (type === 'stop_speech') return this.stopSpeech();
    if (type === 'commit_audio' && this.options.diagnostic) { this.socketSend({type:'input_audio_buffer.commit'}); return; }
    if (type === 'audio') {
      if (this.phase !== 'ready') return this.log({type: 'audio_before_ready_ignored'});
      const data = asString(message.data);
      if (data) this.socketSend({type: 'input_audio_buffer.append', audio: data});
      return;
    }
    if (type === 'text') {
      if (this.phase !== 'ready') return this.log({type: 'text_before_ready_ignored'});
      const text = (asString(message.text) ?? '').trim();
      if (!text) return;
      this.pendingStop = false; // 新的真实输入解锁停声
      this.speechSeq++;this.speechItemId=null;
      this.recordUserInput({id: `text-${++this.textSeq}`, text});
      this.socketSend({type: 'conversation.item.create', item: {type: 'message', role: 'user', content: [{type: 'input_text', text}]}});
      this.wantResponse = true;
      this.maybeFlush();
      return;
    }
    if (type === 'playback_done') {
      const responseId = asString(message.responseId);
      if (!responseId) return;
      this.playedResponses.add(responseId);
      this.clearTimer(`playback:${responseId}`);
      this.log({type: 'playback_done', responseId});
      this.maybeFlush();
      return;
    }
    this.log({type: 'unknown_client_message', clientType: type});
  }

  /** Preserve independent task deliveries; recheck their run before speaking. */
  notifyTask(text: string, id?: string, valid?:()=>boolean): void {
    const trimmed = text.trim();
    if (!trimmed || this.closed) return;
    if(this.queuedNotify.length>=256)return this.fatal('待播任务结果过多，语音已停止；结果仍保留在侧栏。');
    this.queuedNotify.push({text:trimmed,id,valid});
    this.maybeFlush();
    this.log({type:'notify_queued',chars:trimmed.length});
  }

  /** 只关语音：不取消后台任务、不等未完成的工具；幂等。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.phase = 'closed';
    this.clearTimers();
    for (const waiter of this.inputWaiters) waiter(null);
    this.inputWaiters = [];
    try {
      this.ws?.close(1000, 'voice ended');
    } catch {
      /* already closing */
    }
    this.log({type: 'closed'});
    this.sendToClient({type: 'closed'});
  }

  // --- provider events ---

  private onProviderMessage(data: RawData): void {
    let event: Record<string, unknown>;
    try {
      const record = asRecord(JSON.parse(data.toString()));
      if (!record) return this.log({type: 'unparsable_provider_event'});
      event = record;
    } catch {
      return this.log({type: 'unparsable_provider_event'});
    }
    const type = asString(event.type) ?? '';
    const eventId = asString(event.event_id);
    if (eventId) {
      if (this.seenEventIds.has(eventId)) return this.log({type: 'provider_event_duplicate', providerType: type});
      this.seenEventIds.add(eventId);
      if (this.seenEventIds.size > MAX_SEEN_EVENTS) this.seenEventIds.clear();
    }
    switch (type) {
      case 'session.created': return this.onSessionCreated(event);
      case 'session.updated': return this.onSessionUpdated(event);
      case 'response.created': {
        const id = asString(asRecord(event.response)?.id) ?? asString(event.response_id) ?? `resp-${++this.responseSeq}`;
        this.activeResponseId = id;
        this.responseInputs.set(id,this.speechSeq);
        if(this.creatingDeliveryId){this.sendToClient({type:'delivery_response',deliveryId:this.creatingDeliveryId,responseId:id});this.creatingDeliveryId=undefined;}
        this.sendingResponse = false;
        this.busyRetries = 0;
        this.clearTimer('create-watch');
        if (this.pendingStop) {
          // stop_speech 时 response.create 已发、created 未到：这时才等到，立即取消并抑制这轮音频。
          this.socketSend({type: 'response.cancel'});
          this.localCancelResponseId = id;
          this.log({type: 'late_response_cancelled', responseId: id});
        }
        return;
      }
      case 'response.audio.delta': return this.onAudioDelta(event);
      case 'response.audio_transcript.delta':
      case 'response.text.delta': return this.onAssistantDelta(event);
      case 'response.audio_transcript.done':
      case 'response.text.done': return this.onAssistantDone(event);
      case 'response.done': return this.onResponseDone(event);
      case 'response.function_call_arguments.done': return this.onFunctionCall(event);
      case 'conversation.item.input_audio_transcription.completed': return this.onUserCompleted(event);
      case 'input_audio_buffer.speech_started':
        // 全双工交给 provider 判断：不清队列、不发 response.cancel、不动后台任务。
        this.userSpeaking = true;
        this.speechStopAt = null;
        this.firstTextNoted = false;
        this.firstAudioNoted = false;
        this.latestInput = null; // 新回合开口：上一回合没派发的转写不再是候选，避免旧句被迟到工具调用带走
        this.pendingStop = false; // 新的真实回合解锁停声
        this.speechSeq += 1;
        this.speechItemId=asString(event.item_id);
        this.sendToClient({type:'input_start',itemId:this.speechItemId});
        this.log({type: 'speech_started'});
        return this.emitMetric('vad_speech_started_since_ready', this.sinceReady());
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        this.speechStopAt = Date.now();
        this.log({type: 'speech_stopped'});
        this.emitMetric('vad_speech_stopped_since_ready', this.sinceReady());
        return this.maybeFlush();
      default:
        if (type === 'error' || type.endsWith('_error')) this.onProviderError(type, event);
    }
  }

  private onSessionCreated(event: Record<string, unknown>): void {
    const model = asString(asRecord(event.session)?.model) ?? null;
    this.createdModel = model;
    this.log({type: 'session_created', model});
    if (model !== MODEL) return this.fatal(`语音服务返回的模型是 ${model ?? '未知'}，不是 ${MODEL}`);
    this.phase = 'configuring';
    this.socketSend({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.options.diagnostic ? '只转写用户音频，不执行任务。' : INSTRUCTIONS,
        voice: VOICE,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: this.options.diagnostic ? null : {type: 'server_vad', prefix_padding_ms: 500, silence_duration_ms: 300, energy_awakeness_threshold: 2500},
        tools: this.options.diagnostic ? [] : TOOL_DEFINITIONS,
      },
    });
    this.armTimer('connect', CONNECT_TIMEOUT_MS, () => this.fatal('语音服务没有确认会话配置，连接超时'));
  }

  private onSessionUpdated(event: Record<string, unknown>): void {
    if (this.phase === 'ready') return; // 重复 echo 不重启会话
    const session = asRecord(event.session) ?? {};
    const issues = configurationIssues(this.createdModel, session, !this.options.diagnostic);
    if (issues.length > 0) return this.fatal(`语音配置未生效：${issues.join('；')}`);
    this.phase = 'ready';
    this.readyAt = Date.now();
    this.clearTimer('connect');
    this.log({type: 'ready', model: this.createdModel, voice: session.voice, vad: asRecord(session.turn_detection)?.type});
    this.sendToClient({type: 'ready', model: this.createdModel ?? MODEL});
    this.maybeFlush(); // ready 前排队的通知在这里播
  }

  private onAudioDelta(event: Record<string, unknown>): void {
    const delta = asString(event.delta);
    if (!delta) return;
    const responseId = asString(event.response_id) ?? this.activeResponseId ?? 'resp-unknown';
    if (this.localCancelResponseId === responseId) return this.log({type: 'audio_after_stop_skipped', responseId});
    const bytes = Math.floor((delta.length * 3) / 4);
    this.audioBytes.set(responseId, (this.audioBytes.get(responseId) ?? 0) + bytes);
    if (!this.firstAudioNoted && this.speechStopAt !== null) {
      this.firstAudioNoted = true;
      this.emitMetric('first_audio_since_vad_stop', Date.now() - this.speechStopAt);
    }
    this.sendToClient({type: 'audio', data: delta, responseId});
  }

  private onAssistantDelta(event: Record<string, unknown>): void {
    const delta = asString(event.delta);
    if (!delta) return;
    const responseId = asString(event.response_id) ?? this.activeResponseId ?? 'resp-unknown';
    if (this.finalizedResponses.has(responseId)) return; // 已定稿就不再吃迟到 delta
    if (!this.firstTextNoted && this.speechStopAt !== null) {
      this.firstTextNoted = true;
      this.emitMetric('first_text_since_vad_stop', Date.now() - this.speechStopAt);
    }
    const full = (this.assistantText.get(responseId) ?? '') + delta;
    this.assistantText.set(responseId, full);
    this.sendToClient({type: 'transcript', role: 'assistant', text: full, final: false, responseId});
  }

  private onAssistantDone(event: Record<string, unknown>): void {
    const responseId = asString(event.response_id) ?? this.activeResponseId ?? 'resp-unknown';
    if (this.finalizedResponses.has(responseId)) return;
    this.finalizedResponses.add(responseId);
    const text = (asString(event.transcript) ?? asString(event.text) ?? this.assistantText.get(responseId) ?? '').trim();
    if (text) this.sendToClient({type: 'transcript', role: 'assistant', text, final: true, responseId});
  }

  private onUserCompleted(event: Record<string, unknown>): void {
    const text = (asString(event.transcript) ?? '').trim();
    if (!text) return; // 只有噪声没有识别结果，不算一条请求
    // 缺 item_id 时不能都叫 user-input，会和已消费的旧回合撞 id；按 speech 轮 + 序号给唯一 id。
    const itemId = asString(event.item_id) ?? `speech-${this.speechSeq}-${++this.asrSeq}`;
    if(this.speechItemId&&asString(event.item_id)&&itemId!==this.speechItemId){this.log({type:'late_asr_ignored',itemId});return;}
    this.recordUserInput({id: itemId, text});
    this.sendToClient({type: 'transcript', role: 'user', text, final: true,itemId});
  }

  private onResponseDone(event: Record<string, unknown>): void {
    const response = asRecord(event.response);
    const id = asString(response?.id) ?? asString(event.response_id) ?? this.activeResponseId;
    if (!id) return this.log({type: 'response_done_without_id'});
    const status = asString(response?.status) ?? 'completed';
    if (this.activeResponseId === id) this.activeResponseId = null;
    this.sendingResponse = false;
    this.busyRetries = 0;
    this.clearTimer('create-watch');
    this.doneResponses.add(id);
    if (!this.finalizedResponses.has(id)) {
      this.finalizedResponses.add(id);
      const text = (this.assistantText.get(id) ?? '').trim();
      if (text) this.sendToClient({type: 'transcript', role: 'assistant', text, final: true, responseId: id});
    }
    this.sendToClient({type: 'response_done', responseId: id, status});
    this.log({type: 'response_done', responseId: id, status});
    if (this.localCancelResponseId === id) this.localCancelResponseId = null;
    this.suppressDispatch = false;
    const bytes = this.audioBytes.get(id) ?? 0;
    if (status === 'cancelled') {
      // provider 已放弃这轮：剩余音频作废，不再等 playback_done。
      this.playedResponses.add(id);
      this.clearTimer(`playback:${id}`);
      this.sendToClient({type: 'clear_audio'});
    } else if (bytes > 0 && !this.playedResponses.has(id)) {
      const wait = Math.min(PLAYBACK_MAX_WAIT_MS, Math.ceil((bytes / (SAMPLE_RATE * 2)) * 1000) + PLAYBACK_TAIL_MS);
      this.armTimer(`playback:${id}`, wait, () => {
        this.fatal('未收到实际播放完成确认，语音已停止；后台任务不取消，请重新开启语音。');
      });
    }
    this.maybeFlush();
  }

  private onFunctionCall(event: Record<string, unknown>): void {
    if (this.options.diagnostic) return;
    const callId = (asString(event.call_id) ?? '').trim();
    if (!callId || this.seenCallIds.has(callId)) return; // 同一个 call_id 只执行一次
    this.seenCallIds.add(callId);
    const responseId=asString(event.response_id)??this.activeResponseId;
    const call: PendingToolCall = {
      speechSeq:responseId?this.responseInputs.get(responseId)??this.speechSeq:this.speechSeq,
      callId,
      name: asString(event.name) ?? 'unknown',
      responseId: asString(event.response_id) ?? this.activeResponseId,
      output: null,
      settled: false,
    };
    this.pendingToolCalls.set(callId, call);
    this.log({type: 'tool_call', callId, name: call.name, responseId: call.responseId});
    void this.executeTool(call);
  }

  private onProviderError(type: string, event: Record<string, unknown>): void {
    const nested = asRecord(event.error);
    const code = asString(nested?.code) ?? asString(event.code) ?? '';
    const message = asString(nested?.message) ?? asString(event.message) ?? type;
    this.log({type: 'provider_error', providerType: type, code, message});
    if (this.phase !== 'ready') return this.fatal(`语音服务出错：${message}`);
    if (/busy|active|already|已有|进行中/i.test(`${code} ${message}`)) {
      this.sendingResponse = false;
      this.clearTimer('create-watch');
      if (this.pendingStop) return; // 已停声：不把被拒的这一轮排回来
      this.wantResponse = true; // 被拒的那次 response.create 已带走的输出还等在对话里，稍后重来
      const retrying = this.busyRetries++ < MAX_BUSY_RETRIES;
      if (!retrying) return this.fatal('语音服务持续繁忙，通话已停止；后台任务保留，请重试。');
      this.armTimer('busy-retry', BUSY_RETRY_MS, () => this.maybeFlush());
      return this.sendToClient({type:'status',text:'语音服务正忙，稍后重试'});
    }
    // 会话还能继续的 provider 报错不改状态，只提示事实（error 留给会结束通话的故障）。
    this.sendToClient({type: 'status', text: `语音服务提示：${message}`});
  }

  // --- tools ---

  private async executeTool(call: PendingToolCall): Promise<void> {
    const started = Date.now();
    let result: unknown;
    try {
      if(call.speechSeq!==this.speechSeq)throw new Error('这轮请求已过期，没有执行工具。');
      if (call.name === 'browser_request') result = await this.runBrowserRequest(call.speechSeq);
      else if (call.name === 'read_page') result = await this.options.tools.read_page();
      else if (call.name === 'task_status') result = await this.options.tools.task_status();
      else result = {ok: false, error: `未知工具 ${call.name}`};
    } catch (error) {
      result = {ok: false, error: errorMessage(error)};
    }
    call.output = serializeToolOutput(result);
    this.log({type: 'tool_output', callId: call.callId, name: call.name, ms: Date.now() - started});
    this.maybeFlush();
  }

  /** 只把用户最新的真实输入交出去；ASR 没到可短等，等不到就不执行。同一个输入只派发一次。 */
  private async runBrowserRequest(speechSeq:number): Promise<unknown> {
    if (this.suppressDispatch) return {ok: false, error: '这轮是后台任务的进展通知，不是用户的新要求；没有执行网页操作'};
    const input = await this.resolveUserInput();
    if(this.closed||speechSeq!==this.speechSeq)return {ok:false,error:'这句话已过期，没有执行操作'};
    if (!input) {
      const stale = this.latestInput;
      if (stale && this.consumedInputIds.has(stale.id)) return {ok: false, error: '这个请求已经交给页面任务，不需要重复执行'};
      return {ok: false, error: '还没有识别到用户的原始请求，没有执行网页操作'};
    }
    if (this.consumedInputIds.has(input.id)) return {ok: false, error: '这个请求已经交给页面任务，不需要重复执行'};
    this.consumedInputIds.add(input.id);
    this.log({type: 'browser_request', inputId: input.id, chars: input.text.length});
    this.sendToClient({type: 'status', text: '正在把请求交给网页任务…'});
    const result = await this.options.tools.browser_request(input.text);
    this.sendToClient({type:'status',text:asRecord(result)?.ok===false?'任务未执行，请核对侧栏回执。':'任务处理结果已返回，有新进展会说明。'});
    return result;
  }

  /**
   * 只接受当前回合还没派发过的原话：已消费的旧候选直接判无，等待期间收到的重复旧转写也不顶包；
   * 迟到的工具调用因此不会再派一次旧句，等不到本回合新 ASR 就不执行。
   */
  private resolveUserInput(): Promise<UserInput | null> {
    const candidate = this.latestInput;
    if (candidate) return Promise.resolve(this.consumedInputIds.has(candidate.id) ? null : candidate);
    return new Promise(resolve => {
      const deliver = (input: UserInput | null): void => {
        clearTimeout(timer);
        this.inputWaiters = this.inputWaiters.filter(waiter => waiter !== deliver);
        resolve(input);
      };
      const timer = setTimeout(() => {
        this.inputWaiters = this.inputWaiters.filter(waiter => waiter !== deliver);
        const late = this.latestInput;
        resolve(late && !this.consumedInputIds.has(late.id) ? late : null);
      }, ASR_WAIT_MS);
      this.inputWaiters.push(deliver);
    });
  }

  private recordUserInput(input: UserInput): void {
    if (this.consumedInputIds.has(input.id)) return; // 旧回合的重复/迟到结果不算新候选，也不打断正在等新 ASR 的调用
    this.latestInput = input;
    this.log({type: 'user_input', inputId: input.id, chars: input.text.length});
    const waiters = this.inputWaiters;
    this.inputWaiters = [];
    for (const waiter of waiters) waiter(input);
  }

  // --- flush: tool outputs + notifications + response.create ---

  /** 空闲才动：没有活跃生成、没在等 response.created、用户没在说话、上轮音频播完。 */
  private maybeFlush(): void {
    if (this.phase !== 'ready' || this.closed) return;
    if (this.pendingStop) return; // 停声后等下一次真实用户输入再开新轮（通知/工具输出先存住）
    if (this.activeResponseId !== null || this.sendingResponse || this.userSpeaking || this.playbackBusy()) return;
    let inserted = false;
    for (const call of this.pendingToolCalls.values()) {
      if (call.settled || call.output === null) continue;
      const finished = call.responseId === null ? this.activeResponseId === null : this.doneResponses.has(call.responseId);
      const played = call.responseId === null
        ? !this.playbackBusy()
        : !this.audioBytes.has(call.responseId) || this.playedResponses.has(call.responseId);
      if (!finished || !played) continue; // 必须等对应 response.done 和实际播放结束
      this.socketSend({type: 'conversation.item.create', item: {type: 'function_call_output', call_id: call.callId, output: call.output}});
      call.settled = true;
      inserted = true;
      this.log({type: 'tool_output_sent', callId: call.callId, name: call.name});
    }
    while(this.queuedNotify[0]?.valid&&!this.queuedNotify[0].valid!())this.queuedNotify.shift();
    if (this.queuedNotify.length && !inserted) {
      const notice = this.queuedNotify.shift()!;
      const text = notice.text;
      this.creatingDeliveryId=notice.id;
      this.suppressDispatch = true;
      this.socketSend({
        type: 'conversation.item.create',
        item: {type: 'message', role: 'system', content: [{type: 'input_text', text: `【系统通知】${text}。请用一句话自然告知用户；这不是用户的新请求，不要调用工具。`}]},
      });
      inserted = true;
      this.log({type: 'notify_sent', chars: text.length});
    }
    if (inserted || this.wantResponse) {
      this.wantResponse = false;
      this.sendingResponse = true;
      this.socketSend({type: 'response.create'});
      this.armTimer('create-watch', RESPONSE_WATCHDOG_MS, () => {
        this.log({type: 'create_watchdog'});
        this.sendingResponse = false;
        this.maybeFlush();
      });
    }
  }

  private playbackBusy(): boolean {
    for (const id of this.audioBytes.keys()) {
      if (!this.playedResponses.has(id)) return true;
    }
    return false;
  }

  /** 明确停声：只 cancel 当前语音并清播放队列，不取消后台任务，也不清输入缓冲。 */
  private stopSpeech(): void {
    const responseId = this.activeResponseId;
    // response.create 已发、created 未到（或 provider 自动响应在路上）时 responseId 还是 null；
    // 也要拦住这轮，等下一次真实用户输入解锁。
    if (responseId === null) this.pendingStop = true;
    this.wantResponse = false;
    this.busyRetries = 0;
    this.clearTimer('busy-retry');
    this.clearTimer('create-watch');
    this.sendingResponse = false;
    if (responseId) {
      this.socketSend({type: 'response.cancel'});
      this.localCancelResponseId = responseId;
      this.clearTimer(`playback:${responseId}`);
    }
    for (const id of this.audioBytes.keys()) this.playedResponses.add(id);
    this.sendToClient({type: 'clear_audio'});
    this.sendToClient({type: 'status', phase:'idle',text: '已停止播报'});
    this.log({type: 'stop_speech', responseId});
    this.maybeFlush();
  }

  // --- plumbing ---

  private onSocketClose(code: number, reason: string): void {
    if (this.closed) return;
    this.log({type: 'socket_closed', code, reason: reason.slice(0, 200)});
    this.sendToClient({type: 'error', message: `语音连接已断开${reason ? `：${reason.slice(0, 120)}` : ''}，通话结束`,recoverable:this.phase==='ready'});
    this.close();
  }

  private fatal(message: string): void {
    if (this.closed) return;
    this.log({type: 'fatal', message});
    this.sendToClient({type: 'error', message});
    this.close();
  }

  private emitMetric(name: string, value: number): void {
    this.sendToClient({type: 'metric', name, value: Math.max(0, Math.round(value)), unit: 'ms'});
  }

  private sinceReady(): number {
    return this.readyAt === 0 ? 0 : Date.now() - this.readyAt;
  }

  private sendToClient(event: Record<string, unknown>): void {
    if (this.closed && event.type !== 'closed') return;
    try {
      this.options.send(event);
    } catch (error) {
      this.log({type: 'send_failed', message: errorMessage(error)});
    }
  }

  private socketSend(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return this.log({type: 'socket_send_dropped', providerType: event.type});
    try {
      this.ws.send(JSON.stringify(event));
    } catch (error) {
      this.log({type: 'socket_send_failed', providerType: event.type, message: errorMessage(error)});
    }
  }

  private log(event: Record<string, unknown>): void {
    try {
      this.options.log?.({...event, at: Date.now()});
    } catch {
      /* logging must never break the call */
    }
  }

  private armTimer(name: string, ms: number, callback: () => void): void {
    this.clearTimer(name);
    this.timers.set(name, setTimeout(() => {
      this.timers.delete(name);
      callback();
    }, ms));
  }

  private clearTimer(name: string): void {
    const timer = this.timers.get(name);
    if (timer) clearTimeout(timer);
    this.timers.delete(name);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
