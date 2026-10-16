import { parseClientMessage, type ClientMessage, type ServerMessage } from "../../../shared/protocol.js";
import { VoiceObservation } from './voice-observation.js';
import { GPT_LIVE_MODEL, type VoiceInputContext } from '../../../shared/voice.js';

/** 侧栏换端口后要在这段时间内用同一个 voiceId 认领；比侧栏自己的等待（30 秒）长，由侧栏先决定重连。 */
const REATTACH_GRACE_MS = 35_000;
const DETACHED_BUFFER_MAX = 500;

/** Audio bypasses persisted task history and is delivered only to its owning panel. */
export class VoiceRelay {
  private readonly observation = new VoiceObservation();
  private detachTimer: ReturnType<typeof setTimeout> | null = null;
  private lease: {
    /** null：侧栏端口断了，等它带同一个 voiceId 回来；期间的宿主消息存进 buffer。 */
    port: chrome.runtime.Port | null;
    buffer: Extract<ServerMessage, { type: "voice" }>[];
    /** 只有 GPT-Live 的通话不走端口，能撑过换端口；阶跃星辰的音频走端口，断了就停。 */
    live: boolean;
    voiceId: string;
    conversationId: string;
    turn: number;
    diagnostic: boolean;
    serverVad?: boolean;
  } | null = null;
  constructor(private readonly send: (message: ClientMessage) => boolean, private readonly selected: (port: chrome.runtime.Port) => string, private readonly enrich?: (conversationId: string, input: VoiceInputContext) => Promise<VoiceInputContext>) {
  }
  attach(port: chrome.runtime.Port): void {
    port.onDisconnect.addListener(() => {
      const lease = this.lease;

      if (lease?.port !== port) return;

      if (!lease.live) {
        this.stop("panel_disconnected");

        return;
      }
      // 后台忙时侧栏会换端口，但 GPT-Live 通话不走端口，还活着：先留着会话等它认领，不当场停掉。
      lease.port = null;
      console.info("[voice] relay_detached", JSON.stringify({ voiceId: lease.voiceId }));
      this.detachTimer = setTimeout(() => { if (this.lease === lease && !lease.port) this.stop("panel_disconnected"); }, REATTACH_GRACE_MS);
    });
    port.onMessage.addListener((raw: any) => {
      if (raw?.kind !== "client" || raw.msg?.type !== "voice") {
        return;
      }

      let message: ClientMessage | null;

      try {
        message = parseClientMessage(JSON.stringify(raw.msg));
      }
      catch {
        return;
      }

      if (!message || message.type !== "voice" || !message.conversationId) {
        return;
      }

      // Context completion is produced by this relay, never by a panel.
      if (message.command.kind === 'input_context') {
        return;
      }

      // voiceId 只有开这次语音的侧栏知道：同一个 id 从新端口来，就是它换了端口回来认领。
      // 换端口前排队的命令可能先于认领的 start 到达，所以任何一条命令都能认领。
      const held = this.lease;

      if (held && held.port !== port && held.voiceId === message.voiceId && held.conversationId === message.conversationId && message.conversationId === this.selected(port)) {
        this.rebind(held, port);
      }

      if (message.command.kind === "start") {
        if (message.conversationId !== this.selected(port)) {
          return;
        }

        if (this.lease?.port === port && this.lease.voiceId === message.voiceId) {
          return;
        }

        this.stop("new_voice");
        this.observation.clear();
        this.lease = { port, buffer: [], live: message.command.model === GPT_LIVE_MODEL && message.command.diagnostic !== true, voiceId: message.voiceId, conversationId: message.conversationId, turn: 0, diagnostic: message.command.diagnostic === true };
      }

      const lease = this.lease;

      if (!lease || lease.port !== port || lease.voiceId !== message.voiceId || lease.conversationId !== message.conversationId) {
        return;
      }

      if (message.command.kind === 'interrupt') {
        if (lease.serverVad) {
          if (message.command.turn !== lease.turn) {
            return;
          }
        }
        else {
          if (message.command.turn <= lease.turn) {
            return;
          }

          lease.turn = message.command.turn;
        }
      }

      if (message.command.kind === 'audio' && !lease.serverVad && message.command.turn !== lease.turn) {
        return;
      }

      // GPT-Live 一次委派一轮，断开期间补发的几轮会同时等页面资料；宿主只认自己还在等的轮次。
      if (message.command.kind === 'commit' && (lease.live ? message.command.turn > lease.turn : message.command.turn !== lease.turn)) {
        return;
      }

      // A diagnostic take never reads the page: its commit carries no observation or ask context.
      if (message.command.kind === 'commit' && this.enrich && !lease.diagnostic) {
        const command = message.command;

        if (!this.send({ ...message, command: { ...command, contextPending: true } })) {
          this.disconnected();

          return;
        }

        void Promise.all([this.enrich(lease.conversationId, command.input ?? {}), this.observation.issue().catch(() => undefined)]).then(([input, observation]) => {
          if (this.lease !== lease) {
            return;
          }

          const source: VoiceInputContext = { ...input };

          if (!input.context || input.context.tabId === observation?.tabId) source.observation = observation;

          if (!this.send({ ...message, command: { kind: 'input_context', turn: command.turn, input: source } })) {
            this.disconnected();
          }
        }).catch(() => {
          if (this.lease === lease) {
            this.send({ ...message, command: { kind: 'input_context', turn: command.turn, error: '页面资料没能读取，这句话尚未执行。' } });
          }
        });

        return;
      }

      if (!this.send(message)) {
        this.disconnected();

        return;
      }

      if (message.command.kind === "stop") {
        this.lease = null;
        this.observation.clear();
      }
    });
  }
  async observe(conversationId: string, token: unknown, mode: unknown = 'image'): Promise<unknown> {
    if (mode !== 'text' && mode !== 'image') {
      throw new Error('不支持的页面观察方式。');
    }

    const lease = this.lease;

    return this.observation.capture(token, () => !!lease?.port && this.lease === lease && lease.conversationId === conversationId && this.selected(lease.port) === conversationId, mode);
  }
  server(message: Extract<ServerMessage, {
    type: "voice";
  }>): void {
    const lease = this.lease;

    if (!lease || lease.voiceId !== message.voiceId || lease.conversationId !== message.conversationId) {
      return;
    }

    if (message.event.kind === 'state' && message.event.state === 'ready' && message.event.inputMode === 'server_vad') {
      lease.serverVad = true;
      lease.turn = 1;
    }

    if (message.event.kind === 'input_turn') {
      if (!lease.serverVad || message.event.turn <= lease.turn) {
        return;
      }

      lease.turn = message.event.turn;
    }

    this.post(message);

    if (message.event.kind === "state" && (message.event.state === "closed" || message.event.state === "error")) {
      this.lease = null;
      this.observation.clear();
    }
  }
  private post(message: Extract<ServerMessage, {
    type: "voice";
  }>): void {
    const lease = this.lease;

    if (lease && !lease.port) {
      lease.buffer.push(message);

      if (lease.buffer.length > DETACHED_BUFFER_MAX) this.stop("panel_disconnected");

      return;
    }

    try {
      lease?.port?.postMessage({ kind: "server", conversationId: message.conversationId, msg: message });
    }
    catch { /* panel closed */
    }
  }
  private rebind(lease: NonNullable<VoiceRelay["lease"]>, port: chrome.runtime.Port): void {
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = null;
    lease.port = port;
    console.info("[voice] relay_reattached", JSON.stringify({ voiceId: lease.voiceId, buffered: lease.buffer.length }));

    for (const message of lease.buffer.splice(0)) this.post(message);
    // 中继替宿主确认：会话一直在，不经宿主重发 ready，免得重置轮次。
    this.post({ type: "voice", voiceId: lease.voiceId, conversationId: lease.conversationId, event: { kind: "state", state: "ready", detail: "已重新连上" } });
  }
  /** Only the panel that holds the voice lease can end it by switching conversation. */
  selectionChanged(port: chrome.runtime.Port, id: string): void {
    if (this.lease?.port === port && this.lease.conversationId !== id) {
      this.stop("selection_changed");
    }
  }
  disconnected(): void {
    if (!this.lease) {
      return;
    }

    const { voiceId, conversationId } = this.lease;
    this.post({ type: "voice", voiceId, conversationId, event: { kind: "state", state: "error", detail: "语音连接已断开，正在恢复…", recoverable: true } });
    this.lease = null;
    this.observation.clear();
  }
  stop(reason = "stop"): void {
    if (!this.lease) {
      return;
    }

    const lease = this.lease;
    const { voiceId, conversationId } = lease;
    console.info("[voice] relay_stop", JSON.stringify({ voiceId, reason }));
    if (this.detachTimer) clearTimeout(this.detachTimer);
    this.detachTimer = null;
    this.lease = null;
    this.observation.clear();
    this.send({ type: "voice", voiceId, conversationId, command: { kind: "stop" } });

    try {
      lease.port?.postMessage({ kind: "server", conversationId, msg: { type: "voice", voiceId, conversationId, event: { kind: "state", state: "closed" } } });
    }
    catch { /* panel closed */
    }
  }
}
