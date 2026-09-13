import type {UserDelivery, UserDeliveryStream} from '../../shared/voice.js';

/**
 * 语音语义轮次的输出闸门。
 *
 * 一轮 = 一次语义轮次（voiceId+turn / 计划编号），不是 runId，也不是工具调用 ID。
 * PREPARING 阶段的输出（含 user_delivery_stream 前缀）先扣在缓冲区里，
 * 只有轮次进入 COMMITTED 之后才对外发；DISCARDED / INTERRUPTED 是终态，
 * 晚到的 token、交付、agent_end、重连事件都不能把它复活。
 *
 * 正式交付（工具真的执行过的事实记录）也扣在缓冲区里，但终态丢弃时按原样放行：
 * 它是别轮的真实事实，不该跟着被丢弃的候选一起消失；被丢弃的是候选自己的前缀。
 */
export const VOICE_TURN_PHASES = ['PREPARING', 'COMMITTED', 'COMPLETED', 'DISCARDED', 'INTERRUPTED'] as const;
export type VoiceTurnPhase = (typeof VOICE_TURN_PHASES)[number];
/** pass = 现在就能发；held = 被扣在缓冲区；dropped = 终态之后，永不复活。 */
export type DeliveryStreamDecision = 'pass' | 'held' | 'dropped';
export interface ReleasedVoiceOutput { streams: UserDeliveryStream[]; deliveries: UserDelivery[] }
const EMPTY_OUTPUT = (): ReleasedVoiceOutput => ({streams: [], deliveries: []});

interface Turn {
  conversationId: string;
  phase: VoiceTurnPhase;
  held: Map<string, UserDeliveryStream>;
  heldDeliveries: Map<string, UserDelivery>;
  /** 被丢弃的交付 ID：晚到的同 ID 前缀不再复活。 */
  dropped: Set<string>;
}

/** 同一个会话同时只应有一个语义轮次在准备；保留少量历史轮次用于识别晚到事件。 */
const MAX_TRACKED_TURNS = 32;

export class VoiceTurnGate {
  private readonly turns = new Map<string, Turn>();
  private readonly order: string[] = [];

  /** 进入 PREPARING：这一步之后，本轮的交付流前缀先扣住不发。 */
  begin(turnId: string, conversationId: string): void {
    this.turns.set(turnId, { conversationId, phase: 'PREPARING', held: new Map(), heldDeliveries: new Map(), dropped: new Set() });
    this.order.push(turnId);
    while (this.order.length > MAX_TRACKED_TURNS) {
      const oldest = this.order.shift()!;
      if (oldest !== turnId) this.turns.delete(oldest);
    }
  }
  phase(turnId: string): VoiceTurnPhase | null { return this.turns.get(turnId)?.phase ?? null; }
  conversationOf(turnId: string): string | null { return this.turns.get(turnId)?.conversationId ?? null; }
  /** 当前正在准备、还没拿到终态的轮次；没有就是没有候选在场。 */
  preparing(conversationId?: string): string[] {
    return this.order.filter(id => this.turns.get(id)?.phase === 'PREPARING'
      && (conversationId === undefined || this.turns.get(id)!.conversationId === conversationId));
  }
  /** 已经提交、还留在场上的轮次（可以按完成收尾）。 */
  committed(conversationId?: string): string[] {
    return this.order.filter(id => this.turns.get(id)?.phase === 'COMMITTED'
      && (conversationId === undefined || this.turns.get(id)!.conversationId === conversationId));
  }

  /**
   * 会话在真正发一条交付流之前问一次：
   * - 有同一会话的轮次在 PREPARING：扣住（按交付 ID 去重，保留最新前缀），返回 held；
   * - 没有候选在场：放行；
   * - 这条流的 ID 已经被某个被丢弃/中断的终态轮次丢过：丢弃，晚到的前缀不复活。
   */
  holdDeliveryStream(stream: UserDeliveryStream, conversationId?: string): DeliveryStreamDecision {
    const abandoned = [...this.turns.values()].some(turn => turn.dropped.has(stream.id));
    if (abandoned) return 'dropped';
    const preparing = this.preparing(conversationId);
    if (!preparing.length) return 'pass';
    for (const turnId of preparing) this.turns.get(turnId)!.held.set(stream.id, stream);
    return 'held';
  }

  /** 正式交付同样先扣住：PREPARING 期间不越过提交就对外发。 */
  holdUserDelivery(delivery: UserDelivery, conversationId?: string): DeliveryStreamDecision {
    const preparing = this.preparing(conversationId);
    if (!preparing.length) return 'pass';
    for (const turnId of preparing) this.turns.get(turnId)!.heldDeliveries.set(delivery.id, delivery);
    return 'held';
  }

  /** 校验通过：立即把扣住的输出按原本顺序放出去；轮次已被新话取代（不再处于 PREPARING）返回 null。 */
  commit(turnId: string): ReleasedVoiceOutput | null {
    const turn = this.turns.get(turnId);
    if (!turn || turn.phase !== 'PREPARING') return null;
    turn.phase = 'COMMITTED';
    return this.take(turn);
  }

  /** 校验不通过 / 超时：候选的前缀全部丢弃（记下 ID，晚到不复活）；被扣住的真实交付仍按原样送达。 */
  discard(turnId: string): ReleasedVoiceOutput { return this.abandon(turnId, 'DISCARDED'); }
  /** 用户说了新话、连接断掉或这一轮已经翻篇：终态是 INTERRUPTED。 */
  interrupt(turnId: string): ReleasedVoiceOutput { return this.abandon(turnId, 'INTERRUPTED'); }
  /** 这一轮正常做完：之后到达的任何输出都不再属于它。 */
  complete(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.phase = 'COMPLETED';
    turn.held.clear();
    turn.heldDeliveries.clear();
  }

  private abandon(turnId: string, phase: VoiceTurnPhase): ReleasedVoiceOutput {
    const turn = this.turns.get(turnId);
    if (!turn) return EMPTY_OUTPUT();
    turn.phase = phase;
    for (const id of turn.held.keys()) turn.dropped.add(id);
    turn.held.clear();
    const deliveries = [...turn.heldDeliveries.values()];
    turn.heldDeliveries.clear();
    return {streams: [], deliveries};
  }
  private take(turn: Turn): ReleasedVoiceOutput {
    const streams = [...turn.held.values()];
    const deliveries = [...turn.heldDeliveries.values()];
    turn.held.clear();
    turn.heldDeliveries.clear();
    return {streams, deliveries};
  }
}
