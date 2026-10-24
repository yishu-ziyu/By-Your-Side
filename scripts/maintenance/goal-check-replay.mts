/**
 * 用真实快速模型重放标注集里的核对输入；不参与任务恢复或交接。
 * 终端只写 checkId、结论、用时和比例，不写用户原话、网址或标题。
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider, InMemoryCredentialStore, type Api, type Credential, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { GOAL_CHECK_PROMPT, GOAL_CHECK_PROMPT_SHA, parseGoalCheckReply } from "../../agent/src/goal-check.ts";
import { SideCallError, sideJudgment, type SideCallHost } from "../../agent/src/side-judgment.ts";
import { unlistedModel, withMeasuredCapability } from "../../shared/model-capabilities.ts";
import { GOAL_CHECK_FORMAT_SUFFIX } from "../../shared/trace-sanitize.ts";
import { loadModelPlan } from "../acceptance/real-path/inproc-config.mts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).trim();
const main = dirname(resolve(repo, common));
const out = join(main, "out");
const args = process.argv.slice(2);
const arg = (name: string) => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const setFile = resolve(arg("set") ?? join(out, "goal-check-set.json"));
const output = resolve(arg("out") ?? join(out, "goal-check-replay.json"));
const count = Math.max(1, Number(arg("count") ?? 10));
const repetitions = Math.max(1, Number(arg("runs") ?? 3));
const modelOverride = arg("model");
const ids = arg("ids")?.split(",").filter(Boolean);

type Label = { verdict: string; reason: string };
type Row = {
  checkId: string;
  promptSha: string | null;
  model: string | null;
  effort: string | null;
  maxTokens: number | null;
  input: string | null;
  decidedBy: string;
  canReplay: boolean;
  label: Label | null;
};
type ReplayRow = {
  checkId: string;
  model: string;
  promptSource: string;
  runs: Array<{ status: string; ms: number; effort: string | null; detail?: string }>;
  consistent: boolean;
  label: Label | null;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const promptFiles = new Map<string, string>();
function indexPrompts(root: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) indexPrompts(path);
    else if (entry.isFile() && /^[a-f0-9]{64}\.txt$/.test(entry.name)) promptFiles.set(entry.name, path);
  }
}
indexPrompts(join(homedir(), ".sideagent/traces"));
indexPrompts(join(out, "daily-logs"));
indexPrompts(join(out, "self-use"));
indexPrompts(join(out, "goal-check-prompts"));

function promptFor(row: Row): { text: string; source: string } {
  if (args.includes("--current-prompt")) return { text: GOAL_CHECK_PROMPT, source: "current" };
  const file = row.promptSha ? promptFiles.get(`${row.promptSha}.txt`) : undefined;
  if (file) {
    const text = readFileSync(file, "utf8");
    if (sha(text) === row.promptSha) return { text, source: file };
  }
  if (row.promptSha === GOAL_CHECK_PROMPT_SHA) return { text: GOAL_CHECK_PROMPT, source: "current" };
  const retryPrompt = GOAL_CHECK_PROMPT + GOAL_CHECK_FORMAT_SUFFIX;
  if (row.promptSha === sha(retryPrompt)) return { text: retryPrompt, source: "current+format-retry" };
  throw new Error(`找不到事件 ${row.checkId} 记下的提示词`);
}

const parsed: unknown = JSON.parse(readFileSync(setFile, "utf8"));
const all = parsed && typeof parsed === "object" && "rows" in parsed && Array.isArray(parsed.rows) ? parsed.rows as Row[] : [];
const selected = (ids ? ids.map(id => all.find(row => row.checkId === id)) : all.filter(row => row.canReplay && row.decidedBy === "model").slice(-count));
if (selected.some(row => !row || !row.canReplay || row.decidedBy !== "model" || !row.input || !row.model)) throw new Error("只能重放有完整 input 且 decidedBy=model 的事件；请检查 --ids");
const rows = selected as Row[];
if (!rows.length) throw new Error("没有可重放的模型核对事件");
if (rows.some(row => !row.promptSha || !row.input || !row.model)) throw new Error("重放事件缺 promptSha、input 或 model");

const efforts: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const runtimes = new Map<string, { host: SideCallHost; model: Model<Api> }>();
async function runtimeFor(pattern: string) {
  const cached = runtimes.get(pattern);
  if (cached) return cached;
  const plan = await loadModelPlan(pattern);
  const credential: Credential = plan.credential.type === "api_key" && typeof plan.credential.key === "string"
    ? { type: "api_key", key: plan.credential.key }
    : plan.credential.type === "oauth" && typeof plan.credential.access === "string" && typeof plan.credential.refresh === "string" && typeof plan.credential.expires === "number"
      ? { type: "oauth", access: plan.credential.access, refresh: "", expires: plan.credential.expires, ...(typeof plan.credential.accountId === "string" ? { accountId: plan.credential.accountId } : {}) }
      : (() => { throw new Error(`${pattern} 的凭据形状不支持`); })();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(plan.providerId, async () => credential);
  const models = builtinModels({ credentials });
  const listed = models.getModel(plan.providerId, plan.modelId);
  let model = listed ? withMeasuredCapability(listed) : unlistedModel(plan.providerId, plan.modelId, models.getModels(plan.providerId));
  if (plan.baseUrl || plan.providerId === "custom" || plan.providerId === "stepfun") {
    const baseUrl = plan.baseUrl ?? (plan.providerId === "stepfun" ? "https://api.stepfun.com/step_plan/v1" : model?.baseUrl);
    if (!baseUrl) throw new Error(`${pattern} 没有可用地址`);
    model = {
      ...(model ?? withMeasuredCapability({ id: plan.modelId, name: plan.modelId, api: "openai-completions", provider: plan.providerId, baseUrl,
        reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 })),
      api: "openai-completions", baseUrl,
    };
    models.setProvider(createProvider({ id: plan.providerId, baseUrl,
      auth: { apiKey: { name: "API key", resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "本机登录" } : undefined } },
      models: [model], api: openAICompletionsApi() }));
  }
  if (!model) throw new Error(`找不到模型 ${pattern}`);
  const sessionId = randomUUID();
  const value = { host: { models: { completeSimple: (current: Model<Api>, context: Parameters<SideCallHost["models"]["completeSimple"]>[1], options: Parameters<SideCallHost["models"]["completeSimple"]>[2]) => models.completeSimple(current, context, {
    ...options,
    ...(current.api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
    ...(current.provider === "opencode" || current.provider === "opencode-go" || current.baseUrl.includes("opencode.ai")
      ? { headers: { ...options?.headers, "x-opencode-session": sessionId, "x-opencode-client": "by-your-side" } } : {}),
  }) } }, model };
  runtimes.set(pattern, value);
  return value;
}

const results: ReplayRow[] = [];
for (const row of rows) {
  const prompt = promptFor(row);
  const { host, model } = await runtimeFor(modelOverride ?? row.model!);
  const result: ReplayRow = { checkId: row.checkId, model: modelOverride ?? row.model!, promptSource: prompt.source, runs: [], consistent: false, label: row.label };
  for (let index = 0; index < repetitions; index++) {
    const started = Date.now();
    let effort: string | null = null;
    let detail: string | undefined;
    try {
      const reply = await sideJudgment(host, model, {
        purpose: "goal_check_replay",
        systemPrompt: prompt.text,
        content: row.input!,
        maxTokens: row.maxTokens ?? 1600,
        timeoutMs: 20_000,
        signal: AbortSignal.timeout(25_000),
        ...(efforts.includes(row.effort as ModelThinkingLevel) ? { effort: row.effort as ModelThinkingLevel } : {}),
        onRecord: line => { effort = line.effort; detail = line.detail; },
        parse: parseGoalCheckReply,
      });
      result.runs.push({ status: reply.status, ms: Date.now() - started, effort, ...(detail ? { detail } : {}) });
    } catch (error) {
      result.runs.push({ status: error instanceof SideCallError ? `unavailable:${error.reason}` : "unavailable:error", ms: Date.now() - started, effort, ...(detail ? { detail } : {}) });
    }
  }
  const statuses = result.runs.map(run => run.status);
  result.consistent = statuses.length === repetitions && statuses.every(status => status === statuses[0] && !status.startsWith("unavailable"));
  results.push(result);
  console.log(`${row.checkId}  ${statuses.join(" / ")}  ${result.runs.map(run => `${run.ms}ms`).join(" / ")}`);
}

const labeled = results.flatMap(result => result.label ? result.runs.map(run => ({ label: result.label!.verdict, status: run.status })) : []);
const agreed = labeled.filter(run => run.status === run.label).length;
const consistent = results.filter(result => result.consistent).length;
const report = {
  v: 1,
  generatedAt: new Date().toISOString(),
  set: setFile,
  repetitions,
  events: results.length,
  selfConsistency: { consistent, total: results.length, ratio: results.length ? consistent / results.length : null },
  labelAgreement: { matched: agreed, total: labeled.length, ratio: labeled.length ? agreed / labeled.length : null },
  rows: results,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`自一致 ${consistent}/${results.length}；标注一致 ${agreed}/${labeled.length}（只算有标注的调用）。`);
console.log(`重放结果：${output}`);
