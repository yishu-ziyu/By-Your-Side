import type { AnswerSourceMap } from "../../shared/answer-source.js";
import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";
import { answerMarkdown, splitAnswer } from "../../shared/answer-cards.js";
import type { ProgramStep } from "./browser-program.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";
import { GOAL_CHECK_BOOKKEEPING_TOOLS, newReadIndex, readWords, type GoalCheckInput, type GoalVerificationTarget } from "./goal-check.js";
import { PageTrail } from "./goal-facts.js";
import { citationEvidence } from './answer-sources.js';

/**
 * 核对看到的回答和用户在侧栏看到的一样：{=名字} 换成卡片算出的数，卡片换成文字。
 * 原始标记里的 {=h30}、<input> 在核对模型眼里是「没算出来的占位符」「只描述了输入框」，会误判没做完、再跑几轮。
 */
const replyAsShown = (text: string, sources?: AnswerSourceMap): string => answerMarkdown(text, sources);

/** 回答里带输入项的卡片：画在侧栏的回答里，用户在那里改数、卡片即时重算。核对不知道这一点时会去网页上找这个工具，找不到就判没交付。 */
function replyCards(text: string): NonNullable<GoalCheckInput["replyCards"]> {
  return splitAnswer(text).flatMap(part => ("card" in part && part.card ? [part.card] : []))
    .map(card => ({ title: card.title, inputs: card.blocks.flatMap(block => (block.kind === "inputs" ? block.items.map(item => item.label) : [])) }))
    .filter(card => card.inputs.length);
}

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
  constructor(private readonly sources?: AnswerSourceMap) {}
  private observations: Array<{ at: number; tool: string; text: string }> = [];
  private readonly words = newReadIndex();
  private readonly programs = new Map<string, { reads: Array<{ url: string; text: string }>; readOnly: boolean }>();
  private elementReads: { scope: string; targets: GoalVerificationTarget[] } | null = null;
  private failures: { runId: string | null; items: Failure[] } = { runId: null, items: [] };
  private readonly trail = new PageTrail();
  private wholeSource: { url: string; text: string } | null = null;

  beginRequest(page: { tabId?: number; url?: string } | null): void {
    this.trail.begin(page);
    this.wholeSource = null;
  }

  recordWholeSource(url: string, text: string): void {
    this.wholeSource = { url, text: redactCredentialText(text) };
  }

  observeCall(name: string, params: Record<string, unknown>, result: unknown): void {
    this.trail.observe(name, params, result);
  }

  /** Keep earlier page facts across follow-ups; recent tools must not evict the pages they act on. */
  record(tool: string, text: string): void {
    if (tool.startsWith("page_") && text.includes("is unchanged since your earlier observation")) return;
    if (tool === "page_at_start") this.trail.noteStartPage(text);
    const all = [...this.observations, { at: Date.now(), tool, text: redactCredentialText(text.slice(0, 8_000)) + (text.length > 8_000 ? "\n[truncated tool result]" : "") }];
    readWords(redactCredentialText(text), this.words);
    const pages = all.filter(item => item.tool.startsWith("page_")).slice(-2);
    const tools = all.filter(item => !item.tool.startsWith("page_")).slice(-6);
    this.observations = all.filter(item => pages.includes(item) || tools.includes(item));
  }

  observeProgramStep(step: ProgramStep): void {
    if (step.phase !== 'end') return;
    if (!this.programs.has(step.parentId) && this.programs.size >= 32) this.programs.delete(this.programs.keys().next().value!);
    const program = this.programs.get(step.parentId) ?? { reads: [], readOnly: true };
    this.programs.set(step.parentId, program);
    const result = step.read;
    if (step.error || step.name !== 'navigate' || !result || typeof result !== 'object'
      || !('text' in result) || typeof result.text !== 'string'
      || !('url' in result) || typeof result.url !== 'string' || program.reads.length >= 8) {
      program.readOnly = false;
      return;
    }
    program.reads.push({ url: result.url, text: result.text });
  }

  /** Rebalance only source prefixes that the program actually returned; never replace computed results or write receipts. */
  recordProgramResult(id: string, text: string, result: unknown, failed: boolean): void {
    const program = this.programs.get(id);
    this.programs.delete(id);
    const details = result && typeof result === 'object' && 'details' in result ? result.details : null;
    const value = details && typeof details === 'object' && 'value' in details ? details.value : null;
    const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
    const values = entries.map(([, value]) => value);
    const used = new Set<number>();
    const sources: Array<{ key: string; url: string; text: string }> = [];
    if (!failed && text.length > 8_000 && program?.readOnly && values.length >= 2 && values.length <= 8) {
      for (const value of values) {
        if (typeof value !== 'string' || !value.trim()) break;
        const matches = program.reads.flatMap((read, index) => read.text.startsWith(value) ? [index] : []);
        if (matches.length !== 1 || used.has(matches[0]!)) break;
        const index = matches[0]!;
        used.add(index);
        sources.push({ key: entries[sources.length]![0], url: program.reads[index]!.url, text: redactCredentialText(value) });
      }
    }
    if (sources.length !== values.length || new Set(sources.map(source => source.url)).size < 2) {
      this.record('browser_run', text);
      return;
    }
    const marker = '\n[source excerpt truncated]';
    const prefixes = sources.map(source => `Result key: ${JSON.stringify(source.key)}\nSource URL: ${JSON.stringify(source.url)}\n`);
    let budget = 8_000 - prefixes.reduce((sum, prefix) => sum + prefix.length + wrapPageContent('').length + marker.length + 2, 0);
    if (budget < 1_000) { this.record('browser_run', text); return; }
    const shares = new Map<typeof sources[number], number>();
    const ordered = [...sources].sort((a, b) => a.text.length - b.text.length);
    for (const [index, source] of ordered.entries()) {
      const share = Math.min(source.text.length, Math.floor(budget / (ordered.length - index)));
      shares.set(source, share);
      budget -= share;
    }
    const balanced = sources.map((source, index) => {
      const length = shares.get(source)!;
      return wrapPageContent(prefixes[index] + source.text.slice(0, length) + (length < source.text.length ? marker : ''));
    }).join('\n\n');
    if (balanced.length > 8_000) { this.record('browser_run', text); return; }
    // The complete original result still feeds name provenance, independently of the display budget.
    readWords(redactCredentialText(text), this.words);
    this.record('browser_run', balanced);
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
    const goal = snapshot?.recoveryInput?.requirements?.length ? snapshot.recoveryInput.requirements : [run.goal];
    return {
      copies: run.copies,
      goal,
      goalPage: snapshot?.goalPage ?? null,
      facts: this.trail.facts(goal, snapshot?.goalPage ?? null),
      files: run.files,
      observations: this.observations.map(item => ({ tool: item.tool, text: item.text, ...(item.at < run.requestStartedAt ? { earlier: true } : {}) })),
      readWords: this.words,
      lastReply: replyAsShown(run.lastReply, this.sources),
      replyCards: replyCards(run.lastReply),
      sourceCitations: citationEvidence(run.lastReply, this.sources),
      wholeSource: this.wholeSource ?? undefined,
      replyForm: splitAnswer(run.lastReply).some(part => "card" in part && !!part.card?.blocks.some(block => block.kind === "fields")) || undefined,
      page: page ? { ...(tabId === null ? {} : { tabId }), title: String(page.title ?? ""), url: String(page.url ?? ""), ...(page.translation ? { translation: page.translation } : {}), text: redactCredentialText(String(page.text ?? "")) } : null,
      userTookOver: run.userTookOver,
    };
  }
}
