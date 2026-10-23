/**
 * 结果从做完到被用户听见的规则。时钟从外面传入、不开计时器：会话把发生的事翻译成事件交进来，
 * 按返回的动作去念，同一套规则可以拿假时钟逐毫秒验。
 */

/**
 * 只靠说话的用户看不到侧栏：委派的事做了这么久还没出声，就念一句正在做哪一步（取任务栏同一个步骤名）。
 * 同一步至少隔 REPEAT 才再提，每次委派最多念 MAX 句；用户刚说完话时不插嘴。
 */
const PROGRESS_AFTER_MS = 10_000;
const PROGRESS_REPEAT_MS = 15_000;
const PROGRESS_MAX = 8;
const PROGRESS_QUIET_AFTER_USER_MS = 4_000;

export type VoiceDeliveryClock = { now(): number };

/** running：这个委派绑定的任务就是快照里正在跑的那个；step 只在 running 时有意义。 */
export type WaitingDelegation = { delegationId: string; runId: string; running: boolean; step: string | null };

export type VoiceDeliveryEvent =
  | { type: 'user_spoke' }
  | { type: 'bound'; delegationId: string; runId: string }
  | { type: 'done'; delegationId: string }
  | { type: 'tick'; waiting: WaitingDelegation[] };

export type VoiceDeliveryAction = { type: 'speak_progress'; delegationId: string; runId: string; step: string | null; quietMs: number; text: string };

type Progress = { boundAt: number; said?: { at: number; step: string | null; count: number } };

export function createVoiceDelivery(clock: VoiceDeliveryClock): { handle(event: VoiceDeliveryEvent): VoiceDeliveryAction[] } {
  const progress = new Map<string, Progress>();
  let lastUserAt: number | null = null;

  function tick(waiting: WaitingDelegation[]): VoiceDeliveryAction[] {
    const now = clock.now();

    if (lastUserAt !== null && now - lastUserAt < PROGRESS_QUIET_AFTER_USER_MS) return [];

    // 同一时刻只念一句：几个委派都在等时，按委派先后轮到第一个该念的。
    for (const item of waiting) {
      const state = progress.get(item.delegationId);

      if (!item.running || !state) continue;
      const said = state.said ?? { at: state.boundAt, step: null, count: 0 };
      const step = item.step;
      const quiet = now - said.at;

      if (said.count >= PROGRESS_MAX || quiet < PROGRESS_AFTER_MS || (step === said.step || !step) && quiet < PROGRESS_REPEAT_MS) continue;
      const text = !step ? '还在做，稍等。' : step === said.step ? `还在${step}，稍等。` : `还在做，正在${step}。`;
      state.said = { at: now, step, count: said.count + 1 };

      return [{ type: 'speak_progress', delegationId: item.delegationId, runId: item.runId, step, quietMs: quiet, text }];
    }

    return [];
  }

  return {
    handle(event) {
      switch (event.type) {
        case 'user_spoke': lastUserAt = clock.now(); return [];
        case 'bound': {
          const state = progress.get(event.delegationId);

          if (state) state.boundAt = clock.now();
          else progress.set(event.delegationId, { boundAt: clock.now() });

          return [];
        }
        case 'done': progress.delete(event.delegationId); return [];
        case 'tick': return tick(event.waiting);
      }
    },
  };
}
