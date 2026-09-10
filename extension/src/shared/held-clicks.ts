/**
 * held 点击的台账与放行决策：哪个 session 拦下了哪一下（pending）、
 * 哪个 session 已被用户放行（armed，一次性）。
 * 纯数据层，无 chrome/DOM 依赖，可单测；页面表现（拿住、名牌双键）由调用方负责。
 */

export type HeldAction = "confirm" | "cancel";

/**
 * 工具成功返回但操作没有真正派发（当前只有被拦下的 click）。
 * 这种回执必须按未执行上报：否则任务账本会把"等你确认"读成"已经点过"。
 */
export function isHeldClickResult(name: string, data: unknown): boolean {
  if (name !== "click" || !data || typeof data !== "object") return false;
  return (data as { held?: unknown }).held === true;
}

export type HeldResolution<P> =
  /** 有 pending：取出参数，由调用方用同一只手真实派发（session 已 arm，retry 一次通过） */
  | { kind: "dispatch"; sessionId: string; params: P }
  /** 无 pending（模型自绘 mark 路径）：直接 arm 该 session，模型重试 click 一次通过，不要第二轮 */
  | { kind: "armOnce"; sessionId: string }
  /** 取消：pending/arm 已清；sessionId 为空表示本来就没有 pending（仍应收起标注、松开手） */
  | { kind: "cancelled"; sessionId?: string };

export class HeldClicks<P> {
  private pending = new Map<string, P>();
  private armed = new Set<string>();

  constructor(private leadId: string) {}

  arm(sessionId: string): void {
    this.armed.add(sessionId);
  }

  disarm(sessionId: string): void {
    this.armed.delete(sessionId);
  }

  isArmed(sessionId: string): boolean {
    return this.armed.has(sessionId);
  }

  hold(sessionId: string, params: P): void {
    this.pending.set(sessionId, params);
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  clearPending(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  drop(sessionId: string): void {
    this.pending.delete(sessionId);
    this.armed.delete(sessionId);
  }

  dropAll(): void {
    this.pending.clear();
    this.armed.clear();
  }

  /** 找该放行的 session：优先调用方给的，其次 lead，再次任意一个 pending。 */
  pendingSession(preferred: string): string | undefined {
    if (this.pending.has(preferred)) return preferred;
    if (this.pending.has(this.leadId)) return this.leadId;
    return this.pending.keys().next().value;
  }

  resolve(action: HeldAction, preferred: string): HeldResolution<P> {
    const sid = this.pendingSession(preferred);
    if (action === "cancel") {
      if (sid) this.drop(sid);
      return { kind: "cancelled", sessionId: sid };
    }
    if (!sid) {
      this.armed.add(preferred);
      return { kind: "armOnce", sessionId: preferred };
    }
    const params = this.pending.get(sid)!;
    this.pending.delete(sid);
    this.armed.add(sid);
    return { kind: "dispatch", sessionId: sid, params };
  }
}
