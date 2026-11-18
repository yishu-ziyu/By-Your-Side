import { Type } from "typebox";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { HELD_BY_OTHER_TASK_ERROR } from "../../shared/control.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";
import { emailStepIsNext, gaveUpWithoutChange, type GoalVerdict } from "./goal-verdict.js";

const GOAL_CONTINUE_MAX = 3;
const GOAL_CONTINUE_WITHIN_MS = 2 * 60_000;

type RunContext = {
  runId: string | null;
  snapshot: TaskProgressSnapshot | null;
  goal: string;
  failed: readonly { tool: string; reason: string }[];
  progress?: number;
  stoppedForNoProgress?: boolean;
};
type Continuation = { prompt: string } | { settle: Exclude<GoalVerdict["status"], "continue">; overBudget?: true };

const REPAIR_READS = new Set(["snapshot", "read_element", "read_elements", "read_attachment", "answer_ui_guide", "send_user_message"]);
const REPAIR_COMMANDS = new Map<string, { field: string; values: string[]; argument: string; description: string }>([
  ["tabs", { field: "action", values: ["list", "active"], argument: "url", description: "List open tabs (url optionally filters by host) or read the active tab." }],
  ["artifacts", { field: "command", values: ["get"], argument: "filename", description: "Read the named file from this conversation." }],
]);

export function allowsGoalRepairTool(name: string, params: Record<string, unknown>): boolean {
  const command = REPAIR_COMMANDS.get(name);
  if (!command) return REPAIR_READS.has(name);
  const value = params[command.field];
  return typeof value === "string" && command.values.includes(value);
}

export function goalRepairMessages(messages: Message[], active: readonly string[]): Message[] {
  const offered = (tool: { name: string }) => active.includes(tool.name) && (REPAIR_READS.has(tool.name) || REPAIR_COMMANDS.has(tool.name));
  const readDeclaration = (tool: Tool): Tool => {
    const command = REPAIR_COMMANDS.get(tool.name);
    if (!command) return tool;
    const argument = command.argument === "url" ? Type.Optional(Type.String()) : Type.String();
    const parameters = Type.Object({ [command.field]: Type.String({ enum: command.values }), [command.argument]: argument });
    return { ...tool, description: command.description, parameters };
  };

  return messages.map(message => message.role !== "system" ? message : {
    ...message,
    ...(message.toolsAdded && { toolsAdded: message.toolsAdded.filter(offered).map(readDeclaration) }),
    ...(message.toolsRemoved && { toolsRemoved: message.toolsRemoved.filter(offered) }),
  });
}

export class ContinuePolicy {
  private runId: string | null = null;
  private attempts = 0;
  private lastProgress = 0;
  private startedAt: number | null = null;
  private evidence: { scope: string; seen: Set<string> } | null = null;
  private nudgePage: { runId: string | null; page: string } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  reset(): void {
    this.runId = null; this.attempts = 0; this.lastProgress = 0; this.startedAt = null; this.evidence = null; this.nudgePage = null;
  }

  mayCheck(runId: string): boolean {
    return this.runId !== runId || this.attempts <= GOAL_CONTINUE_MAX;
  }

  beforeCheck(input: { runId: string | null; reply: string; partial: boolean; pageNow: string | null; pageText: string; goalPage: TaskProgressSnapshot["goalPage"]; progress?: number }, observe?: (rule: string, facts: Record<string, unknown>) => void): GoalVerdict | null {
    const pageAtNudge = this.nudgePage?.runId === input.runId ? this.nudgePage.page : null;
    const hash = (page: string | null) => page === null ? null : createHash("sha256").update(page).digest("hex");
    if ((input.progress ?? 0) <= this.lastProgress && gaveUpWithoutChange({ ...input, pageAtNudge })) {
      observe?.("gave_up_without_change", { partial: input.partial, pageUnchanged: true, pageAtNudgeSha: hash(pageAtNudge), pageNowSha: hash(input.pageNow) });
      return { status: "open", remaining: null, cause: "gave_up_page_unchanged" };
    }
    if (!emailStepIsNext(input.pageText, input.reply)) return null;
    observe?.("email_step", { goalPage: input.goalPage ?? null });
    return { status: "needs_user", remaining: "查收确认邮件，再告诉我是否继续" };
  }

  seenEvidence(scope: string, fingerprint: string): boolean {
    if (this.evidence?.scope !== scope) this.evidence = { scope, seen: new Set() };
    return this.evidence.seen.has(fingerprint);
  }

  next(verdict: GoalVerdict, ctx: RunContext): Continuation {
    this.selectRun(ctx.runId);
    if (verdict.status !== "continue") return { settle: verdict.status };
    if (ctx.failed.some(item => item.reason.startsWith(HELD_BY_OTHER_TASK_ERROR))) return { settle: "open" };
    if (ctx.stoppedForNoProgress) return { settle: "open" };
    const progress = ctx.progress ?? 0;
    if (progress > this.lastProgress) { this.attempts = 0; this.startedAt = null; }
    this.lastProgress = progress;
    const elapsed = this.startedAt === null ? 0 : this.now() - this.startedAt;
    const withinBudget = verdict.repair === "ask_user" || elapsed < GOAL_CONTINUE_WITHIN_MS;
    if (this.attempts >= GOAL_CONTINUE_MAX || !withinBudget) return { settle: "open", ...(!withinBudget ? { overBudget: true } : {}) };
    const { snapshot } = ctx;
    if (verdict.repair === "ask_user") return { prompt: "[GOAL CHECK] The user pointed at something on the page they were on. The host observed that you acted elsewhere. Rewrite your answer only. Say what you could not find on that page and ask whether the user wants you to try another way." };
    const asked = (snapshot?.recoveryInput?.requirements?.length ? snapshot.recoveryInput.requirements : [ctx.goal]).filter(Boolean);
    const request = asked.length ? ` The user's request: ${JSON.stringify(asked)}.` : "";
    const evidence = verdict.verificationSubject === "answer" && !verdict.verifiedByHost ? " The finding was not verified against the page." : "";
    return { prompt: `[GOAL CHECK] Review your last result against the user's request and the observations you already have.${request}${evidence} You may read the open pages again and correct your answer. The host permits only reading and replying during this check. Preserve completed work. If something still requires changing a page or file, state what is incomplete and tell the user they can ask you to continue.` };
  }

  started(runId: string | null, fingerprint: string | null, pageNow: string | null): number {
    this.selectRun(runId);
    this.attempts += 1;
    this.startedAt ??= this.now();
    if (fingerprint) this.evidence?.seen.add(fingerprint);
    this.nudgePage = pageNow ? { runId, page: pageNow } : null;
    return this.attempts;
  }

  private selectRun(runId: string | null): void {
    if (runId && this.runId !== runId) { this.runId = runId; this.attempts = 0; this.startedAt = null; this.lastProgress = 0; }
  }
}
