import { realtimeBrowserError, type ExecuteRealtimeBrowserTool } from './realtime-browser-tools.js';
import { aboutTask, progressSpeech, taskName } from './voice-receipt.js';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { RealtimeVoiceConnection, type RealtimeTaskAction } from './realtime-voice-connection.js';
import { MossLiveConnection } from './moss-live-connection.js';
import { isExplicitTaskAbort } from './voice-confirm.js';
import type { TaskActionRequest } from '../../shared/task-actions.js';
import { deliveryTextWithNote, MOSS_LIVE_MODEL, type RealtimeVoiceModel, type VoiceCommand, type VoiceEvent, type VoiceInputContext, type VoiceRouteContext, type VoiceRouteResult, type VoiceTarget, type TaskProgressSnapshot, type UserDelivery, type UserDeliveryStream } from '../../shared/voice.js';
import { base64Bytes } from '../../shared/bytes.js';
import { withoutFailureReasons } from '../../shared/task-results.js';
import { redactCredentialText } from '../../shared/untrusted.js';
import { projectTaskView } from '../../shared/task-view.js';

import { answerSpeech } from '../../shared/answer-cards.js';
export type RealtimeVoiceDependencies = {
  model?: RealtimeVoiceModel;
  voiceId?: string;
  mossResumeSessionId?: string;
  /** Step timbre id chosen by the user. */
  voice?: string;
  /** 用户所选人设的描述正文；空串表示默认，不附加人设。 */
  persona?: string;
  /** Diagnostic sessions are requested explicitly, lock out routing and never answer on their own. */
  diagnosticMode?: boolean;
  diagnostic?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
  getSnapshot: () => TaskProgressSnapshot | null;
  snapshotOf?: (conversationId: string) => TaskProgressSnapshot | null;
  getDeliverySnapshot?: (stream: UserDeliveryStream) => TaskProgressSnapshot | null;
  getTargets?: () => VoiceTarget[];
  emit: (event: VoiceEvent) => void;
  route?: (text: string, startedAt: number | null, stillCurrent: () => boolean, context: VoiceRouteContext) => Promise<VoiceRouteResult>;
  connect?: (key: string) => WebSocket;
  captureScreen?: () => Promise<Uint8Array | null>;
  synthesizeNotice?: (text: string, signal: AbortSignal, audio: (pcm: Uint8Array) => void) => Promise<void>;
  onPlayback?: (deliveryId: string, status: "speaking" | "played") => void;
  browserTool?: ExecuteRealtimeBrowserTool;
  readPage?: (input: VoiceInputContext) => Promise<unknown>;
  dispatchTask?: (request: TaskActionRequest, stillCurrent: () => boolean) => Promise<unknown>;
  createConnection?: (options: ConstructorParameters<typeof RealtimeVoiceConnection>[0]) => RealtimeVoiceConnection;
};

type Input = {
  turn: number;
  snapshot: TaskProgressSnapshot | null;
  recentTurns?: VoiceRouteContext['recentTurns'];
  taskContextSynchronized?: boolean;
  targets?: ReturnType<NonNullable<RealtimeVoiceDependencies['getTargets']>>;
  input?: VoiceInputContext;
  error?: string;
  ready: boolean;
};

function voiceTaskText(text: string): string {
  return redactCredentialText(text)
    .replace(/\burl=\S+/gi, 'url=[地址已省略]')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[地址已省略]');
}

type VoiceDelivery = Pick<UserDelivery, 'id' | 'runId' | 'kind' | 'text' | 'facts' | 'hostNote'> & { voiceTurn?: number };

export type RecoverableMossDelivery = { delivery: VoiceDelivery; controlVersion: number | null; waitForConsent: boolean };

function verifiedTaskDelivery(snapshot: TaskProgressSnapshot | null | undefined, delivery: VoiceDelivery | null | undefined): boolean {
  return !!snapshot && !!delivery && delivery.kind === 'finding' && delivery.runId === snapshot.runId
    && snapshot.conversationContext?.latestDelivery?.id === delivery.id
    && snapshot.state === 'idle' && snapshot.goalCheck?.status === 'done'
    && !snapshot.unresolvedEffect && !snapshot.untrackedWritePending && projectTaskView(snapshot).outstanding.length === 0
    && (!delivery.facts || delivery.facts.outcome === 'complete' && delivery.facts.remaining.length === 0 && (delivery.facts.omittedRemaining ?? 0) === 0);
}

/**
 * 交付给用户的结果怎么念：还没确认完的结果可能带着过度自信的完成说法，
 * 这时只念宿主自己的未完成状态，详情留在侧栏；不丢事实，也不让另一个模型把这段话说得更满。
 */
export function spokenDeliveryText(delivery: Pick<UserDelivery, 'kind' | 'text' | 'facts' | 'hostNote'>, owner: TaskProgressSnapshot | null | undefined, currentConversationId: string | undefined): string {
  const remaining = delivery.facts ? delivery.facts.remaining.length + (delivery.facts.omittedRemaining ?? 0) : 0;
  const task = owner && owner.conversationId !== currentConversationId ? taskName(owner) : '这项任务';

  if (delivery.kind === 'finding' && delivery.facts && delivery.facts.outcome !== 'complete') {
    return remaining ? `${task}还有 ${remaining} 项结果没完成或还没确认，具体内容在侧栏。` : `${task}的结果还没确认，具体内容在侧栏。`;
  }

  // 宿主补的一句（hostNote）：目标核对还没判做完时才接在正文后面念。
  // 回答里的卡片不念标签：只念卡片外的结论句（shared/answer-cards.ts）。
  return answerSpeech(owner?.goalCheck?.status === 'done' ? delivery.text : deliveryTextWithNote(delivery));
}

/** Adapts native sidepanel protocol to the same continuous Realtime 3 connection used in the trial. */
export class RealtimeVoiceSession {
  private connection: (Pick<RealtimeVoiceConnection, 'start' | 'handle' | 'notifyTask' | 'close'> & {
    setTaskContext?(context: string): void;
    taskContextSynchronized?(): boolean;
    getSessionId?(): string | null;
    pendingTaskNotices?(): Array<{ id: string; waitForConsent: boolean }>;
    restoreTaskNotice?(text: string, id: string, valid: () => boolean, waitForConsent: boolean): void;
  }) | null = null;
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
  private readonly pendingDeliveries = new Map<string, { delivery: VoiceDelivery; controlVersion: number | null }>();
  private readonly mossNoticeDeliveries = new Map<string, { delivery: VoiceDelivery; controlVersion: number | null }>();
  private readonly restoredConsent = new Map<string, boolean>();
  private readonly voiceTurns: Array<{ key: string; role: 'user' | 'assistant'; text: string }> = [];
  private observedRun: string | null = null;
  private readonly observedPages: Array<{ title: string; text: string; partial: boolean }> = [];
  constructor(private readonly deps: RealtimeVoiceDependencies) {
  }
  start(key: string): void {
    if (this.closed || this.connection) {
      return;
    }

    this.emit({ kind: 'state', state: 'connecting', detail: '正在连接语音服务' });

    if (this.deps.model === MOSS_LIVE_MODEL && !this.deps.createConnection) {
      this.connection = new MossLiveConnection({
        key,
        resumeSessionId: this.deps.mossResumeSessionId,
        diagnostic: this.deps.diagnosticMode,
        persona: this.deps.persona,
        voiceId: this.deps.voiceId,
        connect: this.deps.connect,
        captureScreen: this.deps.captureScreen,
        synthesizeNotice: this.deps.synthesizeNotice,
        send: e => this.receive(e),
        log: e => this.deps.diagnostic?.(String(e.type), { detail: JSON.stringify(e) }),
        ...(!this.deps.diagnosticMode ? { routeTranscript: (text: string, current: () => boolean, hasScreen: boolean, awaitingResultConsent: boolean) => this.routePlanTranscript(text, current, hasScreen, awaitingResultConsent) } : {}),
      });
      this.connection.start();

      return;
    }

    const create = this.deps.createConnection ?? (o => new RealtimeVoiceConnection(o));
    this.connection = create({
      key, model: this.deps.model, connect: this.deps.connect, diagnostic: this.deps.diagnosticMode,
      send: e => this.receive(e),
      log: e => this.deps.diagnostic?.(String(e.type), { detail: JSON.stringify(e) }),
      voiceId: this.deps.voiceId,
      voice: this.deps.voice,
      persona: this.deps.persona,
      holdForTranscript: () => !!this.deps.dispatchTask && this.controllable(),
      claimTranscript: text => !!this.deps.dispatchTask && this.controllable() && isExplicitTaskAbort(text),
      runClaimed: text => this.abortCurrent(text),
      ...(this.deps.model === "stepaudio-2.5-realtime" && !this.deps.diagnosticMode ? { routeTranscript: (text: string, current: () => boolean) => this.routePlanTranscript(text, current) } : {}),
      tools: {
        ...(!this.deps.diagnosticMode && this.deps.browserTool ? { browserTool: async (call: Parameters<ExecuteRealtimeBrowserTool>[0], signal: AbortSignal) => {
          const origin = this.input;
          await this.waitForInput(origin);

          if (this.closed || signal.aborted || this.input !== origin || !origin.input) throw realtimeBrowserError('语音页面资料已过期，未执行。', 'not_executed');

          return this.deps.browserTool!({...call,inputId:`${this.deps.voiceId}:${call.inputId}`},origin.input,signal);
        }} : {}),
        ...(!this.deps.diagnosticMode && this.deps.dispatchTask ? { task_action: (text: string, action: RealtimeTaskAction, sequences?: number[]) => this.dispatchTask(text, action, sequences) } : {}),
        browser_request: async (text, sequences) => {
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
          const routeStart = Date.now();
          const result = await this.deps.route(text, snapshot?.startedAt ?? null, () => !this.closed, {
            requestId: randomUUID(), runId: snapshot?.runId ?? null, controlVersion: snapshot?.controlVersion,
            voiceId: this.deps.voiceId ?? 'realtime3', turn: origin.turn, input: origin.input, targets: this.deps.getTargets?.(),
          });
          this.deps.diagnostic?.('voice_route', { turn: origin.turn, path: 'browser_request', routeMs: Date.now() - routeStart, kind: result.kind });

          return result;
        },
        read_page: async () => {
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
          const snapshot = this.deps.getSnapshot();

          return { snapshot: snapshot?.results ? { ...snapshot, results: withoutFailureReasons(snapshot.results) } : snapshot, targets: this.deps.getTargets?.() ?? [] };
        },
      }
    });
    this.connection.start();
  }
  mossSessionId(): string | null {
    return this.deps.model === MOSS_LIVE_MODEL ? this.connection?.getSessionId?.() ?? null : null;
  }

  recoverableMossDeliveries(): RecoverableMossDelivery[] {
    if (this.deps.model !== MOSS_LIVE_MODEL) return [];
    const states = new Map(this.connection?.pendingTaskNotices?.().map(item => [item.id, item.waitForConsent]) ?? []);
    return [...this.mossNoticeDeliveries.values()].flatMap(item => {
      const snapshot = this.deps.getDeliverySnapshot?.({ ...item.delivery, phase: 'streaming' }) ?? this.deps.getSnapshot();
      const current = snapshot?.conversationContext?.latestDelivery;
      if (!snapshot || snapshot.runId !== item.delivery.runId || (snapshot.controlVersion ?? null) !== item.controlVersion
        || current?.id !== item.delivery.id || current.status === 'played' || this.cancelled.has(item.delivery.id)
        || ['aborted', 'error', 'paused', 'interrupted'].includes(snapshot.state)) return [];
      // Never handed to the connection means the user has not been asked or heard any of it yet.
      const handed = this.notices.has(item.delivery.id);
      return [{ ...item, waitForConsent: current.status === 'speaking' || (states.get(item.delivery.id) ?? handed) }];
    });
  }

  restoreMossDeliveries(items: RecoverableMossDelivery[]): void {
    if (this.deps.model !== MOSS_LIVE_MODEL || this.closed) return;
    for (const item of items) {
      const snapshot = this.deps.getDeliverySnapshot?.({ ...item.delivery, phase: 'streaming' }) ?? this.deps.getSnapshot();
      if (!snapshot || snapshot.runId !== item.delivery.runId || (snapshot.controlVersion ?? null) !== item.controlVersion
        || snapshot.conversationContext?.latestDelivery?.id !== item.delivery.id
        || snapshot.conversationContext.latestDelivery.status === 'played') continue;
      this.restoredConsent.set(item.delivery.id, item.waitForConsent);
      this.completeDelivery(item.delivery);
    }
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
  /** 2.5 不调用任务工具；宿主对每条真实转写分类并派发，只有明确闲聊才返回原生语音。 */
  private async routePlanTranscript(text: string, connectionCurrent: () => boolean, nativeObserve = false, awaitingResultConsent = false): Promise<{ native: boolean; spokenText?: string; acceptTaskConsent?: boolean }> {
    const origin = this.input;
    const current = () => !this.closed && this.input === origin && connectionCurrent();
    const waitStart = Date.now();
    await this.waitForInput(origin);
    if (!current() || !this.deps.route) throw new Error('语音任务分流不可用，未执行。');
    const snapshot = origin.snapshot;
    const routeStart = Date.now();
    const result = await this.deps.route(text, snapshot?.startedAt ?? null, current, {
      nativeChat: true, ...(nativeObserve ? { nativeObserve: true } : {}), requestId: randomUUID(), runId: snapshot?.runId ?? null,
      ...(awaitingResultConsent ? { awaitingResultConsent: true } : {}),
      ...(this.deps.model === MOSS_LIVE_MODEL ? { nativeTaskStatus: origin.taskContextSynchronized ? 'ready' as const : 'unavailable' as const } : {}),
      ...(origin.recentTurns?.length ? { recentTurns: origin.recentTurns } : {}),
      controlVersion: snapshot?.controlVersion, voiceId: this.deps.voiceId ?? 'realtime-plan',
      turn: origin.turn, input: origin.input, targets: origin.targets,
    });
    this.deps.diagnostic?.('voice_route', { turn: origin.turn, path: 'plan', waitMs: routeStart - waitStart, routeMs: Date.now() - routeStart, kind: result.kind });
    if (!current()) throw new Error('这句话已过期，未执行。');
    if (result.kind === 'none' && result.nativeChat) return { native: true, acceptTaskConsent: true };
    if (this.deps.model === MOSS_LIVE_MODEL) {
      if ((result.kind === 'action' || result.kind === 'steer') && result.ok && result.receipts?.length === 1
        && ['start', 'steer'].includes(result.receipts[0]!.action)
        && ['accepted', 'applied'].includes(result.receipts[0]!.status)) return { native: true };
      const detail = result.kind === 'clarify' ? result.message
        : result.kind === 'action' || result.kind === 'steer' ? (!result.ok ? result.message : undefined)
          : result.kind === 'silent' ? result.statusMessage : undefined;
      if (detail) this.emit({ kind: 'state', state: 'ready', detail });
      return { native: false };
    }
    if (result.kind === 'none') return { native: false, spokenText: result.spokenText };
    if (result.kind === 'silent' && result.statusMessage) this.emit({ kind: 'state', state: 'ready', detail: result.statusMessage });
    if (result.kind === 'clarify') return { native: false, spokenText: result.message };
    if (result.kind === 'action' || result.kind === 'steer') return { native: false, ...(!result.awaitDelivery ? { spokenText: result.message } : {}) };
    return { native: false };
  }
  private async dispatchTask(text: string, action: RealtimeTaskAction, sequences?: number[]): Promise<unknown> {
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

    return this.deps.dispatchTask((action.action === 'start' || action.action === 'steer') ? {
      requestId: randomUUID(), conversationId: target.id, originConversationId: origin.snapshot.conversationId, source: 'voice', action: action.action,
      expectedRunId: target.runId ?? null, expectedControlVersion: target.controlVersion, text, context: origin.input?.context, attachments: origin.input?.attachments
    } : {
      requestId: randomUUID(), conversationId: target.id, originConversationId: origin.snapshot.conversationId, source: 'voice', action: action.action,
      expectedRunId: target.runId ?? null, expectedControlVersion: target.controlVersion, text
    }, current);
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
      case 'barge_in':
        if (!this.deps.diagnosticMode) this.connection?.handle({ type: 'barge_in' });

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
            this.mossNoticeDeliveries.delete(delivery);
            this.restoredConsent.delete(delivery);
          }
          else {
            this.deps.diagnostic?.('delivery_without_audio', { deliveryId: delivery, responseId: command.responseId });
          }

          this.responses.delete(command.responseId);
        }

        this.connection?.handle({ type: 'playback_done', responseId: command.responseId });

        return;
      }
      case 'moss_chunk_played':
      case 'moss_playback_stopped':
        if (this.deps.model === MOSS_LIVE_MODEL) this.connection?.handle({ ...command, type: command.kind });
        return;

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
        const snapshot = this.deps.getSnapshot();
        if (snapshot) this.syncTaskContext(snapshot);
        const ready: Extract<VoiceEvent, {kind:'state'}> = { kind: 'state', state: 'ready', detail: '已连接，可以说了' };

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
        const currentSnapshot = this.deps.getSnapshot();
        const previousRun = this.observedRun;
        if (currentSnapshot) this.syncTaskContext(currentSnapshot);
        const taskContextSynchronized = event.taskContextSynchronized === true
          && previousRun === (currentSnapshot?.runId ?? null) && this.connection?.taskContextSynchronized?.() === true;
        const recentTurns = this.deps.model === MOSS_LIVE_MODEL ? this.voiceTurns.map(({ role, text }) => ({ role, text })) : undefined;
        this.input = { turn: this.turn, snapshot: currentSnapshot, taskContextSynchronized, targets: this.deps.getTargets?.(), recentTurns, ready: false };
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

        if (this.deps.model === MOSS_LIVE_MODEL && text.trim() && (role === 'assistant' || event.final !== false)) {
          const key = `${role}:${String(role === 'assistant' ? event.responseId ?? eventTurn : event.itemId ?? eventTurn)}`;
          const prior = this.voiceTurns.find(turn => turn.key === key);
          if (prior) prior.text = text.slice(-2000);
          else this.voiceTurns.push({ key, role, text: text.slice(-2000) });
          if (this.voiceTurns.length > 12) this.voiceTurns.shift();
        }

        if (role === 'user' && event.final !== false) {
          const itemId = typeof event.itemId === 'string' ? event.itemId : `asr-${this.turn}`;
          this.emit({ kind: 'diag', record: { type: 'asr', turn: eventTurn, itemId, outcome: event.current === false ? 'filtered' : 'current', text } });
          this.emit({ kind: 'diag', record: { type: 'forward', turn: eventTurn, itemId, text } });
        }

        this.emit({ kind: 'text', turn: eventTurn, role, text, ...(event.final === false && role === 'user' ? { partial: true } : {}) });

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

        const audio: Extract<VoiceEvent, { kind: 'audio' }> = { kind: 'audio', turn: this.turn, data: String(event.data), responseId, itemId: responseId };
        if (event.sampleRate === 48000) audio.sampleRate = 48000;
        if (event.moss && typeof event.moss === 'object') audio.moss = event.moss as NonNullable<typeof audio.moss>;
        this.emit(audio);

        return;
      }

      // 连接层的计时（如 first_audio_since_vad_stop）：按当前话轮记进诊断，分段计时靠它和侧栏的时间点对齐。
      case 'metric':
        if (typeof event.name === 'string' && typeof event.value === 'number') this.deps.diagnostic?.('voice_metric', { turn: this.turn, name: event.name, ms: event.value });

        return;
      case 'delivery_response':
        this.responses.set(String(event.responseId), String(event.deliveryId));

        return;
      case 'delivery_failed':
        const failedDelivery = this.responses.get(String(event.responseId));
        if (failedDelivery) {
          this.mossNoticeDeliveries.delete(failedDelivery);
          this.restoredConsent.delete(failedDelivery);
        }
        this.responses.delete(String(event.responseId));
        this.spoken.delete(String(event.responseId));

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
      case 'moss_stop_audio':
        this.emit({ kind: 'moss_stop_audio', turn: this.turn, runId: String(event.runId), turnId: String(event.turnId) });
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
  recordTaskObservation(snapshot: TaskProgressSnapshot, read: { title: string; text: string; partial: boolean }): void {
    if (this.deps.model !== MOSS_LIVE_MODEL || this.deps.diagnosticMode || !snapshot.runId || snapshot.state !== 'running') return;
    if (this.observedRun !== snapshot.runId) {
      this.observedRun = snapshot.runId;
      this.observedPages.length = 0;
    }
    const page = { title: voiceTaskText(read.title).slice(0, 160), text: voiceTaskText(read.text).slice(0, 2400), partial: read.partial || read.text.length > 2400 };
    if (!page.text.trim() || this.observedPages.some(item => item.title === page.title && item.text === page.text)) return;
    this.observedPages.push(page);
    if (this.observedPages.length > 5) this.observedPages.shift();
    this.syncTaskContext(snapshot);
  }
  syncTaskContext(snapshot: TaskProgressSnapshot): void {
    if (this.deps.model !== MOSS_LIVE_MODEL || this.deps.diagnosticMode || this.closed) return;
    const runId = snapshot.runId ?? null;
    if (this.observedRun !== runId) {
      this.observedRun = runId;
      this.observedPages.length = 0;
    }
    if (!runId && !snapshot.goal) {
      this.connection?.setTaskContext?.('');
      return;
    }
    const delivery = snapshot.conversationContext?.latestDelivery;
    const verifiedResult = delivery && verifiedTaskDelivery(snapshot, delivery)
      ? voiceTaskText(spokenDeliveryText(delivery, snapshot, snapshot.conversationId)).slice(0, 4000) : null;
    this.connection?.setTaskContext?.(JSON.stringify({
      state: snapshot.state, goal: voiceTaskText(snapshot.goal ?? '').slice(0, 1000),
      active: snapshot.active.map(item => voiceTaskText(item.action).slice(0, 300)),
      lastAction: snapshot.lastAction ? { action: voiceTaskText(snapshot.lastAction.action).slice(0, 300), failed: snapshot.lastAction.failed } : null,
      verification: snapshot.goalCheck?.status ?? null, verifiedResult, observedPages: this.observedPages,
    }));
  }
  notify(snapshot: TaskProgressSnapshot): void {
    const delivery = snapshot.conversationContext?.latestDelivery;
    const name = snapshot.conversationId !== this.deps.getSnapshot()?.conversationId ? taskName(snapshot) : undefined;

    if (delivery && delivery.runId === snapshot.runId) {
      this.completeDelivery(name ? { ...delivery, text: aboutTask(name, delivery.text) } : delivery);
    }
    else if (this.deps.model !== MOSS_LIVE_MODEL) {
      this.connection?.notifyTask(progressSpeech(snapshot, name));
    }
  }
  streamDelivery(stream: UserDeliveryStream): void {
    // Final, verified delivery is the authority; partial prose never manufactures completion.
    if (stream.phase === 'cancelled') {
      this.cancelled.add(stream.id);
      this.pendingDeliveries.delete(stream.id);
      this.mossNoticeDeliveries.delete(stream.id);
      this.restoredConsent.delete(stream.id);
    }
  }
  checkPendingDeliveries(): void {
    for (const [id, pending] of this.pendingDeliveries) {
      const snapshot = this.deps.getDeliverySnapshot?.({ ...pending.delivery, phase: 'streaming' }) ?? this.deps.getSnapshot();
      if (!snapshot || snapshot.runId !== pending.delivery.runId || (snapshot.controlVersion ?? null) !== pending.controlVersion
        || ['aborted', 'error', 'paused', 'interrupted'].includes(snapshot.state)) {
        this.pendingDeliveries.delete(id);
        this.mossNoticeDeliveries.delete(id);
        this.restoredConsent.delete(id);
      } else if (verifiedTaskDelivery(snapshot, pending.delivery)) {
        this.pendingDeliveries.delete(id);
        this.completeDelivery(pending.delivery);
      }
    }
  }
  completeDelivery(delivery: VoiceDelivery): void {
    if (this.deps.diagnosticMode || this.notices.has(delivery.id) || this.cancelled.has(delivery.id)) {
      return;
    }

    if (this.closed) {
      // A result finishing between a dropped socket and the retry is kept for the resumed call.
      if (this.deps.model === MOSS_LIVE_MODEL && delivery.kind === 'finding') {
        const snapshot = this.deps.getDeliverySnapshot?.({ ...delivery, phase: 'streaming' }) ?? this.deps.getSnapshot();
        if (snapshot?.runId === delivery.runId) this.mossNoticeDeliveries.set(delivery.id, { delivery, controlVersion: snapshot.controlVersion ?? null });
      }
      return;
    }

    if (this.deps.model === MOSS_LIVE_MODEL && delivery.kind !== 'finding') return;
    const snapshot = this.deps.getDeliverySnapshot?.({ ...delivery, phase: 'streaming' }) ?? this.deps.getSnapshot();
    if (this.deps.model === MOSS_LIVE_MODEL && delivery.kind === 'finding' && !verifiedTaskDelivery(snapshot, delivery)) {
      if (snapshot && snapshot.runId === delivery.runId) {
        const item = { delivery, controlVersion: snapshot.controlVersion ?? null };
        this.pendingDeliveries.set(delivery.id, item);
        this.mossNoticeDeliveries.set(delivery.id, item);
      }
      return;
    }
    if (this.deps.model === MOSS_LIVE_MODEL && snapshot?.results?.length && !snapshot.foldedResults?.count
      && snapshot.results.every(item => item.status === 'satisfied' && item.evidence && ['mark', 'clear_marks'].includes(item.tool))) return;
    this.notices.add(delivery.id);
    const text = spokenDeliveryText(delivery, snapshot, this.deps.getSnapshot()?.conversationId);
    if (this.deps.model === MOSS_LIVE_MODEL) this.mossNoticeDeliveries.set(delivery.id, { delivery, controlVersion: snapshot?.controlVersion ?? null });
    const valid = () => {
      const current = this.deps.getDeliverySnapshot?.({ ...delivery, phase: 'streaming' }) ?? this.deps.getSnapshot();

      return !this.closed && !this.cancelled.has(delivery.id) && current?.runId === delivery.runId && !['aborted', 'error'].includes(current.state)
        && (this.deps.model !== MOSS_LIVE_MODEL || delivery.kind !== 'finding'
          || verifiedTaskDelivery(current, delivery) && (current.controlVersion ?? null) === (snapshot?.controlVersion ?? null));
    };
    const waitForConsent = this.restoredConsent.get(delivery.id);
    this.restoredConsent.delete(delivery.id);
    if (waitForConsent !== undefined && this.connection?.restoreTaskNotice) {
      this.connection.restoreTaskNotice(text, delivery.id, valid, waitForConsent);
    } else {
      this.connection?.notifyTask(text, delivery.id, valid);
    }
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
