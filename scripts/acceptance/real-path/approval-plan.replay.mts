// 用 10-03 存档的 22replace 确认卡重放共享批准规则（验收：docs/evals/20261004-shared-approval-plan.md）。
// 期望：存档卡都是声明内的真实操作，应全部放行；旧 run 的读页卡静默拒绝。另造越权卡，必须拒绝并算失败。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { decideCard, type ApprovalPlan, type CardInput } from "./approval-plan.mts";
import { S22_REPLACE_RULES, S22_RULES, nestedFor } from "./form-method-rules.mts";
import type { JsonRecord as Rec } from "./harness.mts";
import type { Rule } from "./scripted-model.mts";

const ROOT = "out/acceptance/real-path";

const runs = (await readdir(ROOT)).filter(d => d.startsWith("2026-10-03T") && d.includes("remember-corrections-scripted")).sort();

const rulesFor = (tab: number): Rule[] => [...S22_REPLACE_RULES, ...S22_RULES].map(r => ({ ...r,
  steps: r.steps.map(s => "tool" in s && s.tool.name === "take_tab" ? { tool: { name: "take_tab", args: { tabId: tab } } } : s) }));

function inputOf(entry: Rec, mutate?: (request: Rec, params: Rec) => void): CardInput {
  // SAFETY: archived logs were written by the acceptance script from native protocol records.
  const card = entry.card as Rec;
  // SAFETY: same archived structure; source is the native consent_request message.
  const request = structuredClone(((card.source as Rec)?.msg as Rec)?.request as Rec);
  // SAFETY: archived events are the fixture observer's native port messages.
  const events = (card.events ?? []) as Rec[];
  let details = String(card.details);
  const now = Number(request.expiresAt) - 1;

  if (mutate) {
    // SAFETY: archived request.value is the JSON parameter text the extension sent.
    const params = JSON.parse(String(request.value)) as Rec;
    mutate(request, params);
    details = JSON.stringify(params);
    request.value = details;
  }

  return {
    cardId: String(request.id), selected: String(card.selected), details, now, request,
    // SAFETY: history entries are archived native protocol records.
    history: events.flatMap(e => e.kind === "history" ? ((e.entries ?? []) as Rec[]).map(x => ({ ...x, conversationId: e.conversationId })) : []),
    // SAFETY: the latest conversations snapshot from the same native port.
    conversations: events.findLast(e => e.kind === "conversations")?.conversations as Rec[] | undefined,
    // SAFETY: archived modelRequest is the scripted model's recorded request; `all` is its full text.
    lastModelRequest: (entry.modelRequest as Rec | undefined)?.all as string | undefined,
  };
}

let mismatches = 0;

let incomplete = 0;

let negativeRun: { entry: Rec; plan: ApprovalPlan } | null = null;

for (const run of runs) {
  let log: Rec[];

  try {
    // SAFETY: archived consent logs are JSON arrays written by remember-corrections.mts.
    log = JSON.parse(await readFile(join(ROOT, run, "22replace-consent.json"), "utf8")) as Rec[];
  } catch { continue; }

  // SAFETY: archived params are the parsed JSON parameters of each card or null.
  const tabs = log.map(e => (e.params as Rec | null)?.tabId).filter((t): t is number => typeof t === "number");
  const tab = tabs.sort((a, b) => tabs.filter(t => t === b).length - tabs.filter(t => t === a).length)[0]!;
  const rules = rulesFor(tab);
  const enteredTasks = new Set(log.map(e => String(e.task)));
  const counts: Record<string, number> = {};

  for (const entry of log) {
    const task = String(entry.task);
    const rule = rules.find(r => task.includes(r.match));
    const plan: ApprovalPlan = { task, enteredTasks, steps: rule?.steps ?? [], nested: nestedFor(rule), fixtureTabs: [tab] };
    const d = decideCard(inputOf(entry), plan);
    // 独立期望：存档卡都应放行。旧脚本标为旧 run 读页的卡，10-03 各轮有时拒绝、有时放行且场景都通过，期望只是不算失败。
    const expectQuiet = entry.staleFixtureRead === true;
    const ok = expectQuiet ? !d.fail : d.allow;
    // SAFETY: same archived native consent_request structure as inputOf reads.
    const tool = String(((((entry.card as Rec).source as Rec)?.msg as Rec)?.request as Rec)?.tool);

    const skip = !ok && !entry.modelRequest && d.reason.includes("模型请求") ? "证据不全"
      : !ok && !rule && task.startsWith("[S22-") ? "任务标记已改名" : null;

    if (skip) { incomplete++; counts[skip] = (counts[skip] ?? 0) + 1; continue; }

    counts[d.kind] = (counts[d.kind] ?? 0) + 1;

    if (!ok) { mismatches++; console.log(`  ✗ ${run.slice(11, 19)} ${tool} 旧=${entry.allowed} 新=${d.kind}：${d.reason}｜${task.slice(0, 40)}`); }

    if (d.kind === "model-step" && tool === "fill" && task.includes("[S22-REPLACE-PHONE-MISSING]")) negativeRun = { entry, plan };
  }

  console.log(`${run.slice(11, 19)} 卡=${log.length} 旧放行=${log.filter(e => e.allowed).length} 新判定=${JSON.stringify(counts)}`);
}

// 反例：同一张真实 fill 卡改造成越权形态，都必须拒绝并算失败。
if (!negativeRun) throw new Error("存档里没有可改造的 fill 卡");

const { entry, plan } = negativeRun;

const negatives = {
  "未声明的 js POST": (r, p) => {
    r.tool = "js";

    for (const k of Object.keys(p)) if (k !== "tabId") delete p[k];

    p.code = "fetch('/submit',{method:'POST'})";
  },
  "模型改了填写内容": (_r, p) => { p.value = "无备注"; },
  "别的标签页": (_r, p) => { p.tabId = Number(p.tabId) + 1; },
  "别的会话": r => { r.conversationId = "other-conversation"; },
  "已过期": r => { r.expiresAt = 0; },
} satisfies Record<string, (request: Rec, params: Rec) => void>;

for (const [name, mutate] of Object.entries(negatives)) {
  const d = decideCard(inputOf(entry, mutate), plan);
  const ok = !d.allow && d.fail;

  if (!ok) mismatches++;

  console.log(`反例 ${ok ? "✓" : "✗"} ${name}：${d.kind} ${d.reason}`);
}

console.log(mismatches === 0 ? `PASS 与期望一致（证据不全或标记已改名 ${incomplete} 张未计）` : `FAIL ${mismatches} 处与期望不符`);

process.exitCode = mismatches === 0 ? 0 : 1;
