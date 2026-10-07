import { LEAD_SESSION_ID, isLeadSession, type ClientMessage, type ServerMessage, type TeamView, type TeamMemberHandback } from "../../shared/protocol.js";
import { fromTeamMemberHandback, type ActiveMemberInput } from "../../shared/control.js";
import { createTakeTabTool, TabControl } from "./tab-control.js";
import { ToolRpc } from "./rpc.js";
import { BrowserAgentSession, type SessionCreateOptions } from "./session.js";
import { createBrowserTools } from "./tools.js";
import type { MemoryStore } from "./memory-store.js";
import type { TaskHistoryStore } from "./task-history.js";
import { routeOfTask } from "./route-replay.js";

const log = (message: string) => console.error(`[sideagent] ${message}`);

export async function createConversationRuntime(
  conversationId: string,
  emit: (msg: ServerMessage) => void,
  modelPattern?: string,
  options?: Pick<SessionCreateOptions, "customTools" | "loop" | "fallbackModelPattern" | "onModelFailover" | "artifactPersistence"> & { memoryStore?: MemoryStore; taskHistory?: TaskHistoryStore },
) {
  const sendCurrent = (msg: ServerMessage) => emit({ ...msg, conversationId });
  const rpc = new ToolRpc((frame) => sendCurrent(frame));

  const control = new TabControl(rpc);
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
      onModelFailover: (from, to) => {
        options?.onModelFailover?.(from, to);
        void toolSession?.availableModels().then(models => sendCurrent({ type: "model_info", model: to, models }));
      },
      customTools: [...createBrowserTools(rpc, undefined, tabId => control.takeTab(tabId), name => toolSession?.isToolActive(name === "worker_tabs" ? "take_tab" : name) ?? false, { releaseIdleTab: tabId => control.releaseIdleForeignTab(tabId), epoch: () => toolSession?.executionEpoch() ?? 0, canWrite: (toolCallId?:string) => toolSession?.canWriteCurrentInput(toolCallId) ?? false, assertCall: (name, params, toolCallId) => toolSession?.assertTaskResultExecution(name, params, toolCallId), onStep: step => toolSession?.observeProgramStep(step), files: () => toolSession?.fileStore(), attachments: () => toolSession?.userAttachments() ?? [], memoryForValue: value => toolSession?.memoryForValue(value), noteRouteStep: note => toolSession?.noteRouteStep(note), noteRouteFollowed: source => toolSession?.noteRouteFollowed(source), routeOf: options?.taskHistory ? id => routeOfTask(options.taskHistory, id) : undefined, checkRoute: input => toolSession ? toolSession.checkRouteBeforeSubmit(input) : Promise.reject(new Error("会话不可用")), askedNow: () => toolSession?.askedThisTime() ?? [] }, (blocks, language, signal, meta) => { if (!toolSession) throw new Error("翻译会话不可用");

 return toolSession.translatePageBatch(blocks, language, signal, meta); }), ...(options?.customTools ?? []), createTakeTabTool(control)],
    },
  );

  toolSession = session;
  rpc.beforeCall = () => session.flushPersistence();
  control.attachLead(session);

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
        control.abortTeam();
        sendCurrent({ type: "status", state: "idle" });
        {
          const aborted = control.teamView();

          if (aborted) sendCurrent({ type: "team_status", team: aborted });
        }

        break;
      case "takeover": {
        const frozen = frozenMembersFromTakeover(msg);

        if (frozen.length === 0 && !session.isHeld() && !control.isGroupHeld()) {
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
          team = control.holdActiveGroup(frozen.length > 0 ? frozen : undefined, {
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
          const message: Extract<ServerMessage, { type: "status" }> = { type: "status", state: "user" };

          if (!isLeadSession(member.sessionId)) message.sessionId = member.sessionId;
          sendCurrent(message);
        }

        break;
      }

      case "handback": {
        const held = session.isHeld() || control.isGroupHeld();

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
            team: control.teamView() ?? undefined,
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
            const message: Extract<ServerMessage, { type: "status" }> = { type: "status", state: member.phase === "restored" ? "running" : member.phase === "aborted" ? "idle" : "user" };

            if (!isLeadSession(member.sessionId)) message.sessionId = member.sessionId;
            sendCurrent(message);
          }
        };

        void control
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

          });
        break;
      }

      case "set_model":
        void handleSetModel(msg.model);
        break;
      case "retry_after_error":
        if (!session.retryAfterModelError()) sendCurrent({ type: "agent_event", event: { kind: "notice", message: "没有要接着做的出错任务：任务已经在跑，或已经结束。" } });
        break;
      case "tool_result":
        rpc.handleResult(msg.id, msg.ok, msg.data, msg.error, msg.executionFact);
        break;
      default:
        break;
    }
  };

  return { session, control, rpc, handleMessage, dispose() { session.dispose(); } };
}

function frozenMembersFromTakeover(msg: Extract<ClientMessage, { type: "takeover" }>): ActiveMemberInput[] {
  return (msg.members ?? []).map((member) => ({
    sessionId: member.sessionId, role: member.role, activity: member.activity ?? "running",
    tabId: member.tabId, title: member.title, url: member.url,
  }));
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
