import {VOICE_DIAG_MAX_SECONDS,VOICE_DIAG_SAMPLE_RATE,type VoiceDiagRecord} from '../../../shared/voice.js';

/** Kept per session: at most a few takes with audio, more entries as metadata only. */
export const VOICE_DIAG_MAX_CAPTURES = 20;
export const VOICE_DIAG_AUDIO_KEEP = 3;

export interface VoiceDiagTrack {
  sampleRate: number;
  channelCount: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}
export interface VoiceDiagUpstream {
  seq: number;
  eventId: string;
  turn: number;
  frame: number | null;
  samples: number;
  bytes: number;
  /** Exactly the base64 PCM the socket accepted upstream; this alone is C1's content. */
  audio: string;
  /** Alignment check of those upstream bytes against the local continuous capture. */
  c0Match: 'ok' | 'mismatch' | 'unknown';
}
export interface VoiceDiagCapture {
  id: string;
  voiceId: string;
  conversationId: string;
  turn: number;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  sampleRate: number;
  track: VoiceDiagTrack | null;
  /** Continuous 24k frames, copied before any classifier/worker transfer; bounded by maxSamples. */
  frames: Int16Array[];
  samples: number;
  capped: boolean;
  upstream: VoiceDiagUpstream[];
  commit: { eventId: string; at: number } | null;
  itemId: string | null;
  /** Raw ASR from the session, before the old-turn filter. */
  rawAsr: { text: string; outcome: string; turn: number | null; at: number } | null;
  /** Server record of the user text event it actually forwarded. */
  forwarded: { text: string; itemId: string; at: number } | null;
  /** User text event actually received by this panel. */
  serverText: { text: string; at: number } | null;
  /** Question text read from the panel DOM after it was assigned. */
  displayText: { text: string; at: number; final: boolean } | null;
  notes: Array<{ code: string; detail?: string; at: number }>;
}
export interface VoiceDiagStatus { complete: boolean; reasons: string[] }

export const decodePcm = (base64: string): Int16Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
};
const normalizeDom = (text: string): string => (text.startsWith('你：') ? text.slice(2) : text);
const sameSamples = (a: Int16Array, b: Int16Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Local record of one diagnostic chain: continuous capture (C0), upstream sends (C1) and the three texts. */
export class VoiceDiagnosticLog {
  private voiceId: string | null = null;
  private conversationId = '';
  private diagnostic = false;
  private confirmed = false;
  private maxSeconds = VOICE_DIAG_MAX_SECONDS;
  private sampleRate = VOICE_DIAG_SAMPLE_RATE;
  private open: VoiceDiagCapture | null = null;
  private readonly items: VoiceDiagCapture[] = [];
  private readonly looseNotes: Array<{ code: string; detail?: string; at: number }> = [];
  constructor(private readonly change: () => void = () => {}) {}

  private notify(): void { try { this.change(); } catch { /* the panel must not break diagnostics */ } }
  get recording(): boolean { return this.open !== null; }
  get isDiagnostic(): boolean { return this.diagnostic; }
  get isConfirmed(): boolean { return this.confirmed; }
  get limitSeconds(): number { return this.maxSeconds; }
  get maxSamples(): number { return Math.floor(this.maxSeconds * this.sampleRate); }

  sessionStarted(info: { voiceId: string; conversationId: string; diagnostic: boolean }): void {
    this.voiceId = info.voiceId;
    this.conversationId = info.conversationId;
    this.diagnostic = info.diagnostic;
    this.confirmed = false;
    this.sampleRate = VOICE_DIAG_SAMPLE_RATE;
    this.maxSeconds = VOICE_DIAG_MAX_SECONDS;
    this.notify();
  }
  confirmedBy(record: { sampleRate: number; maxSeconds: number }): void {
    this.confirmed = true;
    this.sampleRate = record.sampleRate;
    this.maxSeconds = record.maxSeconds;
    this.notify();
  }
  note(code: string, detail?: string): void {
    const entry = { code, ...(detail ? { detail } : {}), at: Date.now() };
    if (this.open) this.open.notes.push(entry); else this.looseNotes.push(entry);
    this.notify();
  }
  /** Notes a specific take even after it stopped being the open one. */
  noteCapture(turn: number, code: string, detail?: string): void {
    const capture = this.captureFor(turn) ?? this.items[this.items.length - 1];
    if (!capture) { this.note(code, detail); return; }
    capture.notes.push({ code, ...(detail ? { detail } : {}), at: Date.now() });
    this.notify();
  }
  captureStarted(info: { turn: number; sampleRate: number; track: VoiceDiagTrack | null }): VoiceDiagCapture | null {
    if (!this.voiceId) return null;
    this.captureEnded('superseded');
    const capture: VoiceDiagCapture = {
      id: `${this.voiceId}:${info.turn}`,
      voiceId: this.voiceId,
      conversationId: this.conversationId,
      turn: info.turn,
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      sampleRate: info.sampleRate,
      track: info.track,
      frames: [],
      samples: 0,
      capped: false,
      upstream: [],
      commit: null,
      itemId: null,
      rawAsr: null,
      forwarded: null,
      serverText: null,
      displayText: null,
      notes: [],
    };
    this.items.push(capture);
    this.trim();
    this.open = capture;
    this.notify();
    return capture;
  }
  /** Returns 'full' when this frame hit the duration bound and the take must stop. */
  captureFrame(pcm: Int16Array): 'ok' | 'full' | 'ignored' {
    const capture = this.open;
    if (!capture || !pcm.length) return 'ignored';
    const remaining = this.maxSamples - capture.samples;
    if (remaining <= 0) { capture.capped = true; this.notify(); return 'full'; }
    const take = pcm.length <= remaining ? Int16Array.from(pcm) : Int16Array.from(pcm.subarray(0, remaining));
    capture.frames.push(take);
    capture.samples += take.length;
    if (take.length < pcm.length) capture.capped = true;
    this.notify();
    return capture.samples >= this.maxSamples ? 'full' : 'ok';
  }
  captureEnded(reason: string): void {
    const capture = this.open;
    if (!capture) return;
    capture.endedAt = Date.now();
    capture.endReason = reason;
    this.open = null;
    this.trim();
    this.notify();
  }
  /** The user text event this panel actually received; recorded separately from raw ASR and from the DOM. */
  textEvent(role: 'user' | 'assistant', turn: number, text: string): void {
    if (role !== 'user') return;
    const capture = this.items.find(c => c.turn === turn && c.voiceId === this.voiceId);
    if (!capture) return;
    capture.serverText = { text, at: Date.now() };
    this.notify();
  }
  /** Question text as assigned to the panel DOM. */
  displayText(text: string, final = false): void {
    const capture = this.open ?? [...this.items].reverse().find(c => c.voiceId === this.voiceId);
    if (!capture || (capture.displayText?.final && !final)) return;
    capture.displayText = { text, at: Date.now(), final };
    this.notify();
  }
  apply(record: VoiceDiagRecord): void {
    if (record.type === 'ready') { this.confirmedBy(record); return; }
    const capture = this.captureFor('turn' in record ? record.turn : null);
    if (!capture) { this.looseNotes.push({ code: `orphan_${record.type}`, at: Date.now() }); this.notify(); return; }
    switch (record.type) {
      case 'append': {
        let c0Match: VoiceDiagUpstream['c0Match'] = 'unknown';
        const local = record.frame === null ? undefined : capture.frames[record.frame];
        if (local) c0Match = sameSamples(local, decodePcm(record.audio)) ? 'ok' : 'mismatch';
        capture.upstream.push({ seq: record.seq, eventId: record.eventId, turn: record.turn, frame: record.frame, samples: record.samples, bytes: Math.floor(record.audio.length * 3 / 4), audio: record.audio, c0Match });
        break;
      }
      case 'commit': capture.commit = { eventId: record.eventId, at: Date.now() }; break;
      case 'item': capture.itemId = record.itemId; break;
      case 'asr': capture.rawAsr = { text: record.text, outcome: record.outcome, turn: record.turn, at: Date.now() }; break;
      case 'forward': capture.forwarded = { text: record.text, itemId: record.itemId, at: Date.now() }; break;
      case 'gap': capture.notes.push({ code: record.code, ...(record.detail ? { detail: record.detail } : {}), at: Date.now() }); break;
      default: break;
    }
    this.notify();
  }
  private captureFor(turn: number | null | undefined): VoiceDiagCapture | null {
    if (turn === null || turn === undefined) return this.open;
    return [...this.items].reverse().find(c => c.turn === turn && c.voiceId === this.voiceId) ?? null;
  }
  private trim(): void {
    while (this.items.length > VOICE_DIAG_MAX_CAPTURES) {
      const dropped = this.items.shift();
      dropped?.frames.splice(0, dropped.frames.length);
    }
    const withAudio = this.items.filter(c => c.frames.length);
    for (const stale of withAudio.slice(0, Math.max(0, withAudio.length - VOICE_DIAG_AUDIO_KEEP))) {
      stale.frames.splice(0, stale.frames.length);
      for (const entry of stale.upstream) entry.audio = '';
      stale.notes.push({ code: 'audio_released', detail: '超出本地保留条数，仅保留文字与摘要。', at: Date.now() });
    }
  }
  captures(): VoiceDiagCapture[] { return this.items; }
  latest(): VoiceDiagCapture | null { return this.open ?? this.items[this.items.length - 1] ?? null; }
  status(capture: VoiceDiagCapture): VoiceDiagStatus {
    const reasons: string[] = [];
    if (!capture.endedAt) reasons.push('录音尚未结束');
    if (!capture.samples) reasons.push('未捕获本地音频');
    if (!capture.upstream.length) reasons.push('未收到服务端发送记录');
    else if (capture.upstream.some(u => u.c0Match !== 'ok')) reasons.push('上行音频与本地连续收音不一致');
    if (!capture.commit) reasons.push('未记录上行 commit');
    if (!capture.itemId) reasons.push('上游未返回 item 标识');
    if (!capture.rawAsr) reasons.push('未收到原始转写');
    else if (capture.rawAsr.outcome === 'filtered') reasons.push('本轮转写被旧轮过滤');
    else if (capture.rawAsr.outcome === 'empty') reasons.push('本轮转写为空');
    else if (capture.rawAsr.outcome === 'unknown') reasons.push('转写无法归属到本轮');
    else {
      if (!capture.forwarded) reasons.push('服务端未记录转发事件');
      if (!capture.serverText) reasons.push('未收到真实转发文字事件');
      if (!capture.displayText) reasons.push('未记录侧栏显示文字');
    }
    if (capture.capped) reasons.push('已达时长上限，音频被截断');
    else if (capture.endReason === 'limit') reasons.push('已达时长上限而结束');
    for (const note of capture.notes) if (note.code !== 'closed' && note.code !== 'audio_released') reasons.push(`异常: ${note.code}`);
    return { complete: reasons.length === 0, reasons };
  }
  checks(capture: VoiceDiagCapture): { rawMatchesForward: boolean | null; forwardMatchesServer: boolean | null; displayMatchesServer: boolean | null } {
    const raw = capture.rawAsr?.text.trim() ?? null;
    return {
      rawMatchesForward: raw === null || !capture.forwarded ? null : raw === capture.forwarded.text.trim(),
      forwardMatchesServer: !capture.forwarded || !capture.serverText ? null : capture.forwarded.text.trim() === capture.serverText.text.trim(),
      displayMatchesServer: !capture.displayText || !capture.serverText ? null : normalizeDom(capture.displayText.text).trim() === capture.serverText.text.trim(),
    };
  }
  /** Cheap availability check for the C1 row; never decodes audio. */
  c1Ready(capture: VoiceDiagCapture): boolean {
    return capture.upstream.length > 0 && capture.upstream.every(entry => entry.audio.length > 0);
  }
  /** C1 is exactly the PCM the socket accepted upstream, decoded from those records only. */
  audio(id: string, which: 'c0' | 'c1'): { chunks: Int16Array[]; samples: number; sampleRate: number } | null {
    const capture = this.items.find(c => c.id === id);
    if (!capture) return null;
    if (which === 'c0') return capture.frames.length ? { chunks: [...capture.frames], samples: capture.samples, sampleRate: capture.sampleRate } : null;
    if (!this.c1Ready(capture)) return null;
    const chunks = [...capture.upstream].sort((a, b) => a.seq - b.seq).map(entry => {
      const pcm = decodePcm(entry.audio);
      return pcm.length === entry.samples ? pcm : pcm.subarray(0, entry.samples);
    });
    return { chunks, samples: chunks.reduce((sum, chunk) => sum + chunk.length, 0), sampleRate: capture.sampleRate };
  }
  wav(id: string, which: 'c0' | 'c1'): Blob | null {
    const audio = this.audio(id, which);
    if (!audio || !audio.chunks.length) return null;
    return encodeWav(audio.chunks, audio.sampleRate);
  }
  exportJSON(): string {
    const captures = this.items.map(capture => {
      const c1 = this.audio(capture.id, 'c1');
      return {
        id: capture.id,
        voiceId: capture.voiceId,
        conversationId: capture.conversationId,
        turn: capture.turn,
        startedAt: capture.startedAt,
        endedAt: capture.endedAt,
        endReason: capture.endReason,
        seconds: Number((capture.samples / capture.sampleRate).toFixed(3)),
        sampleRate: capture.sampleRate,
        track: capture.track,
        c0: { frames: capture.frames.length, samples: capture.samples },
        upstream: capture.upstream.map(({ audio, ...rest }) => ({ ...rest, retained: audio.length > 0 })),
        commit: capture.commit,
        itemId: capture.itemId,
        c1: { samples: c1?.samples ?? 0, seconds: Number(((c1?.samples ?? 0) / capture.sampleRate).toFixed(3)), available: !!c1, audio: '仅内存中，未随 JSON 导出' },
        rawAsr: capture.rawAsr,
        forwarded: capture.forwarded,
        serverText: capture.serverText,
        displayText: capture.displayText,
        checks: this.checks(capture),
        notes: capture.notes,
        status: this.status(capture),
      };
    });
    return JSON.stringify({
      kind: 'voice-diagnostic',
      exportedAt: new Date().toISOString(),
      voiceId: this.voiceId,
      conversationId: this.conversationId,
      confirmed: this.confirmed,
      maxSeconds: this.maxSeconds,
      sessionNotes: this.looseNotes,
      captures,
    }, null, 2);
  }
  clear(): void {
    for (const capture of this.items) capture.frames.splice(0, capture.frames.length);
    this.items.splice(0, this.items.length);
    this.looseNotes.splice(0, this.looseNotes.length);
    this.open = null;
    this.notify();
  }
}

/** 16-bit mono PCM WAV container so both takes stay auditionable in the browser. */
export function encodeWav(chunks: Int16Array[], sampleRate: number): Blob {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples * 2, true);
  let at = 44;
  for (const chunk of chunks) for (let i = 0; i < chunk.length; i++, at += 2) view.setInt16(at, chunk[i]!, true);
  return new Blob([buffer], { type: 'audio/wav' });
}
