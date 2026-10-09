import { progressSpeech } from './voice-receipt.js';
import { spokenDeliveryText, type RealtimeVoiceDependencies } from './realtime-voice-session.js';
import type { VoiceCommand, VoiceInputContext, VoiceRouteResult, VoiceTarget, TaskProgressSnapshot, UserDelivery, UserDeliveryStream } from '../../shared/voice.js';

/** 照 openclaw 的委派说法改写给中文用户：语音层自己不动手，宿主送回的结果照原意念，不添事实、不报进度。 */
const INSTRUCTIONS = `你是浏览器助手的实时语音层，自己没有任何工具。
用户要查资料、读网页、操作网页、问任务进度、停止或修改任务，或者任何需要真实信息、推理或动手的事，都委派给客户端。每个请求只委派一次，然后等结果。
用户新的追问、更正和明确的重试算新请求。回执和结果不是用户请求：不要再委派，也不要复述原请求。
委派的事在做的时候，可以自然地接话，但不要说进度，不要说"我这就去查""马上好"这类话。
commentary 通道送来的内容是静默背景，可以参考，但不要念出来。
speakable 通道送来的内容就是要交给用户的答案：照原意说出来，不加任何事实，不加客套、确认或进度说法。不要提通道或委派。
一律用中文回答，简短，一般一两句话。`;

/** 从 ChatGPT 登录令牌里取账号编号（与 pi-ai 的 openai-codex 同一个字段）。 */
function chatgptAccountId(access: string): string | null {
  try {
    const payload = JSON.parse(atob(access.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const id = payload['https://api.openai.com/auth']?.chatgpt_account_id;

    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** 送去念的文字要和侧栏渲染出的回答一致：链接只留文字，去掉裸网址和强调记号。 */
function speechText(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1').replace(/https?:\/\/[^\s)\]）。，；]+/g, '').replace(/\*\*|__|`/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

type Input = { turn: number; snapshot: TaskProgressSnapshot | null; targets?: VoiceTarget[]; input?: VoiceInputContext; error?: string; ready: boolean };

/** 一次委派：任务接下后记住 runId，等这个任务交付给用户的结果。 */
type Delegation = { id: string; runId?: string | null; done: boolean };

/**
 * GPT-Live 的宿主一侧：声音在侧栏与 OpenAI 之间直连，这里只接委派、开任务、送回结果。
 * 委派走与套餐语音相同的入口（routeVoiceInput），请求编号按委派编号固定，重复送达只开一个任务。
 */
export class GptLiveSession {
  private closed = false;
  private turn = 1;
  private readonly inputs = new Map<number, Input>();
  private readonly delegations = new Map<string, Delegation>();
  private readonly notices = new Set<string>();
  private readonly cancelled = new Set<string>();
  constructor(private readonly deps: RealtimeVoiceDependencies) {
  }
  /** `access` 是宿主刚取到的 ChatGPT 登录令牌；只经语音事件交给侧栏建通话，不记录。 */
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
        void this.delegate(command.delegationId, command.text);

        return;
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
  /** 每次委派开一轮：先经中转补齐页面资料（与套餐语音同一握手），再交给宿主分流。 */
  private async delegate(id: string, text: string): Promise<void> {
    if (this.delegations.has(id) || !this.deps.route) return;
    const record: Delegation = { id, done: false };
    this.delegations.set(id, record);
    const origin: Input = { turn: ++this.turn, snapshot: this.deps.getSnapshot(), targets: this.deps.getTargets?.(), ready: false };
    this.inputs.set(origin.turn, origin);
    this.deps.emit({ kind: 'input_turn', turn: origin.turn });
    const requestId = `gptlive-${this.deps.voiceId ?? 'voice'}-${id}`;
    let result: VoiceRouteResult;

    try {
      await this.waitForInput(origin);
      const snapshot = origin.snapshot;
      result = await this.deps.route(text, snapshot?.startedAt ?? null, () => !this.closed, {
        nativeChat: true, requestId, runId: snapshot?.runId ?? null, controlVersion: snapshot?.controlVersion,
        voiceId: this.deps.voiceId ?? 'gpt-live', turn: origin.turn, input: origin.input, targets: origin.targets,
      });
    } catch (error) {
      this.answer(record, 'speakable', `这句没有执行：${error instanceof Error ? error.message : String(error)}`);

      return;
    } finally {
      this.inputs.delete(origin.turn);
    }

    this.deps.diagnostic?.('gpt_live_delegation', { delegationId: id, requestId, kind: result.kind });
    const receipt = result.kind === 'action' || result.kind === 'steer' ? result.receipts?.[0] : undefined;

    // 任务已接下：回执只作静默背景，等这个任务交付给用户的结果再播报。
    if ((result.kind === 'action' || result.kind === 'steer') && result.ok && result.status === 'accepted' && receipt?.runId) {
      record.runId = receipt.runId;
      this.answer(record, 'commentary', result.message);

      return;
    }

    if (result.kind === 'action' || result.kind === 'steer') this.answer(record, 'speakable', result.message);
    else if (result.kind === 'clarify') this.answer(record, 'speakable', result.message);
    else if (result.kind === 'none' && result.spokenText) this.answer(record, 'speakable', result.spokenText);
    else if (result.kind === 'none' && result.nativeChat) this.answer(record, 'commentary', '这句是闲聊，客户端没有要做的事。请你直接简短回答用户。');
    else if (result.kind === 'listening') this.answer(record, 'commentary', '用户的话还没说完，等他说完再回答。');
    else if (result.kind === 'silent') this.answer(record, 'commentary', '用户不需要回答，保持安静。');
    else this.answer(record, 'commentary', '客户端没有可交给用户的结果。请你直接简短回答用户，不要编造事实。');

    if (record.runId === undefined) record.done = true;
  }
  private answer(record: Delegation, channel: 'speakable' | 'commentary', raw: string): void {
    const text = channel === 'speakable' ? speechText(raw) : raw;

    if (this.closed || record.done || !text.trim()) return;

    if (channel === 'speakable') record.done = true;
    this.deps.diagnostic?.('gpt_live_delegation_context', { delegationId: record.id, channel, chars: text.length });
    this.deps.emit({ kind: 'delegation_context', delegationId: record.id, channel, text });
  }
  private pending(runId: string | null | undefined): Delegation | undefined {
    return [...this.delegations.values()].reverse().find(d => !d.done && !!d.runId && d.runId === runId);
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

    if (delivery && delivery.runId === snapshot.runId) {
      this.completeDelivery(delivery);

      return;
    }

    // 任务出错、被终止或停下却没有交付：念宿主自己的状态说明，不让 GPT-Live 一直等。
    const record = this.pending(snapshot.runId);

    if (record && ['error', 'aborted', 'idle'].includes(snapshot.state)) this.answer(record, 'speakable', progressSpeech(snapshot));
  }
  streamDelivery(stream: UserDeliveryStream): void {
    if (stream.phase === 'cancelled') this.cancelled.add(stream.id);
  }
  /** 只把 GPT-Live 委派出去的那个任务的交付送回；文字规则与套餐语音相同。 */
  completeDelivery(delivery: Pick<UserDelivery, 'id' | 'runId' | 'kind' | 'text' | 'facts'>): void {
    if (this.closed || delivery.kind === 'ack' || this.notices.has(delivery.id) || this.cancelled.has(delivery.id)) return;
    const record = this.pending(delivery.runId);

    if (!record) return;
    this.notices.add(delivery.id);
    this.answer(record, 'speakable', spokenDeliveryText(delivery, this.deps.getDeliverySnapshot?.({ ...delivery, phase: 'streaming' }), this.deps.getSnapshot()?.conversationId));
    this.deps.onPlayback?.(delivery.id, 'speaking');
  }
  close(emit = true): void {
    if (this.closed) return;
    this.closed = true;

    if (emit) this.deps.emit({ kind: 'state', state: 'closed' });
  }
}
