/** 语音即时操作：页面脚本直接做，做完读回结果，不经任务循环。 */
export type VoicePageOp =
  | { kind: 'state' }
  | { kind: 'pause' }
  | { kind: 'play' }
  | { kind: 'seek'; seconds: number }
  | { kind: 'next' }
  | { kind: 'open'; url: string };

export interface VoicePageCard { row: number; col: number; title: string; url: string }

export interface VoicePageState {
  url: string;
  title: string;
  media: { playing: boolean; currentTime: number; duration: number | null } | null;
  hasNext: boolean;
  cards: VoicePageCard[];
}

export interface VoicePageReply { ok: boolean; message?: string; state: VoicePageState }

export function isVoicePageOp(value: unknown): value is VoicePageOp {
  if (!value || typeof value !== 'object') return false;
  const op = value as { kind?: unknown; seconds?: unknown; url?: unknown };

  if (op.kind === 'seek') return typeof op.seconds === 'number' && Number.isFinite(op.seconds) && op.seconds >= 0;

  if (op.kind === 'open') return typeof op.url === 'string' && /^https?:\/\//.test(op.url) && op.url.length <= 2000;

  return op.kind === 'state' || op.kind === 'pause' || op.kind === 'play' || op.kind === 'next';
}

/** 同一个视频的地址：跳转后常多出来源参数，只比路径和视频编号。 */
export function videoKey(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}?${parsed.searchParams.get('v') ?? ''}`;
  } catch {
    return url;
  }
}
