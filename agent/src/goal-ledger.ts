import { redactCredentialText } from "../../shared/untrusted.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";
import { GOAL_CHECK_BOOKKEEPING_TOOLS, newReadIndex, readWords, type GoalCheckInput, type GoalVerificationTarget } from "./goal-check.js";

type Failure = { tool: string; reason: string };
type GoalRun = {
  snapshot: TaskProgressSnapshot | null;
  goal: string;
  requestStartedAt: number;
  copies: GoalCheckInput["copies"];
  files: GoalCheckInput["files"];
  lastReply: string;
  tabId: number | null;
  page: { text?: unknown; url?: unknown; title?: unknown; translation?: unknown } | null;
  userTookOver: boolean;
};

function firstFailureText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  for (const block of result.content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") return block.text.slice(0, 500);
  }
  return "";
}

export class GoalLedger {
  private observations: Array<{ at: number; tool: string; text: string }> = [];
  private readonly words = newReadIndex();
  private elementReads: { scope: string; targets: GoalVerificationTarget[] } | null = null;
  private failures: { runId: string | null; items: Failure[] } = { runId: null, items: [] };

  /** Keep earlier page facts across follow-ups; recent tools must not evict the pages they act on. */
  record(tool: string, text: string): void {
    if (tool.startsWith("page_") && text.includes("is unchanged since your earlier observation")) return;
    const all = [...this.observations, { at: Date.now(), tool, text: redactCredentialText(text.slice(0, 8_000)) + (text.length > 8_000 ? "\n[truncated tool result]" : "") }];
    readWords(redactCredentialText(text), this.words);
    const pages = all.filter(item => item.tool.startsWith("page_")).slice(-2);
    const tools = all.filter(item => !item.tool.startsWith("page_")).slice(-6);
    this.observations = all.filter(item => pages.includes(item) || tools.includes(item));
  }

  restore(messages: ReadonlyArray<{ role: string; content?: unknown }>): void {
    for (const message of messages) {
      if (message.role !== "toolResult" && message.role !== "user") continue;
      const content = message.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.map((part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("\n") : "";
      // A correction prompt can name unsupported people; replaying it must not turn those names into source evidence.
      if (text && !text.startsWith("[GOAL CHECK]")) readWords(redactCredentialText(text), this.words);
    }
  }

  recordFailure(runId: string | null, tool: string, isError: boolean, result: unknown): void {
    if (GOAL_CHECK_BOOKKEEPING_TOOLS.has(tool)) return;
    const details = result && typeof result === "object" && "details" in result ? result.details : null;
    const readiness = details && typeof details === "object" && "readiness" in details ? details.readiness : null;
    const raw = isError ? firstFailureText(result) : readiness === "timeout" ? "page did not finish loading (document timeout)" : readiness === "error_page" ? "page did not open (Chrome error page)" : null;

    if (raw === null) return;
    // Page text can carry instructions. Only the short error prefix belongs in the next attempt's guidance.
    const reason = (raw.split(/<page-content|<\/?untrusted/i)[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "failed";
    if (this.failures.runId !== runId) this.failures = { runId, items: [] };
    const items = this.failures.items.filter(item => item.tool !== tool || item.reason !== reason);
    items.push({ tool, reason });
    this.failures.items = items.slice(-6);
  }

  failuresFor(runId: string | null): readonly Failure[] {
    return this.failures.runId === runId ? this.failures.items : [];
  }

  recordElementRead(scope: string, probe: GoalVerificationTarget): void {
    const previous = this.elementReads?.scope === scope ? this.elementReads.targets : [];
    this.elementReads = { scope, targets: [...previous.filter(item => item.tabId !== probe.tabId || item.target !== probe.target), probe].slice(-4) };
  }

  targets(scope: string): readonly GoalVerificationTarget[] {
    return this.elementReads?.scope === scope ? this.elementReads.targets : [];
  }

  input(run: GoalRun): GoalCheckInput {
    const { snapshot, page, tabId } = run;
    return {
      copies: run.copies,
      goal: snapshot?.recoveryInput?.requirements?.length ? snapshot.recoveryInput.requirements : [run.goal],
      goalPage: snapshot?.goalPage ?? null,
      files: run.files,
      observations: this.observations.map(item => ({ tool: item.tool, text: item.text, ...(item.at < run.requestStartedAt ? { earlier: true } : {}) })),
      readWords: this.words,
      lastReply: run.lastReply,
      page: page ? { ...(tabId === null ? {} : { tabId }), title: String(page.title ?? ""), url: String(page.url ?? ""), ...(page.translation ? { translation: page.translation } : {}), text: redactCredentialText(String(page.text ?? "")) } : null,
      userTookOver: run.userTookOver,
    };
  }
}
