import { realtimeBrowserError } from './realtime-browser-tools.js';
import { projectTaskView } from '../../shared/task-view.js';
import { VoiceAudioCache } from "./voice-audio-cache.js";
import { RealtimeVoiceSession, type RealtimeVoiceDependencies } from './realtime-voice-session.js';
import { voiceSpokenResultGateEnabled } from './config.js';
import { sharedRouteShadow } from './route-shadow.js';
import { isLeadSession } from '../../shared/protocol.js';
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../shared/protocol.js";
import type { TaskProgressSnapshot, VoiceClientMessage, VoiceRouteContext, VoiceTarget } from "../../shared/voice.js";
import type { StepVoiceSession } from "./voice-session.js";
import { STEP_VOICE } from './realtime-voice-connection.js';

type VoiceSession = Pick<StepVoiceSession, 'start' | 'command' | 'close' | 'notify' | 'streamDelivery' | 'completeDelivery'>;

export async function readStepVoiceKey(): Promise<string> {
  const environment = process.env.STEPFUN_API_KEY?.trim();

  if (environment) {
    return environment;
  }

  const file = join(homedir(), ".sideagent", "stepfun-api.key");

  try {
    const info = await stat(file);

    if (info.mode & 0o077) {
      throw new Error("permissions");
    }

    const key = (await readFile(file, "utf8")).trim();

    if (key) {
      return key;
    }
  }
  catch { /* one safe diagnostic, no key material */
  }

  throw new Error("请先配置本机 StepFun 开放平台 API Key，再重试。");
}

/** 仍未确认（unknown）或被阻碍（blocked）的执行项：用户必须知道的缺口，保留人话播报。 */
function hasUnresolvedObstacle(snapshot: TaskProgressSnapshot): boolean {
  return projectTaskView(snapshot).outstanding.some(item => item.status === 'unknown' || item.status === 'blocked');
}

/** One explicit human voice connection; background task sessions stay independent. */
export class VoiceService {
  private readonly deliveryOwners = new Map<string, string>();
  private readonly receiptAudioCache = new VoiceAudioCache(STEP_VOICE);
  private active: {
    id: string;
    conversationId: string;
    session: VoiceSession;
    observed: string;
    startedAt: number;
    controls: Set<string>;
    notifiedControls: Set<string>;
    announcedDeliveries: Set<string>;
    streamedDeliveries: Set<string>;
  } | null = null;
  constructor(private readonly snapshot: (id: string) => TaskProgressSnapshot | null, private readonly emit: (msg: ServerMessage) => void, private readonly getKey = readStepVoiceKey, private readonly createSession = (deps: RealtimeVoiceDependencies): VoiceSession => new RealtimeVoiceSession(deps), private readonly steer?: (id: string, text: string, startedAt: number | null) => Promise<void>, private readonly route?: (id: string, text: string, startedAt: number | null, stillCurrent: () => boolean, context: VoiceRouteContext) => ReturnType<NonNullable<ConstructorParameters<typeof StepVoiceSession>[0]["route"]>>, private readonly diagnostic?: ConstructorParameters<typeof StepVoiceSession>[0]["diagnostic"], private readonly targets?: () => VoiceTarget[], private readonly onPlayback?: (conversationId: string, deliveryId: string, status: "speaking" | "played") => void, private readonly onSpokenAck?: (conversationId: string, text: string, runId: string | null) => void, private readonly relatedTask: (origin: string, target: string) => boolean = () => false, private readonly readPage?: (conversationId: string, input: import('../../shared/voice.js').VoiceInputContext) => Promise<unknown>, private readonly dispatchTask?: RealtimeVoiceDependencies['dispatchTask'], private readonly browserTool?: (id: string, ...args: Parameters<NonNullable<RealtimeVoiceDependencies['browserTool']>>) => Promise<unknown>) {
  }
  async handle(conversationId: string, message: VoiceClientMessage): Promise<void> {
    if (message.command.kind === "start") {
      // Diagnostic capture is an explicit, server-confirmed mode; it is built without
      // any route or steer callable, so a diagnostic session cannot touch tasks or pages.
      // `capture` alone only turns recording on: the session still answers, routes and steers as usual.
      const diag = message.command.diagnostic === true;
      const capture = diag || message.command.capture === true;

      if (this.active?.id === message.voiceId && this.active.conversationId === conversationId) {
        return;
      }

      this.close();

      if (!this.snapshot(conversationId)) {
        this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event: { kind: "state", state: "error", detail: "当前会话不可用，请重新选择会话。" } });

        return;
      }

      const initial = this.snapshot(conversationId)!;
      const initialRes = initial.conversationContext?.latestResult;
      const initialHasResult = !!(initialRes && initialRes.runId === initial.runId && initialRes.text);
      const initialResultId = initialHasResult && initialRes ? `${initialRes.runId}:${initialRes.observedAt}` : 'none';
      const initialDelivery = initial.conversationContext?.latestDelivery;
      const announcedDeliveries = new Set<string>(initialDelivery?.id ? [initialDelivery.id] : []);

      const active = {
        id: message.voiceId, conversationId, observed: `${initial.runId}:${initial.state}:${initialResultId}:${initialDelivery?.id ?? 'none'}`, startedAt: Date.now(), controls: new Set<string>(), notifiedControls: new Set<string>(), announcedDeliveries, streamedDeliveries: new Set<string>(), session: this.createSession({
          voiceId: message.voiceId,
          earlyReplies: !diag,
          ...(diag ? { diagnosticMode: true } : {}),
          ...(capture ? { captureMode: true } : {}),
          getSnapshot: () => this.snapshot(conversationId),
          getDeliverySnapshot: stream => this.snapshot(this.deliveryOwners.get(stream.id) ?? conversationId),
          getTargets: this.targets,
          ...(!diag && this.browserTool ? {browserTool: (...args: Parameters<NonNullable<RealtimeVoiceDependencies['browserTool']>>) => {
            if (this.active?.id !== message.voiceId) throw realtimeBrowserError('语音会话已关闭，未执行。', 'not_executed');

            return this.browserTool!(conversationId,...args);
          }} : {}),
          receiptAudioCache: this.receiptAudioCache,
          // Shared across voice sessions so the daily Jev-call budget is counted once, not reset per session; never wired for diagnostic capture.
          ...(!diag ? { shadow: sharedRouteShadow() } : {}),
          // Explicit opt-in; shadow logging alone never enables product behavior.
          ...(!diag ? { voiceSpokenResultGate: voiceSpokenResultGateEnabled() } : {}),
          ...(this.readPage && !diag ? { readPage: (input: import('../../shared/voice.js').VoiceInputContext) => this.readPage!(conversationId, input) } : {}),
          ...(this.dispatchTask && !diag ? { dispatchTask: (request: import('../../shared/task-actions.js').TaskActionRequest, stillCurrent: () => boolean) => this.dispatchTask!(request, () => this.active?.id === message.voiceId && stillCurrent()) } : {}),
          diagnostic: (event, fields) => this.diagnostic?.(event, { voiceId: message.voiceId, conversationId, ...fields }),
          ...(this.route && !diag ? { route: (text: string, startedAt: number | null, stillCurrent: () => boolean, context: VoiceRouteContext) => this.route!(conversationId, text, startedAt, () => this.active?.id === message.voiceId && stillCurrent(), context) } : {}),
          ...(this.steer && !diag ? {
            steer: async (text: string, startedAt: number | null) => {
              if (this.active?.id !== message.voiceId || this.active.conversationId !== conversationId) {
                throw new Error("语音会话已结束，修改未发送。");
              }

              await this.steer!(conversationId, text, startedAt);
            }
          } : {}),
          emit: event => this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event }),
          onPlayback: (deliveryId, status) => {
            if (this.active !== active) {
              return;
            }

            this.onPlayback?.(this.deliveryOwners.get(deliveryId) ?? conversationId, deliveryId, status);
          },
          onSpokenAck: (text, runId) => {
            if (this.active !== active) {
              return;
            }

            this.onSpokenAck?.(conversationId, text, runId);
          },
        })
      };

      this.active = active;

      try {
        const key = await this.getKey();

        if (this.active === active) {
          active.session.start(key);
        }
      }
      catch {
        if (this.active === active) {
          active.session.close(false);
          this.active = null;
          this.emit({ type: "voice", voiceId: message.voiceId, conversationId, event: { kind: "state", state: "error", detail: "请先配置本机 StepFun 开放平台 API Key，再重试。" } });
        }
      }

      return;
    }

    const active = this.active;

    if (!active || active.id !== message.voiceId || active.conversationId !== conversationId) {
      return;
    }

    if (message.command.kind === "interrupt") {
      const current = this.snapshot(conversationId)?.conversationContext?.latestDelivery;

      if (current?.id) {
        active.announcedDeliveries.add(current.id);
      }
    }

    active.session.command(message.command);

    if (message.command.kind === "stop") {
      this.active = null;
    }
  }
  observe(message: ServerMessage): void {
    const active = this.active;

    if (!active) {
      return;
    }

    const owner = message.conversationId ?? active.conversationId;

    if (owner !== active.conversationId) {
      if (!this.relatedTask(active.conversationId, owner)) {
        return;
      }

      const snapshot = this.snapshot(owner);

      if (!snapshot) {
        return;
      }

      if (['aborted', 'error', 'paused'].includes(snapshot.state)) {
        for (const [id, target] of this.deliveryOwners) {
          if (target === owner) {
            active.session.streamDelivery?.({ id, runId: snapshot.runId ?? null, kind: 'finding', text: '', phase: 'cancelled' });
          }
        }

        return;
      }

      if (message.type !== 'agent_event' || !isLeadSession(message.sessionId)) {
        return;
      }

      const e = message.event;

      if (e.kind === 'user_delivery_stream' && e.stream.runId === snapshot.runId) {
        this.deliveryOwners.set(e.stream.id, owner);
        active.streamedDeliveries.add(e.stream.id);
        active.session.streamDelivery?.({ ...e.stream, text: `关于${snapshot.goal?.slice(0, 60) ?? '另一项任务'}：${e.stream.text}` });
      }
      else if (e.kind === 'user_delivery' && e.delivery.runId === snapshot.runId && e.delivery.status !== 'played') {
        this.deliveryOwners.set(e.delivery.id, owner);

        if (!active.announcedDeliveries.has(e.delivery.id)) {
          active.announcedDeliveries.add(e.delivery.id);
          active.session.completeDelivery?.({ ...e.delivery, text: `关于${snapshot.goal?.slice(0, 60) ?? '另一项任务'}：${e.delivery.text}` });
        }
      }

      return;
    }

    if (message.type === 'task_control') {
      active.controls.add(message.requestId);

      return;
    }

    const snapshot = this.snapshot(active.conversationId);

    if (!snapshot) {
      return;
    }

    if (message.type === 'agent_event' && isLeadSession(message.sessionId)) {
      const e = message.event;

      if (e.kind === 'user_delivery_stream' && e.stream.runId === (snapshot.runId ?? null)) {
        active.announcedDeliveries.add(e.stream.id);
        active.streamedDeliveries.add(e.stream.id);
        active.session.streamDelivery?.(e.stream);

        return;
      }

      if (e.kind === 'user_delivery' && active.streamedDeliveries.has(e.delivery.id) && e.delivery.runId === (snapshot.runId ?? null)) {
        active.session.completeDelivery?.(e.delivery);

        return;
      }
    }

    if (message.type === 'agent_event' && message.event.kind === 'notice' && message.event.receipt) {
      const r = message.event.receipt;

      if (['pause', 'resume', 'abort'].includes(r.action)) {
        active.controls.delete(r.requestId);

        if (!active.notifiedControls.has(r.requestId) && r.status === 'applied' && r.updatedAt >= active.startedAt && r.runId === snapshot.runId && ['paused', 'aborted'].includes(snapshot.state)) {
          active.notifiedControls.add(r.requestId);
          active.session.notify(snapshot);
        }
      }
    }

    const delivery = snapshot.conversationContext?.latestDelivery;
    const speakable = !!(delivery && (delivery.kind === 'finding' || delivery.kind === 'reply') && delivery.status !== 'played' && delivery.runId === snapshot.runId && delivery.text.trim());
    const result = snapshot.conversationContext?.latestResult;
    const hasResult = !!(result && result.runId === snapshot.runId && result.text);
    const resultIdentity = hasResult && result ? `${result.runId}:${result.observedAt}` : 'none';

    if (speakable && delivery && snapshot.state === 'idle' && !active.controls.size && !active.announcedDeliveries.has(delivery.id)) {
      active.announcedDeliveries.add(delivery.id);
      active.observed = `${snapshot.runId}:${snapshot.state}:${resultIdentity}:${delivery.id}`;
      active.session.notify(snapshot);

      return;
    }

    // session.ts emits status idle before agent_end; do not broadcast premature empty idle on status message alone
    if (message.type === 'status' && message.state === 'idle' && !hasResult && !speakable && !hasUnresolvedObstacle(snapshot)) {
      return;
    }

    if (snapshot.state === 'idle' && hasResult && !speakable && !hasUnresolvedObstacle(snapshot)) {
      return;
    }

    const key = `${snapshot.runId}:${snapshot.state}:${resultIdentity}:${delivery?.id ?? 'none'}`;

    if (key === active.observed) {
      return;
    }

    active.observed = key;

    if (!active.controls.size && snapshot.state === 'error' && snapshot.runId) {
      active.session.notify(snapshot);
    }
    // 只有仍未确认或受阻的真实执行项才需要第二次开口；普通 running→idle 是内部状态，不补播。
    // 已有结果文本不能呑掉未确认项（复核 2026-09-21：idle + 结果文本 + unknown 项仍需告知）。
    else if (!active.controls.size && snapshot.state === 'idle' && snapshot.runId && !delivery && hasUnresolvedObstacle(snapshot)) {
      active.session.notify(snapshot);
    }
  }
  close(): void {
    this.active?.session.close();
    this.active = null;
    this.deliveryOwners.clear();
  }
}
