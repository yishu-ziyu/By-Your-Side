import type {UserDelivery, UserDeliveryStream} from '../../shared/voice.js';

const VOICE_TURN_PHASES = ['PREPARING', 'COMMITTED', 'COMPLETED', 'DISCARDED', 'INTERRUPTED'] as const;

type VoiceTurnPhase = (typeof VOICE_TURN_PHASES)[number];

export type DeliveryStreamDecision = 'pass' | 'held' | 'dropped';

interface ReleasedVoiceOutput { streams: UserDeliveryStream[]; deliveries: UserDelivery[] }

const EMPTY_OUTPUT = (): ReleasedVoiceOutput => ({streams: [], deliveries: []});

interface Turn {
  conversationId: string;
  phase: VoiceTurnPhase;
  held: Map<string, UserDeliveryStream>;
  heldDeliveries: Map<string, UserDelivery>;
  dropped: Set<string>;
}

const MAX_TRACKED_TURNS = 32;

export class VoiceTurnGate {
  private readonly turns = new Map<string, Turn>();
  private readonly order: string[] = [];

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
  preparing(conversationId?: string): string[] {
    return this.order.filter(id => this.turns.get(id)?.phase === 'PREPARING'
      && (conversationId === undefined || this.turns.get(id)!.conversationId === conversationId));
  }
  committed(conversationId?: string): string[] {
    return this.order.filter(id => this.turns.get(id)?.phase === 'COMMITTED'
      && (conversationId === undefined || this.turns.get(id)!.conversationId === conversationId));
  }

  holdDeliveryStream(stream: UserDeliveryStream, conversationId?: string): DeliveryStreamDecision {
    const abandoned = [...this.turns.values()].some(turn => turn.dropped.has(stream.id));

    if (abandoned) return 'dropped';
    const preparing = this.preparing(conversationId);

    if (!preparing.length) return 'pass';

    for (const turnId of preparing) this.turns.get(turnId)!.held.set(stream.id, stream);

    return 'held';
  }

  holdUserDelivery(delivery: UserDelivery, conversationId?: string): DeliveryStreamDecision {
    const preparing = this.preparing(conversationId);

    if (!preparing.length) return 'pass';

    for (const turnId of preparing) this.turns.get(turnId)!.heldDeliveries.set(delivery.id, delivery);

    return 'held';
  }

  commit(turnId: string): ReleasedVoiceOutput | null {
    const turn = this.turns.get(turnId);

    if (!turn || turn.phase !== 'PREPARING') return null;
    turn.phase = 'COMMITTED';

    return this.take(turn);
  }

  discard(turnId: string): ReleasedVoiceOutput { return this.abandon(turnId, 'DISCARDED'); }
  interrupt(turnId: string): ReleasedVoiceOutput { return this.abandon(turnId, 'INTERRUPTED'); }
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
