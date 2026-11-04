import { aboutTask, progressSpeech, taskName } from './voice-receipt.js';
import { createVoiceDelivery } from './voice-delivery.js';
import { spokenDeliveryText, type RealtimeVoiceDependencies } from './realtime-voice-session.js';
import type { VoiceCommand, VoiceInputContext, VoiceRouteResult, VoiceTarget, TaskProgressSnapshot, UserDelivery, UserDeliveryStream } from '../../shared/voice.js';
import { GPT_LIVE_CONTEXT_BYTES, utf8Bytes } from '../../shared/gpt-live.js';
import { VoiceIntentError } from './voice-errors.js';

const INSTRUCTIONS = `你是浏览器助手的实时语音层，自己没有任何工具。
用户要查资料、读网页、操作网页、问任务进度、停止或修改任务，或者任何需要真实信息、推理或动手的事，都委派给客户端。每个请求只委派一次，然后等结果。
用户新的追问、更正和明确的重试算新请求。回执和结果不是用户请求：不要再委派，也不要复述原请求。
委派的事在做的时候，可以自然地接话，但不要说进度，不要说"我这就去查""马上好"这类话。
commentary 通道送来的内容是静默背景，可以参考，但不要念出来。
speakable 通道送来的内容就是要交给用户的答案：照原意说出来，不加任何事实，不加客套、确认或进度说法。不要提通道或委派。
一律用中文回答，简短，一般一两句话。`;

function chatgptAccountId(access: string): string | null {
  try {
    const payload = JSON.parse(atob(access.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const id = payload['https://api.openai.com/auth']?.chatgpt_account_id;

    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

function speechText(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1').replace(/https?:\/\/[^\s)\]）。，；]+/g, '').replace(/<\/?[a-z][^>]*>/gi, '').replace(/\*\*|__|`/g, '').replace(/^[ \t]*#{1,6}\s+/gm, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function liveContextText(raw: string, channel: 'speakable' | 'commentary', hostNote?: string): string {
  const text = speechText(raw);

  if (utf8Bytes(text) <= GPT_LIVE_CONTEXT_BYTES) return text;
  const note = hostNote ? speechText(hostNote) : '';
  const suffix = channel === 'speakable' ? ' 完整内容在侧栏。' : ' 完整结果保留在客户端。';
  const prefix = `${note ? `${note} ` : ''}${channel === 'speakable' ? '先说开头：' : ''}`;
  let excerpt = '';

  for (const ending of text.matchAll(/[。！？!?]+[”」』"]*|\.(?=\s|$)/g)) {
    const next = text.slice(0, ending.index + ending[0].length).trim();

    if (/^(?:\d+|[a-z])\.$/i.test(next.split('\n').at(-1)?.trim() ?? '')) continue;

    if (utf8Bytes(`${prefix}${next}${suffix}`) > GPT_LIVE_CONTEXT_BYTES) break;
    excerpt = next;
  }

  if (excerpt) return `${prefix}${excerpt}${suffix}`;

  if (note) return utf8Bytes(note + suffix) <= GPT_LIVE_CONTEXT_BYTES ? note + suffix : '结果还有需要核对的部分，完整内容在侧栏。';

  return channel === 'speakable' ? '回答较长，完整内容在侧栏。' : '结果较长，完整内容保留在客户端。';
}

function normalizeWords(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

function covers(whole: string, part: string): boolean {
  const needle = normalizeWords(part);

  return !needle || normalizeWords(whole).includes(needle);
}

type Input = { turn: number; snapshot: TaskProgressSnapshot | null; targets?: VoiceTarget[]; input?: VoiceInputContext; error?: string; ready: boolean };

type Delegation = { id: string; text: string; runId?: string | null; queuedIn?: string; queuedRequest?: string; viaSession?: true; done: boolean };

const HOST_GATE_MS = 500;

type DelegationGroup = {
  key: string;
  userTurnId?: string;
  texts: string[];
  usedText: string;
  routing: boolean;
  routed: boolean;
  repaired: boolean;
  runId?: string | null;
  conversationId?: string;
  late: Delegation[];
};

export class GptLiveSession {
  private closed = false;
  private turn = 1;
  private readonly inputs = new Map<number, Input>();
  private readonly delegations = new Map<string, Delegation>();
  private readonly groups = new Map<string, DelegationGroup>();
  private fixSeq = 0;
  private readonly notices = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly dialogue = new Map<string, { role: 'user' | 'assistant'; text: string }>();
  private readonly speaking = new Map<string, string>();
  private readonly gateTimers = new Set<ReturnType<typeof setTimeout>>();
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private readonly delivery = createVoiceDelivery({ now: () => Date.now() });
  constructor(private readonly deps: RealtimeVoiceDependencies) {
  }
  start(access: string): void {
    if (this.closed) return;
    this.deps.emit({ kind: 'state', state: 'connecting', detail: '正在连接 GPT-Live' });
    const accountId = chatgptAccountId(access);

    if (!accountId) {
      this.deps.emit({ kind: 'state', state: 'error', detail: 'ChatGPT 登录信息不完整：请在设置里重新用 ChatGPT 登录。' });
      this.close(false);

      return;
    }

    const persona = this.deps.persona?.trim();
    this.deps.emit({ kind: 'gpt_live_auth', access, accountId, instructions: persona ? `${INSTRUCTIONS}\n说话的语气：${persona}` : INSTRUCTIONS });
  }
  command(command: VoiceCommand): void {
    if (this.closed) return;

    switch (command.kind) {
      case 'stop':
        this.close();

        return;
      case 'gpt_live_connected':
        this.deps.emit({ kind: 'state', state: 'ready', detail: '已连接，可以说了', inputMode: 'server_vad' });

        return;
      case 'delegation':
        void this.delegate(command.delegationId, command.text, command.userTurnId);

        return;
      case 'gpt_live_transcript':
        this.dialogue.set(command.turnId, { role: command.role, text: command.text });

        while (this.dialogue.size > 12) this.dialogue.delete(this.dialogue.keys().next().value!);

        if (command.role === 'user') {
          this.delivery.handle({ type: 'user_spoke' });
          this.repairWithUserWords(command.turnId, command.text);
          this.gate(command.turnId, command.text);
        }

        return;
      case 'playback_done': {
        const delivery = this.speaking.get(command.responseId);

        if (!delivery) return;
        this.speaking.delete(command.responseId);
        this.deps.onPlayback?.(delivery, 'played');

        return;
      }

      case 'commit': {
        const input = this.inputs.get(command.turn);

        if (!input) return;
        input.input = command.input;
        input.ready = !command.contextPending;

        return;
      }

      case 'input_context': {
        const input = this.inputs.get(command.turn);

        if (!input) return;
        input.input = command.input;
        input.error = command.error;
        input.ready = true;

        return;
      }

      default: return;
    }
  }
  private gate(turnId: string, text: string): void {
    const timer = setTimeout(() => {
      this.gateTimers.delete(timer);

      if (this.closed || this.groups.has(turnId) || !text.trim()) return;
      this.deps.diagnostic?.('gpt_live_host_gate', { turnId, chars: text.length });
      void this.delegate(`host-${turnId}`, text, turnId, true);
    }, HOST_GATE_MS);

    this.gateTimers.add(timer);
  }
  private async delegate(id: string, text: string, userTurnId?: string, viaSession = false): Promise<void> {
    if (this.delegations.has(id) || !this.deps.route) return;
    const group = this.groupFor(id, userTurnId);
    const record: Delegation = { id, text, done: false, ...(viaSession ? { viaSession: true as const } : {}) };
    this.delegations.set(id, record);
    group.texts.push(text);

    if (group.routed) { this.resolveJoiner(group, record); return; }

    if (group.routing) { group.late.push(record); return; }
    group.routing = true;
    const origin: Input = { turn: ++this.turn, snapshot: this.deps.getSnapshot(), targets: this.deps.getTargets?.(), ready: false };
    this.inputs.set(origin.turn, origin);
    this.deps.emit({ kind: 'input_turn', turn: origin.turn });
    const requestId = `gptlive-${this.deps.voiceId ?? 'voice'}-${group.key}`;
    const recentTurns = userTurnId ? [...this.dialogue].filter(([turnId]) => turnId !== userTurnId).map(([, turn]) => turn) : [];
    let result: VoiceRouteResult;
    let userWords: string | undefined;
    let delegated = '';
    let requestText = '';

    try {
      await this.waitForInput(origin);
      this.deps.diagnostic?.('gpt_live_route_start', { delegationId: id });
      userWords = userTurnId ? this.dialogue.get(userTurnId)?.text : undefined;
      delegated = group.texts.join('');
      requestText = userWords && !covers(delegated, userWords) ? userWords : delegated;
      group.usedText = requestText;
      const snapshot = origin.snapshot;
      result = await this.deps.route(requestText, snapshot?.startedAt ?? null, () => !this.closed, {
        nativeChat: true, requestId, runId: snapshot?.runId ?? null, controlVersion: snapshot?.controlVersion,
        voiceId: this.deps.voiceId ?? 'gpt-live', turn: origin.turn, input: origin.input, targets: origin.targets, recentTurns,
      });
    } catch (error) {
      const message = error instanceof VoiceIntentError
        ? error.code === 'classifier_timeout' ? '处理请求的服务超时，这句话还没有执行，原任务没有改变。'
          : '处理语音请求的服务暂时失败，这句话还没有执行，原任务没有改变。'
        : `这句没有执行：${error instanceof Error ? error.message : String(error)}`;

      if (record.viaSession) { this.deps.diagnostic?.('gpt_live_host_gate_failed', { delegationId: id, detail: message.slice(0, 120) }); record.done = true; }
      else this.answer(record, 'speakable', message);
      group.routed = true;
      this.resolveLate(group);

      return;
    } finally {
      this.inputs.delete(origin.turn);
    }

    this.deps.diagnostic?.('gpt_live_delegation', {
      delegationId: id, requestId, kind: result.kind,
      source: requestText === userWords ? 'user_words' : 'delegated',
      diverged: !!userWords && normalizeWords(userWords) !== normalizeWords(delegated),
      delegatedChars: delegated.length, userWordsChars: userWords?.length ?? 0,
      delegated: delegated.slice(0, 80), userWords: (userWords ?? '').slice(0, 80),
    });
    group.routed = true;
    const receipt = result.kind === 'action' || result.kind === 'steer' ? result.receipts?.[0] : undefined;

    if ((result.kind === 'action' || result.kind === 'steer') && result.ok && result.status === 'accepted' && receipt?.runId) {
      record.runId = receipt.runId;
      this.delivery.handle({ type: 'bound', delegationId: id, runId: receipt.runId });
      this.watchProgress();
      group.runId = receipt.runId;
      group.conversationId = receipt.conversationId;
      this.deps.diagnostic?.("gpt_live_task_bound", {delegationId:id,runId:record.runId});
      this.answer(record, 'commentary', result.message);
      this.resolveLate(group);
      if (userTurnId) this.repairWithUserWords(userTurnId, this.dialogue.get(userTurnId)?.text ?? '');

      return;
    }

    if (result.kind === 'action' && result.ok && result.status === 'queued' && receipt?.conversationId) {
      record.queuedIn = receipt.conversationId;
      record.queuedRequest = receipt.requestId;
      this.deps.diagnostic?.('gpt_live_task_queued', { delegationId: id, conversationId: receipt.conversationId });
      this.answer(record, 'commentary', '这件事排在正在做的上一件后面，还没开始做，也还没有结果。可以简短告诉用户上一件做完就接着做；不要说已经做了、已经记下或已经保存。');
      this.resolveLate(group);

      return;
    }

    if (record.viaSession) {
      const differs = result.kind === 'action' || result.kind === 'steer' || result.kind === 'clarify' ? result.message : result.kind === 'none' ? result.spokenText : undefined;

      if (differs) this.answer(record, 'commentary', `客户端对用户刚才那句的处理：${differs}。你刚才的回答如果和它不一致，简短更正；一致就不用再说。`);
      record.done = true;
      this.resolveLate(group);

      return;
    }

    if (result.kind === 'action' || result.kind === 'steer') this.answer(record, 'speakable', result.message);
    else if (result.kind === 'clarify') this.answer(record, 'speakable', result.message);
    else if (result.kind === 'none' && result.spokenText) this.answer(record, 'speakable', result.spokenText);
    else if (result.kind === 'none' && result.nativeChat) this.answer(record, 'commentary', '这句是闲聊，客户端没有要做的事。请你直接简短回答用户。');
    else if (result.kind === 'listening') this.answer(record, 'commentary', '用户的话还没说完，等他说完再回答。');
    else if (result.kind === 'silent') this.answer(record, 'commentary', '用户不需要回答，保持安静。');
    else this.answer(record, 'commentary', '客户端没有可交给用户的结果。请你直接简短回答用户，不要编造事实。');

    this.resolveLate(group);
    if (record.runId === undefined) record.done = true;
  }
  private groupFor(id: string, userTurnId?: string): DelegationGroup {
    const key = userTurnId ?? `item:${id}`;
    let group = this.groups.get(key);

    if (!group) {
      group = { key, userTurnId, texts: [], usedText: '', routing: false, routed: false, repaired: false, late: [] };
      this.groups.set(key, group);
    }

    return group;
  }
  private resolveLate(group: DelegationGroup): void {
    for (const record of group.late.splice(0)) this.resolveJoiner(group, record);
  }
  private resolveJoiner(group: DelegationGroup, record: Delegation): void {
    if (!covers(group.usedText, record.text)) void this.steerInto(group, record.text, 'item');

    this.answer(record, 'commentary', '这句已并入同一句请求处理，不用另外回答。');
    record.done = true;
  }
  private repairWithUserWords(turnId: string, userWords: string): void {
    const group = this.groups.get(turnId);

    if (!group?.runId || group.repaired || covers(group.usedText, userWords)) return;
    group.repaired = true;
    void this.steerInto(group, userWords, 'user_words');
  }
  private async steerInto(group: DelegationGroup, text: string, why: string): Promise<void> {
    group.usedText = `${group.usedText} ${text}`;

    if (!this.deps.dispatchTask || !group.runId || !group.conversationId) {
      this.deps.diagnostic?.('gpt_live_delegation_repair', { group: group.key, why, chars: text.length, status: 'unavailable' });

      return;
    }

    try {
      const outcome = await this.deps.dispatchTask({ requestId: `gptlive-${this.deps.voiceId ?? 'voice'}-${group.key}-fix${++this.fixSeq}`, conversationId: group.conversationId, source: 'voice', action: 'steer', expectedRunId: group.runId, text }, () => !this.closed) as { status?: string } | undefined;
      this.deps.diagnostic?.('gpt_live_delegation_repair', { group: group.key, why, chars: text.length, status: outcome?.status ?? 'unknown' });
    } catch (error) {
      this.deps.diagnostic?.('gpt_live_delegation_repair', { group: group.key, why, chars: text.length, status: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    }
  }
  private answer(record: Delegation, channel: 'speakable' | 'commentary', raw: string, hostNote?: string): boolean {
    const text = liveContextText(raw, channel, hostNote);

    if (this.closed || record.done || !text.trim()) return false;

    if (channel === 'speakable') { record.done = true; this.delivery.handle({ type: 'done', delegationId: record.id }); }
    this.deps.diagnostic?.('gpt_live_delegation_context', { delegationId: record.id, channel, chars: text.length, viaSession: !!record.viaSession });
    this.deps.emit(record.viaSession ? { kind: 'live_context', channel, text } : { kind: 'delegation_context', delegationId: record.id, channel, text });

    return true;
  }
  private settle(runId: string | null | undefined): Delegation | undefined {
    const [latest, ...older] = [...this.delegations.values()].reverse().filter(d => !d.done && !!d.runId && d.runId === runId);

    for (const record of older) {
      this.answer(record, 'commentary', '这次委派的结果已随后一次委派送达，不用另外回答。');
      record.done = true;
      this.delivery.handle({ type: 'done', delegationId: record.id });
    }

    return latest;
  }
  endQueued(owner: string, requestId: string, text: string | null): void {
    const record = [...this.delegations.values()].find(d => !d.done && !d.runId && d.queuedIn === owner && d.queuedRequest === requestId);

    if (!record) return;
    this.deps.diagnostic?.('gpt_live_queued_ended', { delegationId: record.id, spoken: !!text });

    if (text) { this.answer(record, 'speakable', text); return; }
    this.answer(record, 'commentary', '这件事已经取消，没有开始做；用户已经知道，不用再提。');
    record.done = true;
  }
  bindQueued(owner: string, runId: string): boolean {
    const record = [...this.delegations.values()].find(d => !d.done && !d.runId && d.queuedIn === owner);

    if (!record) return false;
    record.runId = runId;
    this.delivery.handle({ type: 'bound', delegationId: record.id, runId });
    this.watchProgress();

    return true;
  }
  private async waitForInput(origin: Input): Promise<void> {
    const end = Date.now() + 5000;

    while (!origin.ready && !this.closed && Date.now() < end) {
      await new Promise(r => setTimeout(r, 20));
    }

    if (this.closed || !origin.ready || origin.error) {
      throw new Error(origin.error ?? '页面资料没有及时到达，未执行这句话。');
    }
  }
  notify(snapshot: TaskProgressSnapshot): void {
    const delivery = snapshot.conversationContext?.latestDelivery;
    const name = snapshot.conversationId !== this.deps.getSnapshot()?.conversationId ? taskName(snapshot) : undefined;

    if (delivery && delivery.runId === snapshot.runId) {
      this.completeDelivery(name ? { ...delivery, text: aboutTask(name, delivery.text) } : delivery);

      return;
    }

    const record = ['error', 'aborted', 'idle'].includes(snapshot.state) ? this.settle(snapshot.runId) : undefined;

    if (record) this.answer(record, 'speakable', progressSpeech(snapshot, name));
  }
  streamDelivery(stream: UserDeliveryStream): void {
    if (stream.phase === 'cancelled') this.cancelled.add(stream.id);
  }
  completeDelivery(delivery: Pick<UserDelivery, 'id' | 'runId' | 'kind' | 'text' | 'facts' | 'hostNote'>): void {
    const blocked = this.closed ? 'closed' : delivery.kind === 'ack' ? 'ack' : this.notices.has(delivery.id) ? 'already_sent' : this.cancelled.has(delivery.id) ? 'cancelled' : null;
    if (blocked) { this.deps.diagnostic?.('gpt_live_delivery_skipped',{id:delivery.id,runId:delivery.runId,reason:blocked}); return; }
    const record = this.settle(delivery.runId);

    if (!record) {this.deps.diagnostic?.('gpt_live_delivery_skipped',{id:delivery.id,runId:delivery.runId,reason:'no_waiting_delegation'});return;}
    this.notices.add(delivery.id);

    const owner = this.deps.getDeliverySnapshot?.({ ...delivery, phase: 'streaming' });

    if (!this.answer(record, 'speakable', spokenDeliveryText(delivery, owner, this.deps.getSnapshot()?.conversationId), owner?.goalCheck?.status === 'done' ? undefined : delivery.hostNote)) return;

    if (record.viaSession) return;
    this.speaking.set(record.id, delivery.id);
    this.deps.onPlayback?.(delivery.id, 'speaking');
  }
  private watchProgress(): void {
    this.progressTimer ??= setInterval(() => this.tickProgress(), 2_000);
  }
  private tickProgress(): void {
    const waiting = [...this.delegations.values()].filter((d): d is Delegation & { runId: string } => !d.done && !!d.runId);

    if (!waiting.length || this.closed) { if (this.progressTimer) clearInterval(this.progressTimer); this.progressTimer = null; return; }
    const tick = waiting.map(record => {
      const snapshot = record.queuedIn ? this.deps.snapshotOf?.(record.queuedIn) : this.deps.getSnapshot();
      const running = snapshot?.state === 'running' && record.runId === snapshot.runId;

      return { delegationId: record.id, runId: record.runId, running, step: running ? snapshot.active.at(-1)?.action ?? null : null };
    });

    for (const action of this.delivery.handle({ type: 'tick', waiting: tick })) {
      this.deps.diagnostic?.('gpt_live_progress', { delegationId: action.delegationId, runId: action.runId, step: action.step, quietMs: action.quietMs });
      this.deps.emit({ kind: 'live_context', channel: 'speakable', text: action.text });
    }
  }
  close(emit = true): void {
    if (this.closed) return;
    this.closed = true;

    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;

    for (const timer of this.gateTimers) clearTimeout(timer);
    this.gateTimers.clear();
    this.dialogue.clear();

    if (emit) this.deps.emit({ kind: 'state', state: 'closed' });
  }
}
