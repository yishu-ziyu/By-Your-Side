import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Api, Credential, InMemoryCredentialStore as CredentialStore, Model } from "@earendil-works/pi-ai";
import type { builtinModels as BuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { GoalCheckInput } from "../../agent/src/goal-check.ts";
import { REPO } from "../acceptance/real-path/harness.mts";
import { MAIN } from "./goal-check-labels.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan } from "../acceptance/real-path/inproc-config.mts";

type Status = "done" | "continue" | "needs_user" | "open" | "blocked";
type Label = { id: string; source: string; tags?: string[]; input: GoalCheckInput; recorded: string | null; expected: Status | null; reason: string };

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const labelsFile = resolve(arg("labels") ?? join(MAIN, "out/goal-check-labels/labels.json"));
const runs = Math.max(1, Number(arg("runs") ?? 2));
const only = arg("only")?.split(",");
const name = arg("label") ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const STATUSES: readonly string[] = ["done", "continue", "needs_user", "open", "blocked"];
const checkerRoot = resolve(arg("checker") ?? join(import.meta.dirname, "../.."));
const bundle = join(MAIN, "out/goal-check-labels", `.checker-${createHash("sha256").update(checkerRoot).digest("hex").slice(0, 8)}.mjs`);
await build({ entryPoints: [join(checkerRoot, "agent/src/goal-check.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "error" });
// SAFETY: 各工作树里的 goal-check.ts 都导出同一签名的 checkGoal。
const { checkGoal } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`) as typeof import("../../agent/src/goal-check.ts");

function labelsOf(value: unknown): Label[] {
  if (!Array.isArray(value)) throw new Error(`${labelsFile} 不是数组`);

  return value.filter((item): item is Label => !!item && typeof item === "object" && typeof (item as Label).id === "string"
    && ((item as Label).expected === null ? !!only?.includes((item as Label).id) : STATUSES.includes((item as Label).expected!)) && !!(item as Label).input && Array.isArray((item as Label).input.goal));
}

const labels = labelsOf(JSON.parse(readFileSync(labelsFile, "utf8"))).filter(item => !only || only.includes(item.id));
const PI = join(REPO, "node_modules/@earendil-works/pi-ai/dist");
// SAFETY: 这两个文件就是 pi-ai 包导出的 "." 和 "./providers/all"。
const { InMemoryCredentialStore } = await import(pathToFileURL(join(PI, "index.js")).href) as { InMemoryCredentialStore: typeof CredentialStore };
const { builtinModels } = await import(pathToFileURL(join(PI, "providers/all.js")).href) as { builtinModels: typeof BuiltinModels };
const plan = await loadModelPlan(DEFAULT_TEST_MODEL);
if (plan.credential.type === "oauth") plan.credential.refresh = "";
const credentials = new InMemoryCredentialStore();
// SAFETY: loadModelPlan 按 pi-ai Credential 的形状组装（api_key 或 oauth）。
await credentials.modify(plan.providerId, async () => plan.credential as unknown as Credential);
const models = builtinModels({ credentials });
const model: Model<Api> | undefined = models.getModel(plan.providerId, plan.modelId);
if (!model) throw new Error(`pi-ai 目录里没有 ${DEFAULT_TEST_MODEL}`);
let lastDetail = "";
const host = {
  models: { completeSimple: (m: Model<Api>, context: Parameters<typeof models.completeSimple>[1], options?: Parameters<typeof models.completeSimple>[2]) => models.completeSimple(m, context, { ...options, transport: "sse" }) },
  record: (_type: "side_call", data: { detail?: string; reason?: string }) => { lastDetail = data.detail ?? data.reason ?? ""; },
};

type Outcome = { id: string; expected: Status | null; got: string[]; ms: number[] };
const outcomes: Outcome[] = [];

for (const item of labels) {
  const got: string[] = [];
  const ms: number[] = [];

  for (let i = 0; i < runs; i++) {
    const started = Date.now();
    let verdict = "";

    for (let attempt = 0; attempt < 2 && !STATUSES.includes(verdict); attempt++) {
      lastDetail = "";
      verdict = await checkGoal(host, model, item.input, AbortSignal.timeout(30_000)).then(v => v.status, error => `unavailable(${error instanceof Error ? error.message.slice(0, 40) : "?"}${lastDetail ? `：${lastDetail.replace(/\s+/g, " ").slice(0, 120)}` : ""})`);
    }
    got.push(verdict);
    ms.push(Date.now() - started);
  }

  outcomes.push({ id: item.id, expected: item.expected, got, ms });
  console.log(`${item.id}  该判 ${item.expected ?? "未标注"}  判 ${got.join("/")}  ${ms.map(n => (n / 1000).toFixed(1)).join("/")} 秒`);
}

const judged = (filter: (o: Outcome) => boolean) => outcomes.filter(o => o.expected !== null).filter(filter).flatMap(o => o.got.filter(g => STATUSES.includes(g)).map(g => ({ o, g })));
const notContinue = judged(o => o.expected !== "continue");
const notDone = judged(o => o.expected !== "done");
const changed = judged(o => labels.find(l => l.id === o.id)?.tags?.includes("changed-goal") ?? false);
const rate = (part: number, all: number) => (all ? `${part}/${all}（${Math.round((part / all) * 100)}%）` : "0/0");
const falseContinue = notContinue.filter(x => x.g === "continue").length;
const falseDone = notDone.filter(x => x.g === "done").length;
const changedDone = changed.filter(x => x.g === "done").length;
const agree = judged(() => true).filter(x => x.g === x.o.expected).length;
const unavailable = outcomes.flatMap(o => o.got).filter(g => !STATUSES.includes(g)).length;
const consistent = outcomes.filter(o => o.got.every(g => STATUSES.includes(g)) && new Set(o.got).size === 1).length;
const allMs = outcomes.flatMap(o => o.ms).sort((a, b) => a - b);
const seconds = (n: number | undefined) => (n === undefined ? "—" : `${(n / 1000).toFixed(1)} 秒`);

const report = [
  `# 核对尺子 ${name}`,
  ``,
  `${labels.length} 条 × ${runs} 次，模型 ${DEFAULT_TEST_MODEL}，核对代码 ${checkerRoot}，标注 ${labelsFile}。`,
  ``,
  `| 指标 | 值 |`,
  `|---|---|`,
  `| 和标注一致 | ${rate(agree, judged(() => true).length)} |`,
  `| 误判续做（该判别的却判 continue） | ${rate(falseContinue, notContinue.length)} |`,
  `| 误判完成（该判别的却判 done） | ${rate(falseDone, notDone.length)} |`,
  `| 换了目标的误判完成 | ${rate(changedDone, changed.length)} |`,
  `| 没拿到结论 | ${unavailable} |`,
  ...(runs > 1 ? [`| 同一输入 ${runs} 次结论一致 | ${rate(consistent, outcomes.length)} |`] : []),
  `| 每次用时 中位 / 最长 | ${seconds(allMs[Math.floor(allMs.length / 2)])} / ${seconds(allMs.at(-1))} |`,
  ``,
  `| 编号 | 来源 | 该判 | 判 | 用时（秒） |`,
  `|---|---|---|---|---|`,
  ...outcomes.map(o => `| ${o.id} | ${labels.find(l => l.id === o.id)?.source ?? ""} | ${o.expected ?? "未标注"} | ${o.got.join(" / ")} | ${o.ms.map(n => (n / 1000).toFixed(1)).join(" / ")} |`),
].join("\n") + "\n";
const out = join(dirname(labelsFile), `bench-${name}`);
await mkdir(dirname(out), { recursive: true });
await writeFile(`${out}.md`, report);
await writeFile(`${out}.json`, JSON.stringify({ name, runs, model: DEFAULT_TEST_MODEL, checker: checkerRoot, outcomes }, null, 2));
console.log(report);
console.log(`报告：${out}.md`);
