/**
 * MOSS 的停播由服务端决定，开口后约 0.5 秒才察觉、整句问题甚至等说完才停。
 * 侧栏先按本机麦克风暂停（不丢音频）；服务端判为插话就丢弃，没判则用户说完后接着播（附和、咳嗽）。
 */

/** 回声消除后的麦克风电平，与旧插话判定同一刻度。 */
export const MOSS_PAUSE_RMS = 0.012;
/** 连续约 160 ms 人声才暂停，单个爆音不算开口。 */
const PAUSE_AFTER_MS = 160;
/** 用户安静这么久才算说完这一句。 */
const QUIET_MS = 300;
/** 说完后等服务端判定的时间：认出转写后它约 0.3 秒内发停播。 */
const AFTER_TRANSCRIPT_MS = 600;
/** 服务端连转写都没给（短附和常这样）时，说完后最多等这么久就接着播。 */
const NO_TRANSCRIPT_MS = 1500;

export type BargePauseAction = 'pause' | 'resume' | null;

export class MossBargePause {
  private loudSince: number | null = null;
  private paused: { quietSince: number | null; transcriptAt: number | null } | null = null;

  /** 每个麦克风帧调用一次；playing 为播放器里还有这段回答的音频。 */
  frame(now: number, rms: number, playing: boolean): BargePauseAction {
    const loud = rms > MOSS_PAUSE_RMS;

    if (!this.paused) {
      if (!playing || !loud) {
        this.loudSince = null;
        return null;
      }
      this.loudSince ??= now;
      if (now - this.loudSince < PAUSE_AFTER_MS) return null;
      this.loudSince = null;
      this.paused = { quietSince: null, transcriptAt: null };
      return 'pause';
    }

    if (!playing) {
      this.paused = null;
      return null;
    }
    if (loud) {
      this.paused.quietSince = null;
      return null;
    }
    this.paused.quietSince ??= now;
    const quiet = now - this.paused.quietSince;
    const transcriptAt = this.paused.transcriptAt;
    const settled = transcriptAt !== null ? quiet >= QUIET_MS && now - transcriptAt >= AFTER_TRANSCRIPT_MS : quiet >= NO_TRANSCRIPT_MS;
    if (!settled) return null;
    this.paused = null;
    return 'resume';
  }

  /** 这句话的最终转写到了：服务端已认出这句话，接下来很快会决定是否停播。 */
  transcript(now: number): void {
    if (this.paused) this.paused.transcriptAt = now;
  }

  /** 服务端判为插话、旧回答已丢弃。 */
  stopped(): void {
    this.paused = null;
    this.loudSince = null;
  }
}
