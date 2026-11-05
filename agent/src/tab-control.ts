import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "./define-tool.js";
import { Type } from "typebox";
import { LEAD_SESSION_ID, isLeadSession, type TeamView } from "../../shared/protocol.js";
import { TeamControl, holdFrozenGroup, snapshotActiveGroup, type ActiveMemberInput, type MemberHandbackPage } from "../../shared/control.js";
import type { ToolRpc } from "./rpc.js";
import type { BrowserAgentSession } from "./session.js";

export class TabControl {
  private lead: BrowserAgentSession | null = null;
  private coordinateTab?: (owner: string, members: string[], userNamedThisPage: boolean) => Promise<{ pausedTask?: string }>;
  setTabCoordinator(coordinate: (owner: string, members: string[], userNamedThisPage: boolean) => Promise<{ pausedTask?: string }>): void { this.coordinateTab = coordinate; }
  private ownerIdle?: (conversationId: string) => boolean;
  private readonly idleReleases = new Map<number | "working", Promise<boolean>>();
  setIdleOwnerCheck(check: (conversationId: string) => boolean): void { this.ownerIdle = check; }
  private readonly team = new TeamControl();

  constructor(private readonly rpc: ToolRpc) {}

  attachLead(session: BrowserAgentSession): void {
    this.lead = session;
  }

  get(id: string): BrowserAgentSession | undefined {
    return isLeadSession(id) ? (this.lead ?? undefined) : undefined;
  }

  teamView(): TeamView | null {
    return this.team.view();
  }

  isGroupHeld(): boolean {
    const phase = this.team.view()?.phase;

    return phase === "user" || phase === "draining" || phase === "restoring" || phase === "partial";
  }

  private snapshotActive(): ActiveMemberInput[] {
    return snapshotActiveGroup({
      lead: {
        sessionId: LEAD_SESSION_ID,
        streaming: this.lead?.isStreaming() ?? false,
        held: this.lead?.isHeld() ?? false,
        waitingTool: this.rpc.pendingSessionIds().includes(LEAD_SESSION_ID),
        waitingMessage: false,
      },
      workers: [],
    });
  }

  holdActiveGroup(frozen?: ActiveMemberInput[], group?: { groupId?: string; generation?: number }): TeamView {
    const members = frozen && frozen.length > 0 ? frozen : this.snapshotActive();
    const missing = members.find((member) => !this.get(member.sessionId));

    if (missing) throw new Error(`接管组成员 ${missing.sessionId} 的原会话不存在`);

    return holdFrozenGroup({ team: this.team, frozen: members, group, holdMember: (id, abortStream) => { this.get(id)!.holdForUser({ abortStream }); } });
  }

  async continueMembers(
    pages: MemberHandbackPage[],
    meta?: { groupId?: string; generation?: number },
    onTeamUpdate?: (team: TeamView) => void,
  ): Promise<{ ok: boolean; team: TeamView }> {
    const current = this.team.view();

    if (!current || current.phase === "aborted") return { ok: false, team: current ?? this.team.abort() };

    if (current.phase === "user") this.team.beginRestore();

    if (!this.team.applyHandback(pages, meta)) return { ok: false, team: this.team.view()! };
    onTeamUpdate?.(this.team.view()!);
    const expected = this.team.view()!;

    const results = await Promise.all(pages.map(async (page) => {
      if (!page.ok) return false;
      const session = this.get(page.sessionId);
      let ok = false;

      try { ok = session ? await session.continueAfterHandback(page.context, page.snapshot) : false; } catch { ok = false; }

      if (!ok) {
        const reason = session ? (session.handbackFailureReason ?? "恢复失败，原会话仍归你。") : "恢复失败：原会话已不存在，仍归你。";
        onTeamUpdate?.(this.team.markRestoreFailed(page.sessionId, reason, expected));

        return false;
      }

      const next = this.team.markRestored(page.sessionId, expected);
      onTeamUpdate?.(next);

      return next.members.find((member) => member.sessionId === page.sessionId)?.phase === "restored";
    }));

    const team = this.team.view()!;
    const paused = team.members.some((m) => m.phase === "paused_tab_closed" || m.phase === "paused_snapshot_failed");

    return { ok: results.some(Boolean) || paused, team };
  }

  abortTeam(): TeamView {
    return this.team.abort();
  }

  async stopMembersForForeignTakeover(members: readonly string[]): Promise<string[]> {
    if (!members.includes(LEAD_SESSION_ID) || !this.lead) return [];
    await this.lead.yieldTab();

    return [LEAD_SESSION_ID];
  }

  async takeTab(tabId?: number, userNamedThisPage = false): Promise<{ tabId: number; pausedTask?: string }> {
    const info = await this.rpc.call("worker_tabs", tabId != null ? { action: "inspect", tabId } : { action: "inspect" }) as { tabId: number; workers: string[]; owned?: boolean; conversationId?: string | null; foreign?: boolean; members?: string[] };

    let pausedTask: string | undefined;

    if (info.foreign) {
      if (!this.coordinateTab) throw new Error("页面协调器尚未就绪，请重连后再试");
      pausedTask = (await this.coordinateTab(info.conversationId!, info.members ?? info.workers, userNamedThisPage)).pausedTask;
    }

    if (info.owned !== false || info.conversationId !== undefined) {
      await this.rpc.call("worker_tabs", info.conversationId !== undefined ? { action: "claim", tabId: info.tabId, expectedConversationId: info.conversationId, ...(pausedTask !== undefined ? { overrideUserHold: true } : {}) } : { action: "claim", tabId: info.tabId });
    }

    return { tabId: info.tabId, ...(pausedTask !== undefined ? { pausedTask } : {}) };
  }

  async releaseIdleForeignTab(tabId?: number): Promise<boolean> {
    const key = tabId ?? "working";
    const inflight = this.idleReleases.get(key);

    if (inflight) return inflight;
    const release = this.releaseIdleForeignTabOnce(tabId).finally(() => this.idleReleases.delete(key));
    this.idleReleases.set(key, release);

    return release;
  }

  private async releaseIdleForeignTabOnce(tabId?: number): Promise<boolean> {
    if (!this.ownerIdle) return false;

    type TabInfo = { tabId: number; foreign?: boolean; conversationId?: string | null };

    const inspect = () => this.rpc.call("worker_tabs", tabId != null ? { action: "inspect", tabId } : { action: "inspect", orActive: true }) as Promise<TabInfo>;
    let info: TabInfo;

    try { info = await inspect(); } catch { return false; }

    if (!info.conversationId) return false;

    if (!info.foreign) return true;

    if (!this.ownerIdle(info.conversationId)) return false;

    try {
      await this.rpc.call("worker_tabs", { action: "claim", tabId: info.tabId, expectedConversationId: info.conversationId });
    } catch {
      return inspect().then(now => now.foreign === false && !!now.conversationId, () => false);
    }

    return true;
  }
}

export function createTakeTabTool(control: TabControl): ToolDefinition {
  return defineTool({
    name: "take_tab",
    label: "接管页面",
    description: "Take control of any browser tab. Coordinates with its current conversation, stops it and waits for pending operations before handing it over. A page handed to the user stays protected: set userNamedThisPage only when the user's latest message explicitly asks you to act on this very page; the task waiting on it stays paused. For reading alone use snapshot or read_element with tabId; no takeover is needed.",
    parameters: Type.Object({ tabId: Type.Number(), userNamedThisPage: Type.Optional(Type.Boolean()) }),
    execute: async (_id, params) => {
      const result = await control.takeTab(params.tabId, params.userNamedThisPage === true);
      const paused = result.pausedTask !== undefined ? ` 任务「${result.pausedTask}」仍暂停，之后用户可以回到它接着做；回答时告诉用户这一点。` : "";

      return { content: [{ type: "text" as const, text: `页面 ${result.tabId} 已交回本会话。${paused}` }], details: result };
    },
  });
}
