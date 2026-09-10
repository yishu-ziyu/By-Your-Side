import WebSocket from 'ws';

export interface SpeechOutput {
  push(text: string): void;
  finish(): void;
  cancel(): void;
}
export interface SpeechCallbacks {
  audio(data: string): void;
  end(): void;
  error(): void;
}

/** One official utterance; audio is forwarded immediately, never buffered as a whole answer. */
export class StepTtsStream implements SpeechOutput {
  private socket: WebSocket;
  private sessionId = '';
  private ready = false;
  private stopped = false;
  private ending = false;
  private queued: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(key: string, private readonly voice: string, private readonly callbacks: SpeechCallbacks,
    connect = (key: string) => new WebSocket('wss://api.stepfun.com/step_plan/v1/realtime/audio?model=stepaudio-2.5-tts', {
      headers: {Authorization: `Bearer ${key}`}, handshakeTimeout: 12000,
    })) {
    this.socket = connect(key);
    this.arm();
    this.socket.on('message', raw => {
      if (this.stopped) return;
      try {
        const event = JSON.parse(raw.toString()), data = event.data ?? {};
        this.arm();
        if (event.type === 'tts.connection.done') {
          this.sessionId = data.session_id;
          this.send('tts.create', {voice_id: this.voice, response_format: 'pcm', sample_rate: 24000, mode: 'default'});
        } else if (event.type === 'tts.response.created') {
          this.ready = true; this.flush();
        } else if (event.type === 'tts.response.audio.delta') {
          const bytes = Buffer.from(data.audio ?? '', 'base64');
          if (bytes.length % 2) { this.fail(); return; }
          for (let i = 0; i < bytes.length && !this.stopped; i += 24000) this.callbacks.audio(bytes.subarray(i, i + 24000).toString('base64'));
        } else if (event.type === 'tts.response.audio.done') {
          this.cancel(); this.callbacks.end();
        } else if (event.type === 'tts.response.error') this.fail();
      } catch { this.fail(); }
    });
    this.socket.on('error', () => this.fail());
    this.socket.on('close', () => { if (!this.stopped) this.fail(); });
  }
  push(text: string): void {
    if (this.stopped || this.ending || !text) return;
    // Speech-only rendering: do not read link addresses, fenced code or Markdown markers.
    this.queued.push(text); this.arm(); this.flush();
  }
  finish(): void { if (!this.stopped) { this.ending = true; this.flush(); } }
  cancel(): void {
    if (this.stopped) return;
    this.stopped = true; this.queued = [];
    if (this.timer) clearTimeout(this.timer);
    this.socket.close();
  }
  private flush(): void {
    if (!this.ready || this.stopped) return;
    for (const text of this.queued.splice(0)) {
      for (const part of text.match(/.{1,500}/gsu) ?? []) this.send('tts.text.delta', {text: part});
      if (/[。！？!?\n]$/.test(text)) this.send('tts.text.flush');
    }
    if (this.ending) this.send('tts.text.done');
  }
  private send(type: string, data: Record<string, unknown> = {}): void {
    if (!this.stopped) this.socket.send(JSON.stringify({type, data: {session_id: this.sessionId, ...data}}));
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(), 20000); this.timer.unref?.();
  }
  private fail(): void { if (!this.stopped) { this.cancel(); this.callbacks.error(); } }
}

/** Keep incomplete links/code out of the spoken prefix; release short sentences in order. */
export class SpeechTextBuffer {
  private text = '';
  private sent = 0;
  append(text: string, done = false): string {
    this.text += text;
    let end = done ? this.text.length : this.sent;
    if (!done) {
      const matches = [...this.text.slice(this.sent).matchAll(/[。！？!?\n]/g)];
      if (matches.length) end = this.sent + matches.at(-1)!.index! + 1;
      // Do not flush inside an unfinished code fence or Markdown link.
      const candidate = this.text.slice(0, end);
      if ((candidate.match(/```/g)?.length ?? 0) % 2 || /\[[^\]]*$|\]\([^)]*$/.test(candidate)) end = this.sent;
    }
    const part = this.text.slice(this.sent, end); this.sent = end;
    return part.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/[^\s，。！？、]+/g, '').replace(/[*#`]/g, '').replace(/^\s*[-+]\s+/gm, '').trim();
  }
}
