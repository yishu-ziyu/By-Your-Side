import { LEAD_SESSION_ID, isLeadSession, type ClientMessage, type FileAttachment, type ServerMessage, type TeamView, type TeamMemberHandback } from "../../shared/protocol.js";
import { fromTeamMemberHandback, type ActiveMemberInput } from "../../shared/control.js";
import { createTakeTabTool, TabControl } from "./tab-control.js";
import { ToolRpc } from "./rpc.js";
import { BrowserAgentSession, type SessionCreateOptions } from "./session.js";
import { createBrowserTools } from "./tools.js";
import { defineTool } from "./define-tool.js";
import { Type } from "typebox";
import type { MemoryStore } from "./memory-store.js";
import type { TaskHistoryStore } from "./task-history.js";
import type { LearnedOperationStore } from "./learned-operations.js";
import { isWaitCondition } from '../../shared/task-continuation.js';
import type { ConditionRegistration } from './task-continuation.js';

const log = (message: string) => console.error(`[sideagent] ${message}`);

export async function createConversationRuntime(
  conversationId: string,
  emit: (msg: ServerMessage) => void,
  modelPattern?: string,
  options?: Pick<SessionCreateOptions, "customTools" | "loop" | "fallbackModelPattern" | "onModelFailover" | "artifactPersistence" | "continuationEnabled"> & { memoryStore?: MemoryStore; taskHistory?: TaskHistoryStore; learnedOperations?: LearnedOperationStore; miniApps?: () => Promise<boolean>; translationStyle?: () => string; readDownloadedFile?: (input: { id: string; name: string; mimeType: string; dataBase64: string }) => Promise<FileAttachment> },
) {
  const sendCurrent = (msg: ServerMessage) => emit({ ...msg, conversationId });
  const rpc = new ToolRpc((frame) => sendCurrent(frame));

  const control = new TabControl(rpc);
  let toolSession: BrowserAgentSession | undefined;
  // 交给用户：走与侧栏「接管」相同的暂停通道，宿主接线后才可用。
  let handToUser: ((ask: string, targets?: string[]) => Promise<void>) | undefined;
  let waitForCondition: ((input: ConditionRegistration) => Promise<unknown>) | undefined;
  const conditionTool = defineTool({
    name: 'wait_for_condition', label: '等待页面条件',
    description: 'Save a finite delegation on the ORIGINAL page and end this execution fragment. Use only when the user asked to wait for results or watch new results. No model runs while waiting. Choose an observed stable UNIQUE native CSS selector or a current @ref; the host resolves refs to a unique stable id/test attribute and persists only that locator. Generic code and whole-page changed conditions are refused. The host rereads without navigation, scrolling, focus or clicks. When the condition holds, the SAME goal resumes automatically, limited to reading, analysis and marking that page. mode=watch requires explicit finite ongoing attention; durationMs reflects the user deadline, maximum one hour; absent a duration use 300000. For new list items use changed on a stable container; process only new stable item identities and preserve prior marks. Do currently executable work before waiting. Do not claim completion.',
    parameters: Type.Object({
      condition: Type.Object({ target: Type.String(), property: Type.Union(['exists','text','value','enabled','checked','visible'].map(v => Type.Literal(v))), operator: Type.Union(['equals','contains','changed'].map(v => Type.Literal(v))), expected: Type.Optional(Type.Union([Type.String(), Type.Boolean()])), goalItem: Type.String(), description: Type.String() }),
      mode: Type.Union([Type.Literal('once'), Type.Literal('watch')]), durationMs: Type.Integer({ minimum: 1000, maximum: 3600000 }),
    }),
    execute: async (_id, params) => {
      let condition = params.condition;
      if (/^@\d+$/.test(condition.target)) {
        const read = await rpc.call('read_element', { target: condition.target, properties: ['visible'] });
        const stable = read && typeof read === 'object' && 'persistentTarget' in read ? read.persistentTarget : undefined;
        if (typeof stable !== 'string' || stable.length > 1000) throw new Error('这个快照目标没有稳定定位，不能持续关注。请用 read_elements 找到明确结果容器或状态字段的唯一定位。');
        condition = { ...condition, target: stable };
      }
      if (!waitForCondition || !isWaitCondition(condition)) throw new Error('等待条件无效。请选择明确的状态字段或结果容器，使用唯一 CSS 定位；整页变化不能证明条件成立。');
      const saved = await waitForCondition({ condition, mode: params.mode, durationMs: params.durationMs });
      return { content: [{ type: 'text' as const, text: '等待条件已保存。当前执行片段结束；条件满足后宿主自动续做，不要保持循环或声称目标完成。' }], details: saved, terminate: true };
    },
  });

  const handToUserTool = defineTool({
    name: "hand_to_user",
    label: "Hand the page to the user",
    description: "Hand the page to the user for a step only they can do: login, captcha, 2FA, payment authorization, or card number / expiry / security code fields. Never type those values yourself. Pass targets for the fields and the button the user must use; they are circled on the page. This pauses the task and ends your turn; when the user hands the page back you get their current page and continue the original task from there.",
    parameters: Type.Object({
      ask: Type.String({ description: "One plain sentence in the user's language: exactly what to do on the page and which button to press (at most 120 characters)." }),
      targets: Type.Optional(Type.Array(Type.String(), { description: "The fields the user must fill, in order, then the button to press (up to 6; extra ones are not circled). Same locators as click: @N ref from the latest snapshot, loc=..., or CSS." })),
    }),
    execute: async (_id, params) => {
      const ask = String(params.ask ?? "").trim().slice(0, 120);
      // 圈不上不挡交还：格式不对的目标直接丢掉，不报错。
      const targets = (Array.isArray(params.targets) ? params.targets : []).map(t => String(t ?? "").trim()).filter(t => t && t.length <= 200).slice(0, 6);

      if (!ask) throw new Error("ask 不能为空：写清用户要在页面上做什么。");

      if (!handToUser) throw new Error("现在不能把页面交给用户。");
      await handToUser(ask, targets);

      return { content: [{ type: "text" as const, text: "The page is now the user's. Stop here; you will get the page back after the user hands it back." }], details: { ask }, terminate: true };
    },
  });

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
      customTools: [...createBrowserTools(rpc, undefined, tabId => control.takeTab(tabId), name => toolSession?.isToolActive(name === "worker_tabs" ? "take_tab" : name) ?? false, { releaseIdleTab: tabId => control.releaseIdleForeignTab(tabId), epoch: () => toolSession?.executionEpoch() ?? 0, canWrite: (toolCallId?:string) => toolSession?.canWriteCurrentInput(toolCallId) ?? false, assertCall: (name, params, toolCallId) => toolSession?.assertTaskResultExecution(name, params, toolCallId), onStep: step => toolSession?.observeProgramStep(step), beforeCopy: async () => toolSession ? toolSession.prepareCopyCheck() : {record() {}}, files: () => toolSession?.fileStore(), attachments: () => toolSession?.userAttachments() ?? [], downloadAttachment: async input => { if (!toolSession || !options?.readDownloadedFile) throw new Error("当前会话不能读取下载文件"); const attachment = await options.readDownloadedFile(input); return toolSession.rememberDownloadedAttachment(attachment, input.dataBase64); }, downloadOriginal: attachment => toolSession?.downloadedOriginal(attachment), memoryForValue: value => toolSession?.memoryForValue(value), siteNotesFor: url => toolSession?.siteNotesFor(url) ?? Promise.resolve(null), openForUser: () => toolSession?.userAskedToOpen() ?? false, observeCall: (name, params, result) => toolSession?.observeBrowserCall(name, params, result), learnedOperations: { save: (candidate, runtime) => toolSession!.saveLearnedOperation(candidate, runtime), run: (id, input, runtime) => toolSession!.runSavedLearnedOperation(id, input, runtime), delete: (id, runtime) => toolSession!.deleteLearnedOperation(id, runtime) } }, (blocks, language, signal, meta) => { if (!toolSession) throw new Error("翻译会话不可用");

 return toolSession.translatePageBatch(blocks, language, signal, meta); }), ...(options?.customTools ?? []), createTakeTabTool(control), handToUserTool, conditionTool],
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
          msg.spoken ? { spoken: true } : undefined,
        );
        break;
      case "steer":
        session.steer(msg.text, msg.context, msg.attachments, msg.spoken === true);
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

      case "page_translate":
        if (msg.context) void session.togglePageTranslation(msg.context);
        break;
      case "set_model":
        void handleSetModel(msg.model);
        break;
      case "retry_after_error":
        // 倒计时自己发的重试落空（任务已在跑或已结束）时不提示：用户没有点任何东西。
        if (!session.retryAfterModelError(msg.auto ? "automatic" : "user") && !msg.auto) sendCurrent({ type: "agent_event", event: { kind: "notice", message: "没有要接着做的出错任务：任务已经在跑，或已经结束。" } });
        break;
      case "tool_result":
        rpc.handleResult(msg.id, msg.ok, msg.data, msg.error, msg.executionFact);
        break;
      case "tool_waiting_user":
        rpc.waitingForUser(msg.id, msg.waiting);
        // 侧栏据此写「第 N 步 · 等你操作」，或出发送确认卡。
        sendCurrent({ type: "agent_event", event: msg.guide ? { kind: "guide_wait", waiting: msg.waiting, guide: msg.guide } : { kind: "send_confirm_wait", waiting: msg.waiting, ...(msg.send ? { confirm: msg.send } : {}) } });
        break;
      default:
        break;
    }
  };

  return { session, control, rpc, handleMessage, onWaitForCondition(fn: (input: ConditionRegistration) => Promise<unknown>) { waitForCondition = fn; }, onHandToUser(fn: (ask: string, targets?: string[]) => Promise<void>) { handToUser = fn; }, dispose() { session.dispose(); } };
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
