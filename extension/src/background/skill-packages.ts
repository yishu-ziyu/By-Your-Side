import type { ClientMessage, ServerMessage } from "../../../shared/protocol.js";
import { isSkillPackageRunMessage, SKILL_PACKAGES_KEY, sanitizeSkillPackageConfigs } from "../../../shared/skill-packages.js";

interface Options {
  conversationForWindow: (windowId: number | undefined) => string;
  send: (message: ClientMessage) => boolean;
}

type RunResult = Extract<ServerMessage, { type: "skill_operation_run_result" }>;
interface PendingRun {
  respond: (message: RunResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function installSkillPackages({ conversationForWindow, send }: Options): { receive: (message: ServerMessage) => boolean } {
  const pending = new Map<string, PendingRun>();

  function receive(message: ServerMessage): boolean {
    if (message.type !== "skill_operation_run_result") return false;
    const run = pending.get(message.requestId);
    // 侧栏自己发起的运行不在这里登记，仍要送回侧栏。
    if (!run) return false;
    pending.delete(message.requestId);
    clearTimeout(run.timer);
    run.respond(message);
    return true;
  }

  chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    if (!isSkillPackageRunMessage(raw) || sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id == null) return;
    const tabId = sender.tab.id;
    const requestId = crypto.randomUUID();
    const conversationId = conversationForWindow(sender.tab.windowId);
    void (async () => {
      const [stored, tab] = await Promise.all([chrome.storage.local.get(SKILL_PACKAGES_KEY), chrome.tabs.get(tabId)]);
      const config = sanitizeSkillPackageConfigs(stored[SKILL_PACKAGES_KEY])[raw.id];
      if (!config?.pageButton || !tab.url || new URL(tab.url).origin !== config.site || new URL(tab.url).origin !== new URL(sender.url ?? tab.url).origin) {
        respond({ type: "skill_operation_run_result", requestId, ok: false, error: "这个网页入口已停用，请刷新页面。" } satisfies RunResult);
        return;
      }
      const message: ClientMessage = { type: "skill_operation_run", requestId, id: raw.id, input: config.input, tabId, conversationId };
      const timer = setTimeout(() => {
        pending.delete(requestId);
        respond({ type: "skill_operation_run_result", requestId, ok: false, error: "运行超时，请再试一次。" } satisfies RunResult);
      }, 60_000);
      pending.set(requestId, { respond, timer });
      for (const end = Date.now() + 5_000; Date.now() < end; await new Promise(done => setTimeout(done, 200))) {
        if (send(message)) return;
      }
      pending.delete(requestId);
      clearTimeout(timer);
      respond({ type: "skill_operation_run_result", requestId, ok: false, error: "助手没连上，请再试一次。" } satisfies RunResult);
    })().catch((cause: unknown) => {
      const run = pending.get(requestId);
      if (run) { pending.delete(requestId); clearTimeout(run.timer); }
      respond({ type: "skill_operation_run_result", requestId, ok: false, error: cause instanceof Error ? cause.message : String(cause) } satisfies RunResult);
    });
    return true;
  });

  return { receive };
}
