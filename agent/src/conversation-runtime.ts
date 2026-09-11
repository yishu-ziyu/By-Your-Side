import { LEAD_SESSION_ID, isLeadSession, type ClientMessage, type ServerMessage, type TeamView, type TeamMemberHandback } from "../../shared/protocol.js";
import { fromTeamMemberHandback } from "../../shared/control.js";
import { createFleetTools, Fleet } from "./fleet.js";
import { ToolRpc } from "./rpc.js";
import { BrowserAgentSession, type SessionCreateOptions } from "./session.js";
import { createBrowserTools } from "./tools.js";
import { consumeAcceptanceCapability } from "./acceptance-capability.js";
import { frozenMembersFromTakeover } from "./team-handoff.js";
import type { ExperienceStore } from "./experience.js";
import type { MemoryStore } from "./memory-store.js";
const log = (message: string) => console.error(`[sideagent] ${message}`);
export async function createConversationRuntime(
  conversationId: string,
  emit: (msg: ServerMessage) => void,
  modelPattern?: string,
  options?: Pick<SessionCreateOptions, "sessionManager" | "mode" | "customTools"> & { memoryStore?: MemoryStore; experienceStore?: ExperienceStore },
) {
  const sendCurrent = (msg: ServerMessage) => emit({ ...msg, conversationId });
  const rpc = new ToolRpc((frame) => sendCurrent(frame));
  const fleet = new Fleet({
    rpc,
    modelPattern,
    sink: {
      emit: (event, sessionId) =>
        sendCurrent({
          type: "agent_event",
          event,
          ...(sessionId && !isLeadSession(sessionId) ? { sessionId } : {}),
        }),
      setStatus: (state, sessionId) =>
        sendCurrent({
          type: "status",
          state,
          ...(sessionId && !isLeadSession(sessionId) ? { sessionId } : {}),
        }),
    },
  });

  let toolSession: BrowserAgentSession | undefined;
  const session = await BrowserAgentSession.create(
    rpc,
    {
      emit: (event) => sendCurrent({ type: "agent_event", event }),
      setStatus: (state) => sendCurrent({ type: "status", state }),
    },
    {
      modelPattern,
      ...options,
      conversationId,
      customTools: [...createBrowserTools(rpc, undefined, tabId => fleet.takeTab(tabId), name => toolSession?.isToolActive(name === "worker_tabs" ? "take_tab" : name) ?? false, { epoch: () => toolSession?.executionEpoch() ?? 0, canWrite: () => toolSession?.canWriteCurrentInput() ?? false, assertCall: (name, params, toolCallId) => toolSession?.assertTaskResultExecution(name, params, toolCallId), onStep: step => toolSession?.observeProgramStep(step) }), ...(options?.customTools ?? []), ...createFleetTools(fleet, LEAD_SESSION_ID)],
    },
  );
  toolSession = session;
  fleet.attachLead(session);
  // 协作工具按需挂载：没有 worker 时模型只看到常驻工具，请到人（或拿到同伴工件）后再出现。
  fleet.onMembersChange = (count) => session.setTeamToolsMounted(count > 0);
  session.setTeamToolsMounted(fleet.size > 0);
  if (!session.available) {
    log("模型凭据未配置，会话暂不可用（连接面板后会收到设置指引）");
  }

  /** 模型热切换只更新当前会话；manager 持久化其摘要。 */
  const handleSetModel = async (model: string): Promise<void> => {
    try {
      await session.setModel(model);
      const models = await session.availableModels();
      log(`模型已切换：${session.modelName() ?? model}`);
      sendCurrent({ type: "model_info", model: session.modelName() ?? model, models });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`切换模型失败（${model}）：${message}`);
      sendCurrent({ type: "agent_event", event: { kind: "error", message: `切换模型失败：${message}` } });
    }
  };

  const handleMessage = (msg: ClientMessage): void => {
    switch (msg.type) {
      case "user_message":
        if (session.isHeld()) {
          session.sendUserMessage(msg.text, msg.context, msg.attachments);
          break;
        }
        if (!session.isStreaming()) fleet.reset();
        session.sendUserMessage(
          msg.text,
          msg.context,
          msg.attachments,
        );
        break;
      case "steer":
        session.steer(msg.text, msg.context, msg.attachments);
        break;
      case "abort":
        session.abort();
        fleet.abortTeam();
        sendCurrent({ type: "status", state: "idle" });
        {
          const aborted = fleet.teamView();
          if (aborted) sendCurrent({ type: "team_status", team: aborted });
        }
        break;
      case "takeover": {
        const frozen = frozenMembersFromTakeover(msg);
        if (frozen.length === 0 && !session.isHeld() && !fleet.isGroupHeld()) {
          sendCurrent({
            type: "control_result",
            requestId: msg.requestId,
            action: "takeover",
            ok: false,
            state: "idle",
            reason: "当前没有运行中的任务，不用接管。",
          });
          break;
        }
        let team;
        try {
          team = fleet.holdActiveGroup(frozen.length > 0 ? frozen : undefined, {
            groupId: msg.groupId,
            generation: msg.generation,
          });
        } catch (err) {
          sendCurrent({
            type: "control_result",
            requestId: msg.requestId,
            action: "takeover",
            ok: false,
            state: session.isStreaming() ? "running" : "idle",
            reason: err instanceof Error ? err.message : String(err),
          });
          break;
        }
        sendCurrent({
          type: "control_result",
          requestId: msg.requestId,
          action: "takeover",
          ok: true,
          state: "user",
          team,
        });
        sendCurrent({ type: "team_status", team });
        for (const member of team.members) {
          sendCurrent({
            type: "status",
            state: "user",
            ...(isLeadSession(member.sessionId) ? {} : { sessionId: member.sessionId }),
          });
        }
        break;
      }
      case "handback": {
        const held = session.isHeld() || fleet.isGroupHeld();
        if (!held) {
          sendCurrent({
            type: "control_result",
            requestId: msg.requestId,
            action: "handback",
            ok: false,
            state: session.isStreaming() ? "running" : "idle",
            reason: "Agent 没有保持原任务，不能把这次操作算作交还。",
          });
          break;
        }
        const pages = handbackPagesFromMessage(msg);
        if (pages.length === 0) {
          sendCurrent({
            type: "control_result",
            requestId: msg.requestId,
            action: "handback",
            ok: false,
            state: "user",
            reason: "没有可用的交还页面。",
            team: fleet.teamView() ?? undefined,
          });
          break;
        }
        let acknowledged = false;
        const publishProgress = (team: TeamView): void => {
          if (!acknowledged) {
            acknowledged = true;
            sendCurrent({
              type: "control_result",
              requestId: msg.requestId,
              action: "handback",
              ok: true,
              state: "user",
              team,
            });
          }
          sendCurrent({ type: "team_status", team });
          for (const member of team.members) {
            sendCurrent({
              type: "status",
              state: member.phase === "restored" ? "running" : member.phase === "aborted" ? "idle" : "user",
              ...(isLeadSession(member.sessionId) ? {} : { sessionId: member.sessionId }),
            });
          }
        };
        void fleet
          .continueMembers(pages, { groupId: msg.groupId, generation: msg.generation }, publishProgress)
          .then((result) => {
            if (!acknowledged) {
              sendCurrent({
                type: "control_result",
                requestId: msg.requestId,
                action: "handback",
                ok: false,
                state: "user",
                reason: "原会话当前不可用，控制权仍归你。",
                team: result.team,
              });
              return;
            }
            if (!result.team.members.some((member) => member.phase === "restored")) return;
            void fleet.waitForAcceptanceContinuity().then(
              (continuity) => {
                if (continuity.length > 0) {
                  sendCurrent({ type: "acceptance_team_evidence", requestId: msg.requestId, continuity });
                }
              },
              (err: unknown) => {
                sendCurrent({
                  type: "acceptance_team_evidence",
                  requestId: msg.requestId,
                  continuity: fleet.acceptanceContinuityEvidence().map((entry) => ({ ...entry, active: false })),
                });
                log(`验收续跑证据失败：${err instanceof Error ? err.message : String(err)}`);
              },
            );
          });
        break;
      }
      case "acceptance_prepare_team":
        if (!consumeAcceptanceCapability(msg.capability)) {
          sendCurrent({
            type: "acceptance_team_ready",
            requestId: msg.requestId,
            ok: false,
            members: [],
            continuity: [],
            reason: "本地验收能力令牌无效或已使用",
          });
          break;
        }
        void fleet.prepareAcceptanceWorker({
          id: msg.worker.sessionId,
          tabId: msg.worker.tabId,
          leadTask: msg.tasks.lead,
          workerTask: msg.tasks.worker,
          live:msg.live,
        }).then(
          (continuity) => {
            sendCurrent({
              type: "acceptance_team_ready",
              requestId: msg.requestId,
              ok: true,
              members: [LEAD_SESSION_ID, msg.worker.sessionId],
              models:{[LEAD_SESSION_ID]:session.modelName()??"unknown",[msg.worker.sessionId]:fleet.get(msg.worker.sessionId)?.modelName()??"unknown"},
              continuity,
            });
          },
          (err: unknown) => {
            sendCurrent({
              type: "acceptance_team_ready",
              requestId: msg.requestId,
              ok: false,
              members: [LEAD_SESSION_ID],
              continuity: [],
              reason: err instanceof Error ? err.message : String(err),
            });
          },
        );
        break;
      case "set_mode":
        void session.setMode(msg.mode);
        break;
      case "set_model":
        void handleSetModel(msg.model);
        break;
      case "page_event": {
        const target =
          isLeadSession(msg.sessionId) ? session : fleet.get(msg.sessionId!);
        target?.notifyPageEvent(msg.url);
        break;
      }
      case "tool_result":
        rpc.handleResult(msg.id, msg.ok, msg.data, msg.error, msg.executionFact);
        break;
      default:
        break;
    }
  };

  return { session, fleet, rpc, handleMessage, dispose() { fleet.dispose(); session.dispose(); } };
}
function handbackPagesFromMessage(msg: Extract<ClientMessage, { type: "handback" }>) {
  if (msg.members && msg.members.length > 0) {
    return msg.members.map((m: TeamMemberHandback) => fromTeamMemberHandback(m));
  }
  if (msg.context && typeof msg.snapshot === "string") {
    return [
      fromTeamMemberHandback({
        sessionId: LEAD_SESSION_ID,
        context: msg.context,
        snapshot: msg.snapshot,
      }),
    ];
  }
  return [];
}
