import { realtimeBrowserError, type ExecuteRealtimeBrowserTool } from './realtime-browser-tools.js';
import { progressSpeech } from './voice-receipt.js';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { RealtimeVoiceConnection, type RealtimeTaskAction } from './realtime-voice-connection.js';
import { isExplicitTaskAbort } from './voice-confirm.js';
import type { TaskActionRequest } from '../../shared/task-actions.js';
import type { VoiceCommand, VoiceEvent, VoiceInputContext, VoiceRouteContext, VoiceRouteResult, VoiceTarget, TaskProgressSnapshot, UserDelivery, UserDeliveryStream } from '../../shared/voice.js';
import type { RouteShadow } from './route-shadow.js';
import { base64Bytes } from '../../shared/bytes.js';

export type RealtimeVoiceDependencies = {
  voiceId?: string;
  /** Step timbre id chosen by the user. */
  voice?: string;
  /** 用户所选人设的描述正文；空串表示默认，不附加人设。 */
  persona?: string;
  /** Diagnostic sessions are requested explicitly, lock out routing and never answer on their own. */
  diagnosticMode?: boolean;
  diagnostic?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
  getSnapshot: () => TaskProgressSnapshot | null;
  getDeliverySnapshot?: (stream: UserDeliveryStream) => TaskProgressSnapshot | null;
  getTargets?: () => VoiceTarget[];
  emit: (event: VoiceEvent) => void;
  route?: (text: string, startedAt: number | null, stillCurrent: () => boolean, context: VoiceRouteContext) => Promise<VoiceRouteResult>;
  connect?: (key: string) => WebSocket;
  onPlayback?: (deliveryId: string, status: "speaking" | "played") => void;
  browserTool?: ExecuteRealtimeBrowserTool;
  readPage?: (input: VoiceInputContext) => Promise<unknown>;
  dispatchTask?: (request: TaskActionRequest, stillCurrent: () => boolean) => Promise<unknown>;
  createConnection?: (options: ConstructorParameters<typeof RealtimeVoiceConnection>[0]) => RealtimeVoiceConnection;
  voiceSpokenResultGate?: boolean;
  /** Shared request judgment and optional audit observation; policy lives in the connection. */
  shadow?: RouteShadow;
};

type Input = {
  turn: number;
  snapshot: TaskProgressSnapshot | null;
  targets?: ReturnType<NonNullable<RealtimeVoiceDependencies['getTargets']>>;
  input?: VoiceInputContext;
  error?: string;
  ready: boolean;
};

/** Adapts native sidepanel protocol to the same continuous Realtime 3 connection used in the trial. */
export class RealtimeVoiceSession {
  private connection: RealtimeVoiceConnection | null = null;
  private closed = false;
  private ready = false;
  private turn = 1;
  private input: Input = { turn: 1, snapshot: null, ready: false };
  private readonly inputHistory = new Map<number, Input>();
  private mutedEmit = false;
  private seq = 0;
  private readonly responses = new Map<string, string>();
  private readonly spoken = new Set<string>();
  private readonly notices = new Set<string>();
  private readonly cancelled = new Set<string>();
  /** Route-shadow bookkeeping only: last up-to-3 user transcripts and the most recent transcript's itemId. */
  private recentUserTexts: string[] = [];
  private lastUserItemId: string | undefined;
  constructor(private readonly deps: RealtimeVoiceDependencies) {
  }
  start(key: string): void {
    if (this.closed || this.connection) {
      return;
    }

    this.emit({ kind: 'state', state: 'connecting', detail: '正在连接 Realtime 3' });
    const create = this.deps.createConnection ?? (o => new RealtimeVoiceConnection(o));
    this.connection = create({
      key, connect: this.deps.connect, diagnostic: this.deps.diagnosticMode,
      send: e => this.receive(e),
      log: e => this.deps.diagnostic?.(String(e.type), { detail: JSON.stringify(e) }),
      voiceId: this.deps.voiceId,
      voice: this.deps.voice,
      persona: this.deps.persona,
      voiceSpokenResultGate: this.deps.voiceSpokenResultGate,
      holdForTranscript: () => !!this.deps.dispatchTask && this.controllable(),
      claimTranscript: text => !!this.deps.dispatchTask && this.controllable() && isExplicitTaskAbort(text),
      runClaimed: text => this.abortCurrent(text),
      judgeRequest: async identity => {
        if (this.deps.diagnosticMode || this.closed) return null;
        const snapshot = this.deps.getSnapshot();
        const page = this.input.input?.context;
        const previous = this.recentUserTexts;
        this.recentUserTexts = [...previous, identity.text].slice(-3);

        if (!snapshot) return null;

        return this.deps.shadow?.judge(page ? {channel: 'voice', conversationId: snapshot.conversationId,
          ...identity, previous, taskRunning: snapshot.state === 'running' || snapshot.state === 'paused',
          taskState: snapshot.state, page: {title: page.title, url: page.url}} : {channel: 'voice', conversationId: snapshot.conversationId,
          ...identity, previous, taskRunning: snapshot.state === 'running' || snapshot.state === 'paused',
          taskState: snapshot.state},
          this.deps.voiceSpokenResultGate === true) ?? null;
      },
      tools: {
        ...(!this.deps.diagnosticMode && this.deps.browserTool ? { browserTool: async (call: Parameters<ExecuteRealtimeBrowserTool>[0], signal: AbortSignal) => {
          const origin = this.input;
          await this.waitForInput(origin);

          if (this.closed || signal.aborted || this.input !== origin || !origin.input) throw realtimeBrowserError('语音页面资料已过期，未执行。', 'not_executed');
          this.recordToolActual(origin.turn, this.lastUserItemId, call.name);

          return this.deps.browserTool!({...call,inputId:`${this.deps.voiceId}:${call.inputId}`},origin.input,signal);
        }} : {}),
        ...(!this.deps.diagnosticMode && this.deps.dispatchTask ? { task_action: (text: string, action: RealtimeTaskAction, sequences?: number[]) => this.dispatchTask(text, action, sequences) } : {}),
        browser_request: async (text, sequences) => {
          this.recordToolActual(this.turn, this.lastUserItemId, 'browser_request');

          if (this.deps.diagnosticMode || !this.deps.route) {
            throw new Error('此语音连接不能执行任务。');
          }

          const origin = this.input;
          await this.waitForInput(origin);
          this.assertInputSources(origin, sequences);

          if (this.closed || this.input !== origin) {
            throw new Error('这句话的页面资料已过期，未执行操作。');
          }

          const snapshot = origin.snapshot;

          return this.deps.route(text, snapshot?.startedAt ?? null, () => !this.closed, {
            requestId: randomUUID(), runId: snapshot?.runId ?? null, controlVersion: snapshot?.controlVersion,
            voiceId: this.deps.voiceId ?? 'realtime3', turn: origin.turn, input: origin.input, targets: this.deps.getTargets?.(),
          });
        },
        read_page: async () => {
          this.recordToolActual(this.turn, this.lastUserItemId, 'read_page');

          if (this.deps.diagnosticMode || !this.deps.readPage) {
            throw new Error('当前没有可读取的页面资料。');
          }

          const origin = this.input;
          await this.waitForInput(origin);

          if (this.closed || this.input !== origin || !origin.input) {
            throw new Error('页面资料已过期，未读取。');
          }

          return this.deps.readPage(origin.input);
        },
        task_status: async () => {
          this.recordToolActual(this.turn, this.lastUserItemId, 'task_status');

          return { snapshot: this.deps.getSnapshot(), targets: this.deps.getTargets?.() ?? [] };
        },
      }
    });
    this.connection.start();
  }
  /**
   * 明确的“终止任务”：按用户开口时看到的任务身份直接下发，不经模型或分类器。
   * 成功时不在这里宣称，由语音服务按终止回执和真实状态播报；失败如实说没停。
   */
  private async abortCurrent(text: string): Promise<string | null> {
    const origin = this.input;
    const snapshot = origin.snapshot;

    if (!snapshot || !this.deps.dispatchTask) return '任务没有停止：当前没有可终止的任务。';

    try {
      // SAFETY: dispatchTask 由宿主注入，解析为 shared/task-actions 的 TaskReceipt；这里只读 status 与 message。
      const receipt = await this.deps.dispatchTask({
        requestId: randomUUID(), conversationId: snapshot.conversationId, source: 'voice', action: 'abort',
        expectedRunId: snapshot.runId ?? null, expectedControlVersion: snapshot.controlVersion, text,
      }, () => !this.closed) as { status?: string; message?: string } | undefined;

      return receipt?.status === 'applied' || receipt?.status === 'accepted' ? null : `任务没有停止：${receipt?.message ?? '终止未生效'}`;
    } catch (error) {
      return `任务没有停止：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  private controllable(): boolean {
    return ['running', 'paused', 'interrupted'].includes(this.deps.getSnapshot()?.state ?? '');
  }
  private assertInputSources(origin: Input, sequences?: number[]): void {
    if (!sequences || sequences.length <= 1) {
      return;
    }

    const current = origin.input?.context;

    if (!current || !sequences.every(seq => {
      const input = this.inputHistory.get(seq + 1);
      const context = input?.input?.context;

      return input?.ready && !input.error && context?.tabId === current.tabId && context.url === current.url && input.snapshot?.runId === origin.snapshot?.runId && input.snapshot?.controlVersion === origin.snapshot?.controlVersion;
    })) {
      throw new Error('未执行的前后两段来自不同页面或任务状态，不能拼接操作；请明确当前完整要求。');
    }
  }
  private async dispatchTask(text: string, action: RealtimeTaskAction, sequences?: number[]): Promise<unknown> {
    // Captured once here, not re-read after the await below: a new turn may start while dispatch is in flight,
    // and the later 'dispatch' record must still describe the turn/item that actually requested it.
    const shadowTurn = this.turn, shadowItemId = this.lastUserItemId;
    this.recordToolActual(shadowTurn, shadowItemId, 'task_action', action.action);
    const origin = this.input;
    await this.waitForInput(origin);
    this.assertInputSources(origin, sequences);
    const current = () => !this.closed && this.input === origin;

    if (!current() || !origin.snapshot || !this.deps.dispatchTask) {
      throw new Error('任务输入已过期，未执行');
    }

    const id = action.targetId ?? origin.snapshot.conversationId;
    const target = id === origin.snapshot.conversationId ? { id, runId: origin.snapshot.runId, controlVersion: origin.snapshot.controlVersion } : origin.targets?.find(t => t.id === id);

    if (!target) {
      throw new Error('目标任务不在本轮观察中，未执行');
    }

    if (action.action === 'start' && target.id !== origin.snapshot.conversationId) {
      throw new Error('不能在其他任务会话隐式开始新任务，请明确另开要求');
    }

    const result = await this.deps.dispatchTask((action.action === 'start' || action.action === 'steer') ? {
      requestId: randomUUID(), conversationId: target.id, originConversationId: origin.snapshot.conversationId, source: 'voice', action: action.action,
      expectedRunId: target.runId ?? null, expectedControlVersion: target.controlVersion, text, context: origin.input?.context, attachments: origin.input?.attachments
    } : {
      requestId: randomUUID(), conversationId: target.id, originConversationId: origin.snapshot.conversationId, source: 'voice', action: action.action,
      expectedRunId: target.runId ?? null, expectedControlVersion: target.controlVersion, text
    }, current);

    this.recordDispatchActual(shadowTurn, shadowItemId, action.action, result);

    return result;
  }
  /** Route-shadow only: which of the four voice tools actually ran, bound to the turn and latest user transcript at invocation time. */
  private recordToolActual(turn: number, itemId: string | undefined, name: string, action?: string): void {
    if (this.deps.diagnosticMode) return;
    const conversationId = this.deps.getSnapshot()?.conversationId;

    if (!conversationId) return;
    this.deps.shadow?.actual(action ? { channel: 'voice', conversationId, voiceId: this.deps.voiceId, turn, itemId, kind: 'tool', name, action } : { channel: 'voice', conversationId, voiceId: this.deps.voiceId, turn, itemId, kind: 'tool', name });
  }
  /** Route-shadow only: the receipt status once a dispatched task action actually returns. */
  private recordDispatchActual(turn: number, itemId: string | undefined, action: string, result: unknown): void {
    if (this.deps.diagnosticMode) return;
    const conversationId = this.deps.getSnapshot()?.conversationId;

    if (!conversationId) return;
    const status = result && typeof result === 'object' && typeof (result as { status?: unknown }).status === 'string' ? (result as { status: string }).status : 'unknown';
    this.deps.shadow?.actual({ channel: 'voice', conversationId, voiceId: this.deps.voiceId, turn, itemId, kind: 'dispatch', action, status });
  }
  private async waitForInput(origin: Input): Promise<void> {
    const end = Date.now() + 5000;

    while (!origin.ready && !this.closed && this.input === origin && Date.now() < end) {
      await new Promise(r => setTimeout(r, 20));
    }

    if (this.closed || this.input !== origin || !origin.ready || origin.error) {
      throw new Error(origin.error ?? '页面资料没有及时到达，未执行这句话。');
    }
  }
  command(command: VoiceCommand): void {
    if (this.closed) {
      return;
    }

    switch (command.kind) {
      case 'stop':
        this.close();

        return;
      case 'audio':
        this.connection?.handle({ type: 'audio', data: command.data });

        if (this.deps.diagnosticMode) {
          this.emit({ kind: 'diag', record: { type: 'append', seq: ++this.seq, eventId: `pcm-${this.seq}`, turn: command.turn, frame: command.frame ?? null, samples: Math.floor(base64Bytes(command.data).length / 2), audio: command.data } });
        }

        return;
      case 'interrupt':
        if (this.deps.diagnosticMode) {
          this.turn = command.turn;
          this.input = { turn: this.turn, snapshot: null, ready: true };
        }

        this.connection?.handle({ type: 'stop_speech' });

        return;
      case 'commit':
        if (this.deps.diagnosticMode) {
          this.emit({ kind: 'diag', record: { type: 'commit', seq: ++this.seq, eventId: `commit-${this.seq}`, turn: command.turn } });
          this.connection?.handle({ type: 'commit_audio' });

          return;
        }

        if (command.turn !== this.input.turn) {
          return;
        }

        this.input.input = command.input;
        this.input.ready = !command.contextPending;

        return;
      case 'input_context':
        if (command.turn !== this.input.turn) {
          return;
        }

        this.input.input = command.input;
        this.input.error = command.error;
        this.input.ready = true;

        return;
      case 'playback_done': {
        const delivery = this.responses.get(command.responseId);

        if (delivery) {
          if (this.spoken.has(command.responseId)) {
            this.deps.onPlayback?.(delivery, 'played');
          }
          else {
            this.deps.diagnostic?.('delivery_without_audio', { deliveryId: delivery, responseId: command.responseId });
          }

          this.responses.delete(command.responseId);
        }

        this.connection?.handle({ type: 'playback_done', responseId: command.responseId });

        return;
      }

      default: return;
    }
  }
  private receive(event: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }

    switch (event.type) {
      case 'ready':
        this.ready = true;
        const ready: Extract<VoiceEvent, {kind:'state'}> = { kind: 'state', state: 'ready', detail: 'Realtime 3 已连接' };

        if (!this.deps.diagnosticMode) ready.inputMode = 'server_vad';
        this.emit(ready);

        if (this.deps.diagnosticMode) {
          this.emit({ kind: 'diag', record: { type: 'ready', sampleRate: 24000, maxSeconds: 60 } });
        }

        return;
      case 'status':
        if (this.ready) {
          this.emit({ kind: 'state', state: event.phase === 'idle' ? 'ready' : 'answering', detail: String(event.text ?? '') });
        }

        return;
      case 'input_start':
        if (this.deps.diagnosticMode) {
          return;
        }

        this.turn++;
        // A tool call may arrive for this new turn before its transcript does; the previous
        // turn's itemId must never be attached to it (route-shadow `actual` turn/item binding).
        this.lastUserItemId = undefined;
        this.input = { turn: this.turn, snapshot: this.deps.getSnapshot(), targets: this.deps.getTargets?.(), ready: false };
        this.inputHistory.set(this.turn, this.input);

        for (const turn of this.inputHistory.keys()) {
          if (turn < this.turn - 4) {
            this.inputHistory.delete(turn);
          }
        }

        this.emit({ kind: 'input_turn', turn: this.turn });

        return;
      case 'transcript': {
        const role = event.role === 'user' ? 'user' : 'assistant';

        if (this.deps.diagnosticMode && role === 'assistant') {
          return;
        }

        const text = String(event.text ?? '');
        const eventTurn = !this.deps.diagnosticMode && typeof event.turn === 'number' ? event.turn : this.turn;

        if (role === 'user') {
          const itemId = typeof event.itemId === 'string' ? event.itemId : `asr-${this.turn}`;
          this.emit({ kind: 'diag', record: { type: 'asr', turn: eventTurn, itemId, outcome: event.current === false ? 'filtered' : 'current', text } });
          this.emit({ kind: 'diag', record: { type: 'forward', turn: eventTurn, itemId, text } });

          if (event.current !== false) this.lastUserItemId = itemId;
        }

        this.emit({ kind: 'text', turn: eventTurn, role, text });

        return;
      }

      case 'audio': {
        if (this.deps.diagnosticMode) {
          return;
        }

        const responseId = String(event.responseId);
        const delivery = this.responses.get(responseId);

        if (delivery && !this.spoken.has(responseId)) {
          this.spoken.add(responseId);
          this.deps.onPlayback?.(delivery, 'speaking');
        }

        this.emit({ kind: 'audio', turn: this.turn, data: String(event.data), responseId, itemId: responseId });

        return;
      }

      case 'delivery_response':
        this.responses.set(String(event.responseId), String(event.deliveryId));

        return;
      case 'response_done':
        if (this.deps.diagnosticMode) {
          this.connection?.handle({ type: 'playback_done', responseId: event.responseId });

          return;
        }

        this.emit({ kind: 'response_end', turn: this.turn, responseId: String(event.responseId) });

        return;
      case 'clear_audio':
        this.emit({ kind: 'reset_output', turn: this.turn });

        return;
      case 'error': {
        const failed: Extract<VoiceEvent, {kind:'state'}> = { kind: 'state', state: 'error', detail: String(event.message), recoverable: event.recoverable === true };

        if (event.sayAgain === true) failed.sayAgain = true;
        this.emit(failed);

        return;
      }

      case 'closed':
        this.closed = true;
        this.ready = false;
        this.emit({ kind: 'state', state: 'closed' });

        return;
      default: return;
    }
  }
  private emit(event: VoiceEvent): void {
    if (!this.mutedEmit) {
      this.deps.emit(event);
    }
  }
  notify(snapshot: TaskProgressSnapshot): void {
    const delivery = snapshot.conversationContext?.latestDelivery;

    if (delivery && delivery.runId === snapshot.runId) {
      this.completeDelivery(delivery);
    }
    else {
      this.connection?.notifyTask(progressSpeech(snapshot));
    }
  }
  streamDelivery(stream: UserDeliveryStream): void {
    // Final, verified delivery is the authority; partial prose never manufactures completion.
    if (stream.phase === 'cancelled') {
      this.cancelled.add(stream.id);
    }
  }
  completeDelivery(delivery: Pick<UserDelivery, 'id' | 'runId' | 'kind' | 'text' | 'facts'> & {
    voiceTurn?: number;
  }): void {
    if (this.closed || this.deps.diagnosticMode || this.notices.has(delivery.id) || this.cancelled.has(delivery.id)) {
      return;
    }

    this.notices.add(delivery.id);
    // Partial/old unverified prose may contain an overconfident completion claim.
    // Speak the host's unresolved state instead; keep the detailed report in the
    // sidepanel. Never drop facts and let another model upgrade that prose.
    const remaining = delivery.facts ? delivery.facts.remaining.length + (delivery.facts.omittedRemaining ?? 0) : 0;
    const owner = this.deps.getDeliverySnapshot?.({ ...delivery, phase: 'streaming' });
    const task = owner && owner.conversationId !== this.deps.getSnapshot()?.conversationId ? `「${owner.goal?.slice(0, 40) ?? '另一项任务'}」` : '这项任务';
    let text: string;

    if (delivery.kind === 'finding' && delivery.facts && delivery.facts.outcome !== 'complete') {
      if (remaining) {
        text = `${task}还有 ${remaining} 项结果没完成或还没确认，具体内容在侧栏。`;
      } else {
        text = `${task}的结果还没确认，具体内容在侧栏。`;
      }
    } else {
      text = delivery.text;
    }

    this.connection?.notifyTask(text, delivery.id, () => {
      const current = this.deps.getDeliverySnapshot?.({ ...delivery, phase: 'streaming' }) ?? this.deps.getSnapshot();

      return !this.closed && !this.cancelled.has(delivery.id) && current?.runId === delivery.runId && !['aborted', 'error'].includes(current.state);
    });
  }
  close(emit = true): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.ready = false;
    this.mutedEmit = !emit;
    this.connection?.close();

    if (emit) {
      this.deps.emit({ kind: 'state', state: 'closed' });
    }
  }
}
