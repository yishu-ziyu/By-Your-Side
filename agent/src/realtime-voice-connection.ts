import { REALTIME_BROWSER_TOOL_NAMES, realtimeBrowserError, REALTIME_BROWSER_TOOLS, REALTIME_BROWSER_INSTRUCTIONS, validateRealtimeBrowserTool, type RealtimeBrowserCall } from './realtime-browser-tools.js';
import { isExecutionFeedback, type ExecutionFeedback } from '../../shared/execution-feedback.js';
import WebSocket, {type RawData} from 'ws';
import { DEFAULT_STEP_VOICE, type RealtimeVoiceModel } from '../../shared/voice.js';

export const MODEL = 'stepaudio-3-realtime-preview';

function withPersona(persona: string | undefined, instructions: string): string {
  const text = persona?.trim();

  if (!text) return instructions;
  const cut = instructions.indexOf('\n');
  const section = `你的性格和口吻：${text}\n（性格只体现在语气和措辞里，不向用户介绍或复述；与后面任何规则冲突时，以规则为准。）\n`;

  return cut < 0 ? `${instructions}\n${section}` : `${instructions.slice(0, cut + 1)}${section}${instructions.slice(cut + 1)}`;
}

type ProviderEvent = Parameters<RealtimeVoiceConnection["handle"]>[0];

const ENDPOINT = `wss://api.stepfun.com/v1/realtime?model=${MODEL}`;

const STEP_VOICE = DEFAULT_STEP_VOICE;

const SAMPLE_RATE = 24_000;

const CONNECT_TIMEOUT_MS = 15_000;

const MAX_HANDSHAKE_RETRIES = 2;

const RESPONSE_WATCHDOG_MS = 12_000;

const AUTO_RESPONSE_WATCHDOG_MS = 2_000;

const ASR_WAIT_MS = 3_000;

const STALL_MS = 12_000;

const READ_PAGE_ACTION_HINT = '这里只有页面文字，没有元素引用。若用户要操作或圈画页面元素，现在就调用 snapshot，拿到 ref 后直接调用对应工具；只是问页面内容就直接回答。';

const STALL_MIN_SPEECH_MS = 600;

const STALL_SPEECH_PEAK = 3_000;

const SUPERSEDED_BY_SPEECH = '用户在你调用后又接着说了话，这次调用没有执行，也没有动页面。把前后几句合起来理解完整要求，然后直接重新调用需要的工具；不要只说要去做。';

const TRANSCRIPT_GATE_MS = 1_500;

const PLAYBACK_TAIL_MS = 10_000;

const PLAYBACK_MAX_WAIT_MS = 90_000;

const MAX_SEEN_EVENTS = 2_048;

const MAX_TOOL_OUTPUT_CHARS = 12_000;

const BUSY_RETRY_MS = 800;

const MAX_BUSY_RETRIES = 3;

const INSTRUCTIONS = `你是 By Your Side 的语音搭子，边聊边帮用户操作当前网页。
- 始终保持 voice 指定的同一个说话人的音色和自然音域，不模仿用户的声线，不扮演其他人物，不根据内容切换性别或声音。
- 默认只说一句短话。操作请求先调用工具，不先朗读计划，不说“我先看看、接下来、稍等让我”。收到结果后只报结果或一个必要问题；除非用户要求讲解，不复述页面内容、步骤或原话。
- 用户要求操作浏览器（包括切换、打开、关闭标签页，导航、点击、输入、翻页、查找）时，将完整要求交给任务工具执行。同一个请求只交一次；read_page 只是读当前页，不能代替操作，也不能查找其他标签页。未启用 task_action 时使用 browser_request，它不需要参数，系统使用用户原话。
- 用户问能否看到页面、读到了什么、追问刚才的读取时，先调用 read_page，再根据返回的标题和具体内容直接回答；不要只说“我来看看”“让我再试一次”就结束这轮。需要再读时必须实际调用工具，不能用口头承诺代替调用。
- 想了解后台任务状态时调用 task_status。read_page 只返回当前可见文字，不包含图片理解；不要把可见范围说成全文。图片、空间位置或资料不足的问题交给 browser_request 让任务引擎核查，不猜答案。
- read_page 的短暂空白已由程序有界重读。若返回 ok:false，本轮明确告知真实原因和未读到内容，不宣称成功、不继续承诺自动重试；用户下一次要求再读时，发起新的 read_page 调用。
- 用户只要求停止说话时不要暂停或取消任务；附和不创建、恢复或取消任务。需要暂停/继续/取消实际任务时才交 browser_request。
- 后台任务进行中照常聊天。任务进展会以【系统通知】出现；收到通知时用一句话自然告诉用户，只有通知或工具结果明确说了才可以说“已完成”。
- 说完结果或答案就停：不在结尾反问、不客套，不说“还需要我做什么吗”“有问题随时说”“我随时待命”。只有需要用户做决定时，才问一个具体问题。
- 你没有任何付款、提交或代替用户确认的工具；遇到这类要求，请让用户自己确认。
- 没听清、用户还没说完整时，不要猜着执行操作。`;

const TOOL_DEFINITIONS = [
  {type: 'function', function: {name: 'browser_request', description: '把用户刚提出、需要用浏览器完成的请求交给真实页面任务引擎；不需要参数，系统使用用户最新原话。只在用户确实要求操作网页时调用。', parameters: {type: 'object', properties: {}}}},
  {type: 'function', function: {name: 'read_page', description: '读取当前浏览器页面内容，用于回答页面相关问题；不需要参数。', parameters: {type: 'object', properties: {}}}},
  {type: 'function', function: {name: 'task_status', description: '查询后台网页任务的最新状态；不需要参数。', parameters: {type: 'object', properties: {}}}},
];

export interface RealtimeTaskAction {action:'start'|'steer'|'pause'|'resume';targetId?:string;includePending?:boolean}

interface RealtimeVoiceTools {
  browserTool?: (call: RealtimeBrowserCall, signal: AbortSignal) => Promise<unknown>;
  task_action?: (text:string,action:RealtimeTaskAction,inputSequences?:number[])=>Promise<unknown>;
  browser_request: (text: string,inputSequences?:number[]) => Promise<unknown>;
  read_page: () => Promise<unknown>;
  task_status: () => Promise<unknown>;
}

interface RealtimeVoiceConnectionOptions {
  key: string;
  model?: RealtimeVoiceModel;
  routeTranscript?: (text: string, current: () => boolean) => Promise<{ native: boolean; spokenText?: string }>;
  diagnostic?: boolean;
  connect?: (key: string) => WebSocket;
  send: (event: Record<string, unknown>) => void;
  tools: RealtimeVoiceTools;
  log?: (event: Record<string, unknown>) => void;
  voiceId?: string;
  voice?: string;
  persona?: string;
  holdForTranscript?: () => boolean;
  claimTranscript?: (text: string) => boolean;
  runClaimed?: (text: string) => Promise<string | null>;
}

interface VoiceRequestInput {
  voiceId: string;
  turn: number;
  itemId: string;
  inputId: string;
  text: string;
}

interface RequestState {
  input: VoiceRequestInput;
}

type Phase = 'idle' | 'connecting' | 'configuring' | 'ready' | 'closed';

interface UserInput {
  id: string;
  text: string;
  inputSequences?:number[];
  sourceIds?:string[];
}

interface PendingToolCall {
  inputId?: string;
  executionFact?: string;
  speechSeq: number;
  callId: string;
  name: string;
  responseId: string | null;
  output: string | null;
  settled: boolean;
  deferReply?: boolean;
  arguments?:Record<string,unknown>;
  feedback?: ExecutionFeedback;
  failed?: boolean;
  muted?: boolean;
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

function serializeToolOutput(value: unknown, preserveExecution = false): string {
  let text: string;

  try {
    const json = JSON.stringify(value);
    text = typeof json === 'string' ? json : String(value);
  } catch {
    text = String(value);
  }

  if (preserveExecution && text.length > MAX_TOOL_OUTPUT_CHARS) {
    const result = asRecord(value)!;
    const readback=asRecord(result.readback);

    const readbackMeta=readback?{status:readback.status,toolCallId:readback.toolCallId,transportId:readback.transportId,
      reason:readback.reason,matchesExpected:readback.matchesExpected,truncated:true,
      ...(JSON.stringify(readback.target??null).length<=2000?{target:readback.target}:{identityTruncated:true})}:undefined;

    const readbackPiece = readbackMeta ? { readback: readbackMeta } : {};
    const metadata = {ok:result.ok, toolCallId:result.toolCallId, transportId:result.transportId, executionFact:result.executionFact, truncated:true, ...readbackPiece};

    const field = typeof result.error === 'string' ? 'error' : 'contentPreview';
    const content = field === 'error' ? String(result.error) : JSON.stringify(result.content) ?? text;
    const encode = (length:number) => JSON.stringify({...metadata, [field]:content.slice(0,length)});
    let low = 0, high = Math.min(content.length, MAX_TOOL_OUTPUT_CHARS);

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);

      if (encode(mid).length <= MAX_TOOL_OUTPUT_CHARS) low = mid;
      else high = mid - 1;
    }

    return encode(low);
  }

  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…[输出过长已截断]` : text;
}

function configurationIssues(createdModel: string | null, session: Record<string, unknown>, serverVad = true, voice: string = STEP_VOICE, model: RealtimeVoiceModel = MODEL): string[] {
  const issues: string[] = [];

  if (createdModel !== model) issues.push(`session.created 返回的模型是 ${createdModel ?? '缺失'}`);
  const updatedModel = asString(session.model);

  if (updatedModel !== null && updatedModel !== '' && updatedModel !== model) issues.push(`session.updated 返回的模型是 ${updatedModel}`);

  if (session.voice !== voice) issues.push(`音色未生效：${String(session.voice ?? '缺失')}`);

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
  private handshakeRetries = 0;
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
  private readonly finalizedText = new Map<string, string>();
  private userSpeaking = false;
  private unansweredSpeechMs = 0;
  private lastSpeechAt = 0;
  private lastProviderEventAt = 0;
  private speechStopAt: number | null = null;
  private firstTextNoted = false;
  private firstAudioNoted = false;
  private latestInput: UserInput | null = null;
  private speechSeq = 0;
  private speechItemId:string|null=null;
  private readonly speechItems=new Map<string,{seq:number;at:number}>();
  private readonly pendingInputs=new Map<string,{seq:number;at:number;text:string}>();
  private continuationFrom:number|null=null;
  private readonly responseInputs=new Map<string,number>();
  private asrSeq = 0;
  private readonly consumedInputIds = new Set<string>();
  private inputWaiters: Array<(input: UserInput | null) => void> = [];
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private wantResponse = false;
  private readonly requests = new Map<string, RequestState>();
  private queuedNotify: Array<{text:string;id?:string;valid?:()=>boolean;verbatim?:boolean}> = [];
  private creatingDeliveryId: string | undefined;
  private creatingNotice:{notice:{text:string;id?:string;valid?:()=>boolean;verbatim?:boolean};speechSeq:number}|null=null;
  private noticeSeq=0;
  private pendingNotice:{itemId:string;wireText:string;speechSeq:number;notice:{text:string;id?:string;valid?:()=>boolean;verbatim?:boolean}}|null=null;
  private suppressDispatch = false;
  private localCancelResponseId: string | null = null;
  private readonly silencedResponses = new Set<string>();
  private pendingStop = false;
  private browserAbort = new AbortController();
  private browserQueue: Promise<unknown> = Promise.resolve();
  private readonly finishedResponses = new Set<string>();
  private autoResponsePending: number | null = null;
  private held: {id: string; seq: number; events: Array<{type: string; event: ProviderEvent}>} | null = null;
  private readonly droppedResponses = new Set<string>();

  private readonly planResponseOrigins: number[] = [];
  private planRoutingAbort = new AbortController();
  private planDecision: { seq: number; status: 'pending' | 'native' | 'handled' | 'failed' } | null = null;
  private get planMode(): boolean { return this.options.model === 'stepaudio-2.5-realtime'; }
  private get model(): RealtimeVoiceModel { return this.options.model ?? MODEL; }

  constructor(options: RealtimeVoiceConnectionOptions) {
    this.options = options;
  }

  start(): void {
    if (this.phase !== 'idle') return this.log({type: 'start_ignored', phase: this.phase});
    this.phase = 'connecting';
    this.sendToClient({type: 'status', text: '正在连接语音服务…'});
    this.log({type: 'connecting'});
    const socket = this.options.connect?.(this.options.key) ?? new WebSocket(this.planMode ? `wss://api.stepfun.com/step_plan/v1/realtime?model=${this.model}` : ENDPOINT, {headers: {Authorization: `Bearer ${this.options.key}`}});
    this.ws = socket;
    socket.on('message', (data: RawData) => this.onProviderMessage(data));
    socket.on('error', (error: Error) => {
      this.log({type: 'socket_error', message: error.message});

      if (!this.closed) this.fatal('连不上语音服务：检查网络，或在「更多 → 模型与语音」里核对语音 key，再试一次。');
    });
    socket.on('close', (code: number, reason: Buffer) => this.onSocketClose(code, reason.toString()));
    this.armTimer('connect', CONNECT_TIMEOUT_MS, () => this.fatal('连接语音服务超时，请重试'));
  }

  handle(message: Record<string, unknown>): void {
    const type = asString(message.type);

    if (type === 'stop') return this.close();

    if (type === 'stop_speech') return this.stopSpeech();

    if (type === 'barge_in') return this.bargeIn();

    if (type === 'commit_audio' && this.options.diagnostic) { this.socketSend({type:'input_audio_buffer.commit'});

 return; }

    if (type === 'audio') {
      if (this.phase !== 'ready') return this.log({type: 'audio_before_ready_ignored'});
      const data = asString(message.data);

      if (data) {
        this.socketSend({type: 'input_audio_buffer.append', audio: data});
        this.watchForStall(data);
      }

      return;
    }

    if (type === 'text') {
      if (this.phase !== 'ready') return this.log({type: 'text_before_ready_ignored'});
      const text = (asString(message.text) ?? '').trim();

      if (!text) return;
      this.pendingStop = false;
      this.browserAbort.abort(); this.browserAbort = new AbortController();
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

  notifyTask(text: string, id?: string, valid?:()=>boolean, verbatim=false): void {
    const trimmed = text.trim();

    if (!trimmed || this.closed) return;

    if(this.queuedNotify.length>=256)return this.fatal('待播任务结果过多，语音已停止；结果仍保留在侧栏。');
    this.queuedNotify.push({text:trimmed,id,valid,verbatim});
    this.maybeFlush();
    this.log({type:'notify_queued',chars:trimmed.length});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.phase = 'closed';
    this.browserAbort.abort();
    this.planRoutingAbort.abort();
    this.clearTimers();

    for (const waiter of this.inputWaiters) waiter(null);
    this.inputWaiters = [];

    try {
      this.ws?.close(1000, 'voice ended');
    } catch {
    }

    this.log({type: 'closed'});
    this.sendToClient({type: 'closed'});
  }

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

    if (!type.endsWith('input_audio_transcription.delta')) this.lastProviderEventAt = Date.now();

    if (type === 'input_audio_buffer.speech_stopped' || type === 'input_audio_buffer.speech_backchannel' || type.endsWith('input_audio_transcription.completed')) this.unansweredSpeechMs = 0;

    if (eventId) {
      if (this.seenEventIds.has(eventId)) return this.log({type: 'provider_event_duplicate', providerType: type});
      this.seenEventIds.add(eventId);

      if (this.seenEventIds.size > MAX_SEEN_EVENTS) this.seenEventIds.clear();
    }

    const responseId = asString(event.response_id) ?? asString(asRecord(event.response)?.id);
    if (this.planMode && type.startsWith('response.') && type !== 'response.created' && (!responseId || !this.responseInputs.has(responseId))) {
      this.log({type: 'plan_unknown_response', responseId: responseId ?? null});
      return this.fatal('语音回复来源无法确认，已关闭语音；网页任务保留，请重新开启语音。');
    }

    if (responseId && this.droppedResponses.has(responseId)) {
      if (type === 'response.done') this.onResponseDone({response: {id: responseId, status: 'cancelled'}});

      return;
    }

    if (responseId && this.held?.id === responseId) {
      if (this.planMode && this.held.events.length >= 2048) { this.failPlanRouting('语音回复过长，这句话没有执行，请重说。'); return; }
      this.held.events.push({type, event});

      return;
    }

    this.dispatchProviderEvent(type, event);
  }

  private dispatchProviderEvent(type: string, event: ProviderEvent): void {
    switch (type) {
      case 'session.created': return this.onSessionCreated(event);
      case 'session.updated': return this.onSessionUpdated(event);
      case 'response.created': {
        const id = asString(asRecord(event.response)?.id) ?? asString(event.response_id) ?? `resp-${++this.responseSeq}`;
        const noticeResponse = this.creatingNotice?.speechSeq === this.speechSeq && this.sendingResponse;
        const autoForSpeech = this.autoResponsePending === this.speechSeq && !this.sendingResponse;
        this.activeResponseId = id;
        const planOrigin = this.planMode && !noticeResponse ? this.planResponseOrigins.shift() : this.speechSeq;
        this.responseInputs.set(id, planOrigin ?? -1);
        if (this.planMode && this.planResponseOrigins.length === 0) this.clearTimer('plan-source');

        if(this.creatingNotice){
          if(this.creatingNotice.speechSeq===this.speechSeq&&!this.pendingStop){
            if(this.creatingDeliveryId)this.sendToClient({type:'delivery_response',deliveryId:this.creatingDeliveryId,responseId:id});
          }else this.queuedNotify.unshift(this.creatingNotice.notice);
        }

        this.creatingDeliveryId=undefined;this.creatingNotice=null;
        this.log({type:'response_created',responseId:id,requested:this.sendingResponse,autoPending:this.autoResponsePending!==null});
        this.sendingResponse = false;
        this.busyRetries = 0;
        this.clearTimer('create-watch');
        this.autoResponsePending = null;
        this.clearTimer('auto-response-watchdog');

        if (this.planMode && !noticeResponse && planOrigin !== this.speechSeq) { this.dropResponse(id); return; }
        if (this.pendingStop) {
          this.socketSend({type: 'response.cancel'});
          this.localCancelResponseId = id;
          this.pendingStop = false;
          this.log({type: 'late_response_cancelled', responseId: id});
        } else if (this.planMode && !this.options.diagnostic && !noticeResponse) this.gatePlanResponse(id);
        else if (autoForSpeech && !this.options.diagnostic && this.options.holdForTranscript?.()) this.gateResponse(id);

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
      case 'conversation.item.created': {
        const pending=this.pendingNotice,item=asRecord(event.item);

        const content=Array.isArray(item?.content)?item.content.map(part=>{const c=asRecord(part);

return asString(c?.text)??asString(c?.transcript)??'';}).join(''):'';

        // WHY: Preview currently replaces client IDs and echoes input_text as audio/transcript.
        // Match the exact sent content, never just 'the next user item'.
        if(pending&&(item?.id===pending.itemId||(item?.role==='user'&&content===pending.wireText))){
          this.clearTimer('notice-ack');this.pendingNotice=null;

          if(pending.notice.valid&&!pending.notice.valid()){this.suppressDispatch=false;}
          else if(pending.speechSeq!==this.speechSeq||this.pendingStop){this.queuedNotify.unshift(pending.notice);this.suppressDispatch=false;}
          else {this.creatingDeliveryId=pending.notice.id;this.creatingNotice={notice:pending.notice,speechSeq:pending.speechSeq};this.wantResponse=true;}

          this.log({type:'notify_accepted',itemId:pending.itemId,deliveryId:pending.notice.id});this.maybeFlush();
        }

        return;
      }

      case 'input_audio_buffer.speech_started':
        if (this.planMode) {
          this.planRoutingAbort.abort(); this.planRoutingAbort = new AbortController();
          this.clearTimer('plan-routing'); this.planDecision = null;
          if (this.held) this.dropResponse(this.held.id);
          else if (this.activeResponseId) this.dropResponse(this.activeResponseId);
        }
        this.browserAbort.abort(); this.browserAbort = new AbortController();
        this.userSpeaking = true;
        this.silenceOutput();

        if(this.creatingNotice){this.queuedNotify.unshift(this.creatingNotice.notice);this.creatingNotice=null;this.creatingDeliveryId=undefined;this.suppressDispatch=false;}

        this.speechStopAt = null;
        this.firstTextNoted = false;
        this.firstAudioNoted = false;
        this.latestInput = null;
        this.pendingStop = false;
        this.autoResponsePending = null;
        this.clearTimer('auto-response-watchdog');
        this.speechSeq += 1;
        this.speechItemId=asString(event.item_id);

        if(this.speechItemId)this.speechItems.set(this.speechItemId,{seq:this.speechSeq,at:Date.now()});

        for(const [id,item] of this.speechItems)if(item.seq<this.speechSeq-4)this.speechItems.delete(id);

        for(const [id,item] of this.pendingInputs)if(item.seq<this.speechSeq-3||Date.now()-item.at>30000)this.pendingInputs.delete(id);
        this.sendToClient({type:'input_start',itemId:this.speechItemId});
        this.log({type: 'speech_started'});

        return this.emitMetric('vad_speech_started_since_ready', this.sinceReady());
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        this.speechStopAt = Date.now();
        {const itemId=asString(event.item_id)??this.speechItemId;const item=itemId?this.speechItems.get(itemId):undefined;

if(item&&itemId)this.speechItems.set(itemId,{...item,at:this.speechStopAt});}

        if (this.planMode && !this.options.diagnostic) {
          if (this.planResponseOrigins.length >= 32) return this.fatal('语音回复来源无法确认，请重新开启语音。');
          if (this.planResponseOrigins.length === 0) this.armTimer('plan-source', 20_000, () => this.fatal('语音回复来源仍未确认，已关闭语音；网页任务保留，请重新开启语音。'));
          this.planResponseOrigins.push(this.speechSeq);
        }
        if (this.planMode && !this.options.diagnostic && !this.latestInput) this.armTimer('plan-routing', 20_000, () => this.failPlanRouting('没有及时听清这句话，未执行，请重说。'));
        this.log({type: 'speech_stopped'});
        this.emitMetric('vad_speech_stopped_since_ready', this.sinceReady());

        if (!this.options.diagnostic) {
          // WHY: server_vad 多半会自动创建这一轮回复；created 抵达前不能抢发 response.create，
          // 否则会和服务端自己的回复相撞
          this.autoResponsePending = this.speechSeq;
          this.armTimer('auto-response-watchdog', AUTO_RESPONSE_WATCHDOG_MS, () => {
            this.log({type: 'auto_response_watchdog', speechSeq: this.autoResponsePending});
            this.autoResponsePending = null;
            if (!this.sendingResponse) this.pendingStop = false;
            this.maybeFlush();
          });
        }

        return this.maybeFlush();
      case 'input_audio_buffer.speech_backchannel': {
        this.userSpeaking = false;
        this.speechStopAt = null;
        this.log({type: 'speech_backchannel'});

        return this.maybeFlush();
      }

      default:
        if (type === 'error' || type.endsWith('_error')) this.onProviderError(type, event);
    }
  }

  private watchForStall(data: string): void {
    if (this.options.diagnostic || this.phase !== 'ready') return;
    const bytes = atob(data);
    let peak = 0;

    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const sample = ((bytes.charCodeAt(i) | (bytes.charCodeAt(i + 1) << 8)) << 16) >> 16;

      peak = Math.max(peak, Math.abs(sample));
    }

    const now = Date.now();

    if (peak > STALL_SPEECH_PEAK) {
      this.unansweredSpeechMs += (bytes.length / 2 / SAMPLE_RATE) * 1000;
      this.lastSpeechAt = now;

      return;
    }

    const owed = this.unansweredSpeechMs >= STALL_MIN_SPEECH_MS || this.userSpeaking;

    if (!owed || now - this.lastSpeechAt < STALL_MS || now - this.lastProviderEventAt < STALL_MS) return;
    this.log({type: 'provider_stalled', speechMs: Math.round(this.unansweredSpeechMs), quietMs: now - this.lastSpeechAt, silentMs: now - this.lastProviderEventAt});
    this.sendToClient({type: 'error', message: '语音服务没有响应，正在重新连接；连上后请再说一遍。', recoverable: true, sayAgain: true});
    this.close();
  }

  private onSessionCreated(event: Record<string, unknown>): void {
    const model = asString(asRecord(event.session)?.model) ?? null;
    this.createdModel = model;
    this.log({type: 'session_created', model});

    if (model !== this.model) return this.fatal(`语音服务返回的模型是 ${model ?? '未知'}，不是 ${this.model}`);
    this.phase = 'configuring';
    this.socketSend({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.planMode && !this.options.diagnostic ? withPersona(this.options.persona, '你是 By Your Side 的语音搭子。只做自然闲聊，不自行操作或读取网页。不要说已经做完、正在去做或承诺执行网页任务；网页工作由宿主助手办理。系统通知只根据给出的真实结果说一句话，不把接收请求说成完成。') : this.options.diagnostic ? '只转写用户音频，不执行任务。' : withPersona(this.options.persona, (this.options.tools.browserTool ? INSTRUCTIONS.split('\n').filter(line => !line.startsWith('- 用户要求操作浏览器')).join('\n') : INSTRUCTIONS)+(this.options.tools.task_action&&!this.options.tools.browserTool?'\n- 明确的开始/修改/暂停/继续任务，优先用 task_action 交给同一任务执行器，不再用 browser_request 重复分类。targetId 只能来自 task_status 返回的任务 ID；未指明时作用当前任务，指代不清先查询或澄清。参数不写用户原话，宿主使用真实转写。取消任务仍用 browser_request。':'')+(this.options.tools.browserTool?REALTIME_BROWSER_INSTRUCTIONS:'')),
        voice: this.options.voice ?? STEP_VOICE,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: this.options.diagnostic ? null : {type: 'server_vad', prefix_padding_ms: 500, silence_duration_ms: 300, energy_awakeness_threshold: 2500},
        ...(this.planMode ? { input_audio_transcription: { model: 'stepaudio-2.5-asr' } } : {}),
        tools: this.planMode || this.options.diagnostic ? [] : [...(this.options.tools.browserTool?REALTIME_BROWSER_TOOLS:[]),...TOOL_DEFINITIONS.map(tool=>this.options.tools.task_action&&tool.function.name==='browser_request'?{...tool,function:{...tool.function,description:'Legacy fallback ONLY for cancelling a task, an ambiguous task/control request, or splitting unrelated concurrent tasks. Do NOT use for a clear start/steer/pause/resume: use task_action. Several page operations toward one goal are one start task, not ambiguous.'}}:tool),...(this.options.tools.task_action?[{type:'function',function:{name:'task_action',description:this.options.tools.browserTool?'Delegate only work that needs extended research or content generation, or steer/pause/resume an existing background task. Use the directly available browser tools for browser operations; do not delegate simple operations. The host supplies the actual user utterance.':'Execute browser operations, including switching/opening/closing tabs, navigation, clicking, filling and searching; or modify/pause/resume an identified task. Use start for a new operation. Reading the current page is not a substitute for performing an operation. No extra intent-classification round. Uses the actual latest user utterance; cannot authorize webpage side effects by itself. Omit targetId for current task; otherwise use an observed ID from task_status.',parameters:{type:'object',properties:{action:{type:'string',enum:['start','steer','pause','resume']},targetId:{type:'string'},includePending:{type:'boolean',description:'Only true when the latest speech continues/corrects a previous request that failed before dispatch (reported as undispatched in tool output). False/omitted for a new unrelated request. Preserves original speech fragments; never invents text.'}},required:['action'],additionalProperties:false}}}]:[])],
      },
    });
    this.armTimer('connect', CONNECT_TIMEOUT_MS, () => this.fatal('语音服务没有确认会话配置，连接超时'));
  }

  private onSessionUpdated(event: Record<string, unknown>): void {
    if (this.phase === 'ready') return;
    const session = asRecord(event.session) ?? {};
    const issues = configurationIssues(this.createdModel, session, !this.options.diagnostic, this.options.voice ?? STEP_VOICE, this.model);

    if (issues.length > 0) return this.fatal(`语音配置未生效：${issues.join('；')}`);
    this.phase = 'ready';
    this.readyAt = Date.now();
    this.handshakeRetries = 0;
    this.clearTimer('connect');
    this.log({type: 'ready', model: this.createdModel, voice: session.voice, vad: asRecord(session.turn_detection)?.type});
    this.sendToClient({type: 'ready', model: this.createdModel ?? this.model});
    this.maybeFlush();
  }

  private onAudioDelta(event: Record<string, unknown>): void {
    const delta = asString(event.delta);

    if (!delta) return;
    const responseId = asString(event.response_id) ?? this.activeResponseId ?? 'resp-unknown';

    if (this.localCancelResponseId === responseId) return this.log({type: 'audio_after_stop_skipped', responseId});

    if (this.silencedResponses.has(responseId)) return;
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

    if (this.finalizedText.has(responseId)) return;

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
    const text = (asString(event.transcript) ?? asString(event.text) ?? this.assistantText.get(responseId) ?? '').trim();
    const prior = text ? this.finalizedText.get(responseId) : undefined;

    if (text) {
      this.assistantText.set(responseId, text);

      if (prior !== text) this.finalizedText.set(responseId, text);
    }

    if (!text || prior === text) return;
    this.sendToClient({type: 'transcript', role: 'assistant', text, final: true, responseId});
  }

  private onUserCompleted(event: Record<string, unknown>): void {
    const text = (asString(event.transcript) ?? '').trim();

    if (!text) return; // WHY: 只有噪声没有识别结果，不算一条请求
    // 缺 item_id 时不能都叫 user-input，会和已消费的旧回合撞 id；按 speech 轮 + 序号给唯一 id。
    const itemId = asString(event.item_id) ?? `speech-${this.speechSeq}-${++this.asrSeq}`;
    const knownRequest = this.requests.get(itemId)?.input;
    const origin=this.speechItems.get(itemId) ?? (knownRequest ? {seq:knownRequest.turn-1,at:0} : undefined);

    if (this.planMode && !this.options.diagnostic && (!asString(event.item_id) || !origin)) {
      this.failPlanRouting('无法确认这句话属于当前语音，未执行，请重说。'); return;
    }
    if(this.consumedInputIds.has(itemId))return;

    if((origin && origin.seq !== this.speechSeq) || (this.speechItemId&&asString(event.item_id)&&itemId!==this.speechItemId)){
      if(origin&&origin.seq>=this.speechSeq-3&&Date.now()-origin.at<=12000){
        this.pendingInputs.set(itemId,{...origin,text});this.log({type:'late_asr_retained',itemId,speechSeq:origin.seq});
        this.sendToClient({type:'transcript',role:'user',text,final:true,itemId,turn:origin.seq+1,current:false});
      }else this.log({type:'late_asr_ignored',itemId});

      return;
    }

    this.pendingInputs.set(itemId,{seq:this.speechSeq,at:origin?.at??Date.now(),text});
    this.recordUserInput({id: itemId, text});
    this.sendToClient({type: 'transcript', role: 'user', text, final: true,itemId,turn:this.speechSeq+1,current:true});

    if (this.planMode && !this.options.diagnostic) { this.routePlanInput(text, itemId); return; }

    if (this.held?.seq === this.speechSeq) {
      if (this.options.claimTranscript?.(text)) this.claimResponse(this.held.id);
      else this.releaseHeld('transcript');
    }
  }

  private failPlanRouting(message: string): void {
    this.planRoutingAbort.abort(); this.clearTimer('plan-routing');
    this.planDecision = { seq: this.speechSeq, status: 'failed' };
    if (this.held) this.dropResponse(this.held.id);
    this.sendToClient({type: 'status', phase: 'idle', text: message});
    this.log({type: 'plan_routing_failed'});
  }

  private gatePlanResponse(id: string): void {
    const decision = this.planDecision;
    if (decision?.seq === this.speechSeq && decision.status === 'native') return;
    if (decision?.seq === this.speechSeq && ['handled','failed'].includes(decision.status)) { this.dropResponse(id); return; }
    this.held = { id, seq: this.speechSeq, events: [] };
    if (!decision) this.armTimer('plan-routing', 20_000, () => this.failPlanRouting('没有及时听清这句话，未执行，请重说。'));
    this.log({type: 'plan_response_held', responseId: id});
  }

  private routePlanInput(text: string, itemId: string): void {
    if (this.planDecision?.seq === this.speechSeq) return;
    const seq = this.speechSeq, abort = this.planRoutingAbort;
    const current = () => !this.closed && !abort.signal.aborted && this.speechSeq === seq;
    this.planDecision = { seq, status: 'pending' };
    this.consumedInputIds.add(itemId);
    this.armTimer('plan-routing', 20_000, () => this.failPlanRouting('这句话的分流没有完成，未确认执行，请查看侧栏。'));
    this.log({type: 'plan_route_started', inputId: itemId});
    void (this.options.routeTranscript?.(text, current) ?? Promise.reject(new Error('missing router'))).then(result => {
      if (!current()) return;
      this.clearTimer('plan-routing');
      this.planDecision = { seq, status: result.native ? 'native' : 'handled' };
      this.log({type: 'plan_route_decided', native: result.native, inputId: itemId});
      if (result.native) { if (this.held?.seq === seq) this.releaseHeld('native_chat'); }
      else {
        if (this.held?.seq === seq) this.dropResponse(this.held.id);
        if (result.spokenText) this.notifyTask(result.spokenText, undefined, current, true);
      }
    }).catch(() => { if (current()) this.failPlanRouting('这句话的分流失败，未确认执行，请查看侧栏。'); });
  }

  private gateResponse(id: string): void {
    const input = this.latestInput;

    if (input && !this.consumedInputIds.has(input.id)) {
      if (this.options.claimTranscript?.(input.text)) this.claimResponse(id);

      return;
    }

    this.held = {id, seq: this.speechSeq, events: []};
    this.log({type: 'transcript_gate_hold', responseId: id});
    this.armTimer('transcript-gate', TRANSCRIPT_GATE_MS, () => this.releaseHeld('timeout'));
  }

  private releaseHeld(reason: string): void {
    const held = this.held;

    if (!held) return;
    this.held = null;
    this.clearTimer('transcript-gate');
    this.log({type: 'transcript_gate_release', responseId: held.id, reason, events: held.events.length});

    for (const {type, event} of held.events) this.dispatchProviderEvent(type, event);
  }

  private dropResponse(id: string): void {
    const bufferedDone = this.held?.id === id && this.held.events.some(e => e.type === 'response.done');

    if (this.held?.id === id) {
      this.held = null;
      this.clearTimer('transcript-gate');
    }

    this.droppedResponses.add(id);

    if (bufferedDone || this.doneResponses.has(id)) this.onResponseDone({response: {id, status: 'cancelled'}});
    else this.socketSend({type: 'response.cancel'});
  }

  private claimResponse(id: string): void {
    const input = this.latestInput;
    this.dropResponse(id);
    this.log({type: 'transcript_gate_claimed', responseId: id});

    if (!input || this.consumedInputIds.has(input.id) || !this.options.runClaimed) return;
    this.consumedInputIds.add(input.id);
    void this.options.runClaimed(input.text).then(text => {
      if (text) this.notifyTask(text, undefined, undefined, true);
    }).catch(() => this.notifyTask('任务没有停止：终止请求出错。', undefined, undefined, true));
  }

  private onResponseDone(event: Record<string, unknown>): void {
    const response = asRecord(event.response);
    const id = asString(response?.id) ?? asString(event.response_id) ?? this.activeResponseId;

    if (!id) return this.log({type: 'response_done_without_id'});
    const status = asString(response?.status) ?? 'completed';

    // WHY: The official API also delivers complete tool calls in response.done.output.
    // Both paths share the same idempotent receiver; cancelled/incomplete output never executes.
    if(status==='completed'&&Array.isArray(response?.output))for(const raw of response.output){
      const item=asRecord(raw);

      if(item?.type==='function_call'&&(item.status===undefined||item.status==='completed'))this.onFunctionCall({...item,response_id:id});
    }

    this.finalizeResponseText(id, asString(response?.transcript) ?? asString(response?.text));
    this.markGenerationDone(id);
    this.finishResponseDone(id, status, null);
  }

  private finalizeResponseText(id: string, doneText: string | null): void {
    const incoming = (doneText ?? '').trim();

    if (!incoming) return;
    this.assistantText.set(id, incoming);

    if (this.finalizedText.get(id) === incoming) return;
    this.finalizedText.set(id, incoming);
    this.sendToClient({type: 'transcript', role: 'assistant', text: incoming, final: true, responseId: id});
  }

  private markGenerationDone(id: string): void {
    this.doneResponses.add(id);

    if (this.activeResponseId === id) {
      this.activeResponseId = null;
      this.sendingResponse = false;
      this.busyRetries = 0;
      this.clearTimer('create-watch');
    }

    this.suppressDispatch = false;
  }

  private finishResponseDone(id: string, status: string, doneText: string | null): void {
    if (this.finishedResponses.has(id)) return;
    this.finishedResponses.add(id);

    if (this.planMode && this.droppedResponses.has(id)) {
      this.playedResponses.add(id); this.clearTimer(`playback:${id}`);
      if (this.localCancelResponseId === id) this.localCancelResponseId = null;
      this.maybeFlush();
      return;
    }

    if (this.activeResponseId === id) this.activeResponseId = null;
    this.finalizeResponseText(id, doneText);
    this.sendToClient({type: 'response_done', responseId: id, status});
    this.log({type: 'response_done', responseId: id, status});

    if (this.localCancelResponseId === id) this.localCancelResponseId = null;
    this.suppressDispatch = false;
    const bytes = this.audioBytes.get(id) ?? 0;

    if (status === 'cancelled') {
      this.playedResponses.add(id);
      this.clearTimer(`playback:${id}`);
      this.sendToClient({type: 'clear_audio'});
    } else if (bytes > 0 && !this.playedResponses.has(id)) {
      // WHY: Tool continuations can arrive while earlier audio is still queued in
      // VoicePlayer. Its deadline must include that queue, not only this reply.
      let queuedBytes = 0;

      for (const [responseId, count] of this.audioBytes) {
        if (!this.playedResponses.has(responseId)) queuedBytes += count;

        if (responseId === id) break;
      }

      const wait = Math.min(PLAYBACK_MAX_WAIT_MS, Math.ceil((queuedBytes / (SAMPLE_RATE * 2)) * 1000) + PLAYBACK_TAIL_MS);
      this.armTimer(`playback:${id}`, wait, () => {
        this.fatal('未收到实际播放完成确认，语音已停止；后台任务不取消，请重新开启语音。');
      });
    }

    this.maybeFlush();
  }

  private onFunctionCall(event: Record<string, unknown>): void {
    if (this.planMode) { this.log({type: 'plan_tool_ignored'}); return; }
    if (this.options.diagnostic) return;
    const callId = (asString(event.call_id) ?? '').trim();

    if (!callId) return this.log({type:'tool_call_ignored',reason:'missing_call_id',name:event.name});

    if (this.seenCallIds.has(callId)) return this.log({type:'tool_call_ignored',reason:'duplicate_call_id',callId,name:event.name});
    this.seenCallIds.add(callId);
    const responseId=asString(event.response_id)??this.activeResponseId;

    if(this.pendingStop||(responseId!==null&&responseId===this.localCancelResponseId))return this.log({type:'tool_call_ignored',reason:'cancelled_response',callId,name:event.name});

    const call: PendingToolCall = {
      speechSeq:responseId?this.responseInputs.get(responseId)??this.speechSeq:this.speechSeq,
      callId,
      name: asString(event.name) ?? 'unknown',
      responseId: asString(event.response_id) ?? this.activeResponseId,
      output: null,
      settled: false,
      arguments:(()=>{try{return asRecord(JSON.parse(asString(event.arguments)??'{}'))??undefined;}catch{return undefined;}})(),
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

    if (this.phase !== 'ready') {
      if (this.retryHandshake(message)) return;

      return this.fatal(`语音服务出错：${message}`);
    }

    if (this.planMode && this.planDecision?.seq === this.speechSeq && this.planDecision.status === 'failed'
      && /no ongoing response to cancel/i.test(message)) return;

    if (/busy|active|already|已有|进行中/i.test(`${code} ${message}`)) {
      this.sendingResponse = false;
      this.clearTimer('create-watch');

      if (this.pendingStop) { this.pendingStop = false; return; }
      this.wantResponse = true;
      const retrying = this.busyRetries++ < MAX_BUSY_RETRIES;

      if (!retrying) return this.fatal('语音服务持续繁忙，通话已停止；后台任务保留，请重试。');
      this.armTimer('busy-retry', BUSY_RETRY_MS, () => this.maybeFlush());

      return this.sendToClient({type:'status',text:'语音服务正忙，稍后重试'});
    }

    if(this.pendingNotice)return this.fatal('任务通知未被语音服务接收，未标记已播报；文字结果仍保留在侧栏。');
    this.sendToClient({type: 'status', text: `语音服务提示：${message}`});
  }

  private async executeTool(call: PendingToolCall): Promise<void> {
    const started = Date.now();
    const direct = !!this.options.tools.browserTool && REALTIME_BROWSER_TOOL_NAMES.some(name=>name===call.name);
    let result: unknown;

    try {
      if(call.speechSeq!==this.speechSeq)throw realtimeBrowserError('这轮请求已过期，没有执行工具。', 'not_executed');

      if (call.name === 'browser_request') result = await this.runBrowserRequest(call.speechSeq);
      else if(call.name==='task_action'){
        if(!this.options.tools.task_action)throw new Error('结构化任务入口未启用');
        const args=call.arguments;

        if(!args||!['start','steer','pause','resume'].includes(String(args.action))||Object.keys(args).some(k=>!['action','targetId','includePending'].includes(k))||(args.includePending!==undefined&&typeof args.includePending!=='boolean')||(args.targetId!==undefined&&(typeof args.targetId!=='string'||!args.targetId)))throw new Error('任务动作参数无效，未执行');
        // SAFETY: 上一行已校验 args.action 属于四个枚举值、键白名单、includePending 布尔、targetId 非空字符串，
        // 运行时形状已满足 RealtimeTaskAction，这里只是让编译器接受已验证的 JSON 记录。
        result=await this.runBrowserRequest(call.speechSeq,args as unknown as RealtimeTaskAction);
      }
      else if (call.name === 'read_page') {
        const page = await this.options.tools.read_page();
        const record = asRecord(page);

        result = this.options.tools.browserTool && record?.ok === true ? {...record, next: READ_PAGE_ACTION_HINT} : page;
      }
      else if (call.name === 'task_status') result = await this.options.tools.task_status();
      else if (this.options.tools.browserTool && REALTIME_BROWSER_TOOLS.some(t => t.function.name === call.name)) {
        const signal = this.browserAbort.signal;
        const run = this.browserQueue.then(() => this.runDirectBrowserTool(call, signal));
        this.browserQueue = run.catch(() => {});
        result = await run;
      }
      else result = {ok: false, error: `未知工具 ${call.name}`};
    } catch (error) {
      const facts = asRecord(error);
      const rejectionFeedback = direct ? asRecord(facts?.feedback) : null;
      const directReadbackPiece = direct && facts?.readback ? { readback: facts.readback } : {};
      const directFeedbackPiece = direct && rejectionFeedback ? { feedback: rejectionFeedback } : {};
      const directPiece = direct ? { toolCallId: facts?.toolCallId, transportId: facts?.transportId, executionFact: facts?.executionFact, ...directReadbackPiece, ...directFeedbackPiece } : {};
      result = {ok: false, error: errorMessage(error), ...directPiece};
    }

    if (direct) {
      const output = asRecord(result);
      const fact = output?.executionFact;
      result = {...(output ?? {content:result}), executionFact:fact === 'executed' || fact === 'not_executed' ? fact : 'unknown'};
    }

    const feedback = direct ? asRecord(asRecord(result)?.feedback) : null;
    call.feedback = isExecutionFeedback(feedback) ? feedback : undefined;

    if (direct) {
      const visible = {...asRecord(result)};
      delete visible.feedback;
      result = call.feedback ? {...visible, hostFeedback:{text:call.feedback.text}} : visible;
    }

    call.output = serializeToolOutput(result, direct);
    const receipt = asRecord(result);
    call.deferReply = call.name === 'task_action' && receipt?.ok === true && ['accepted','queued'].includes(String(receipt.status));
    const failed=asRecord(result)?.ok===false;
    call.failed=failed;
    call.executionFact = asString(receipt?.executionFact) ?? undefined;
    const errorPiece = failed ? { error: asRecord(result)?.error } : {};
    const logEntry = {type: 'tool_output', callId: call.callId, name: call.name, ms: Date.now() - started, ok:!failed, ...errorPiece};
    this.log(logEntry);

    if(call.name==='read_page'&&failed)this.sendToClient({type:'status',text:`未读到页面：${asString(asRecord(result)?.error)??'页面资料不可用'}`});
    this.maybeFlush();
  }

  private async runDirectBrowserTool(call: PendingToolCall, signal: AbortSignal): Promise<unknown> {
    const current = () => !this.closed && !signal.aborted && !this.pendingStop && !this.suppressDispatch && call.speechSeq === this.speechSeq;
    const superseded = () => !this.closed && !this.pendingStop && call.speechSeq !== this.speechSeq;

    if (!current()) throw realtimeBrowserError(superseded() ? SUPERSEDED_BY_SPEECH : '这轮浏览器请求已取消或过期，未执行。', 'not_executed');

    if (!call.arguments) throw realtimeBrowserError('工具参数不是有效 JSON，未执行。', 'not_executed');
    validateRealtimeBrowserTool(call.name, call.arguments);
    const input = await this.resolveUserInput(false);

    if (!current() || !input) throw realtimeBrowserError(superseded() ? SUPERSEDED_BY_SPEECH : '尚无本轮真实用户要求，未执行浏览器操作。', 'not_executed');

    if (this.consumedInputIds.has(input.id)) throw realtimeBrowserError('本轮已交给后台任务，不能同时直接操作。', 'not_executed');
    call.inputId = input.id;
    this.log({type:'browser_tool_dispatch',name:call.name,callId:call.callId,inputId:input.id});

    return this.options.tools.browserTool!({name:call.name,args:call.arguments,callId:call.callId,inputId:input.id,text:input.text}, signal);
  }

  private async runBrowserRequest(speechSeq:number,action?:RealtimeTaskAction): Promise<unknown> {
    if (this.suppressDispatch) return {ok: false, error: '这轮是后台任务的进展通知，不是用户的新要求；没有执行网页操作'};
    const input = await this.resolveUserInput(action? action.includePending===true:this.continuationFrom!==null);

    if(this.closed||speechSeq!==this.speechSeq){
      if(!this.closed)this.continuationFrom=Math.min(this.continuationFrom??speechSeq,speechSeq);

      return {ok:false,error:`这次工具在接收转写前遇到了用户继续说话，没有执行。请结合随后补充重新判断完整要求；${this.options.tools.task_action?'若最新话语是在补充这项未执行任务，请调用 task_action 并设置 includePending:true。若用户另提新任务则不合并。':'仍需执行时重新调用 browser_request，由原任务路由核对前后要求。'}不能只声称任务已开始。`,undispatched:[...this.pendingInputs.values()].filter(i=>i.seq>=speechSeq).sort((a,b)=>a.seq-b.seq).map(i=>i.text)};
    }

    if (!input) {
      const stale = this.latestInput;

      if (stale && this.consumedInputIds.has(stale.id)) return {ok: false, error: '这个请求已经交给页面任务，不需要重复执行'};

      return {ok: false, error: '还没有识别到用户的原始请求，没有执行网页操作'};
    }

    if (this.consumedInputIds.has(input.id)) return {ok: false, error: '这个请求已经交给页面任务，不需要重复执行'};

    for(const id of input.sourceIds??[input.id])this.consumedInputIds.add(id);

    for(const [id,p] of this.pendingInputs)if(p.seq<=this.speechSeq)this.pendingInputs.delete(id);
    this.continuationFrom=null;
    this.log({type: action?'task_action_dispatch':'browser_request', inputId: input.id, chars: input.text.length,inputSequences:input.inputSequences});
    this.sendToClient({type: 'status', text: '正在把请求交给网页任务…'});
    const result = action?await this.options.tools.task_action!(input.text,action,input.inputSequences):await this.options.tools.browser_request(input.text,input.inputSequences);
    this.sendToClient({type:'status',text:asRecord(result)?.ok===false?'任务未执行，请核对侧栏结果。':'任务处理结果已返回，有新进展会说明。'});

    return result;
  }

  private inputWithContinuation(input:UserInput,includePending=false):UserInput|null{
    const floor=includePending?(this.continuationFrom??this.speechSeq):this.speechSeq;
    const parts=[...this.pendingInputs.entries()].filter(([id,p])=>!this.consumedInputIds.has(id)&&p.seq<=this.speechSeq&&p.seq>=Math.max(floor,this.speechSeq-3)&&Date.now()-p.at<=(includePending?30000:12000)).sort((a,b)=>a[1].seq-b[1].seq);

    if(includePending&&floor<this.speechSeq&&!parts.some(([,p])=>p.seq===floor))return null;

    if(!parts.some(([id])=>id===input.id))return input;

    return {id:input.id,text:parts.map(([,p])=>p.text).join('\n'),inputSequences:parts.map(([,p])=>p.seq),sourceIds:parts.map(([id])=>id)};
  }
  private resolveUserInput(includePending=false): Promise<UserInput | null> {
    const candidate = this.latestInput;

    if (candidate) return Promise.resolve(this.consumedInputIds.has(candidate.id) ? null : this.inputWithContinuation(candidate,includePending));

    return new Promise(resolve => {
      const deliver = (input: UserInput | null): void => {
        clearTimeout(timer);
        this.inputWaiters = this.inputWaiters.filter(waiter => waiter !== deliver);
        resolve(input?this.inputWithContinuation(input,includePending):null);
      };

      const timer = setTimeout(() => {
        this.inputWaiters = this.inputWaiters.filter(waiter => waiter !== deliver);
        const late = this.latestInput;
        resolve(late && !this.consumedInputIds.has(late.id) ? this.inputWithContinuation(late,includePending) : null);
      }, ASR_WAIT_MS);

      this.inputWaiters.push(deliver);
    });
  }

  private recordUserInput(input: UserInput): void {
    if (this.consumedInputIds.has(input.id)) return;

    if (!this.requests.has(input.id)) {
      const identity: VoiceRequestInput = {voiceId: this.options.voiceId ?? '', turn: this.speechSeq + 1,
        itemId: input.id, inputId: input.id, text: input.text};

      this.requests.set(input.id, {input: identity});
    }

    this.latestInput = input;
    this.log({type: 'user_input', inputId: input.id, chars: input.text.length});
    const waiters = this.inputWaiters;
    this.inputWaiters = [];

    for (const waiter of waiters) waiter(input);
  }

  private maybeFlush(): void {
    if (this.phase !== 'ready' || this.closed) return;

    if (this.planMode && this.planResponseOrigins.length > 0) return;

    if (this.pendingStop||this.pendingNotice) return;

    if (this.autoResponsePending === this.speechSeq) return;

    if (this.activeResponseId !== null || this.sendingResponse || this.userSpeaking) return;

    if ([...this.pendingToolCalls.values()].some(call => !call.settled && call.output === null)) return;
    let replyNeeded = false;
    const batch: PendingToolCall[] = [];

    for (const call of this.pendingToolCalls.values()) {
      if (call.settled || call.output === null) continue;
      const finished = call.responseId === null ? this.activeResponseId === null : this.doneResponses.has(call.responseId);

      if (!finished) continue;
      this.socketSend({type: 'conversation.item.create', item: {type: 'function_call_output', call_id: call.callId, output: call.output}});
      call.settled = true;
      batch.push(call);
      replyNeeded ||= !call.deferReply && !call.muted;
      this.log({type: 'tool_output_sent', callId: call.callId, name: call.name});
    }

    if(!replyNeeded&&this.playbackBusy())return;

    while(this.queuedNotify[0]?.valid&&!this.queuedNotify[0].valid!())this.queuedNotify.shift();

    if (this.queuedNotify.length && !replyNeeded && !this.creatingNotice) {
      const notice = this.queuedNotify.shift()!;
      const text = notice.text;
      const itemId=`bys-notice-${++this.noticeSeq}`;
      const wireText=notice.verbatim?`【系统通知】请原样对用户说这句话，不增删、不改写：${text} 这不是用户的新请求，不要调用工具。`:`【系统通知】${text}。请用一句话自然告知用户，说完就停，不反问、不客套；这不是用户的新请求，不要调用工具。`;
      this.pendingNotice={itemId,wireText,speechSeq:this.speechSeq,notice};
      this.suppressDispatch = true;
      this.socketSend({
        type: 'conversation.item.create',
        item: {id:itemId,type: 'message', role: 'user', content: [{type: 'input_text', text: wireText}]},
      });
      this.armTimer('notice-ack',5000,()=>this.fatal('语音服务未确认任务通知，未标记已播报；文字结果仍保留在侧栏。'));
      this.log({type: 'notify_sent', chars: text.length});

      return;
    }

    if (replyNeeded || this.wantResponse) {
      this.wantResponse = false;
      this.sendingResponse = true;
      this.socketSend({type: 'response.create'});
      this.armTimer('create-watch', RESPONSE_WATCHDOG_MS, () => {
        this.log({type: 'create_watchdog'});
        this.sendingResponse = false;

        if (this.creatingNotice) this.wantResponse = true;
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

  private silenceOutput(): void {
    for (const id of this.audioBytes.keys()) {
      this.silencedResponses.add(id);
      this.playedResponses.add(id);
      this.clearTimer(`playback:${id}`);
    }

    if (this.activeResponseId) this.silencedResponses.add(this.activeResponseId);
  }

  private bargeIn(): void {
    const responseId = this.activeResponseId;
    this.silenceOutput();

    if (responseId && this.held?.id === responseId) this.dropResponse(responseId);
    else if (responseId) {
      this.socketSend({type: 'response.cancel'});
      this.localCancelResponseId = responseId;
    }

    this.log({type: 'barge_in', responseId});
  }

  private stopSpeech(): void {
    const responseId = this.activeResponseId;

    if (responseId === null && (this.sendingResponse || this.autoResponsePending === this.speechSeq)) this.pendingStop = true;

    for (const call of this.pendingToolCalls.values()) if (!call.settled) call.muted = true;
    this.wantResponse = false;
    this.busyRetries = 0;
    this.clearTimer('busy-retry');
    this.clearTimer('create-watch');
    this.sendingResponse = false;

    if (responseId && this.held?.id === responseId) this.dropResponse(responseId);
    else if (responseId) {
      this.socketSend({type: 'response.cancel'});
      this.localCancelResponseId = responseId;
    }

    for (const id of this.audioBytes.keys()) {
      this.playedResponses.add(id);
      this.clearTimer(`playback:${id}`);
    }

    this.sendToClient({type: 'clear_audio'});
    this.sendToClient({type: 'status', phase:'idle',text: '已停止播报'});
    this.log({type: 'stop_speech', responseId});
    this.maybeFlush();
  }

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

  private retryHandshake(reason: string): boolean {
    if (this.closed || this.phase === 'ready' || this.handshakeRetries >= MAX_HANDSHAKE_RETRIES) return false;

    if (this.latestInput !== null || this.requests.size > 0) return false;
    this.handshakeRetries += 1;
    this.log({type: 'handshake_retry', attempt: this.handshakeRetries, reason: reason.slice(0, 120)});
    const old = this.ws;
    this.ws = null;

    if (old) {
      try {
        old.removeAllListeners();
        old.on('error', () => {  });
        old.close();
      } catch {  }
    }

    this.clearTimer('connect');
    this.phase = 'idle';
    this.start();

    return true;
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
