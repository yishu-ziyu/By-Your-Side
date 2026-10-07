/**
 * 走老路对照实验（YIS-98，docs/evals/20261007-route-ab.md）：照旧组与一步步组各跑 N 轮 route-replay.mts，按判负条件给结论。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/route-ab.mts --headless [--rounds=3] [--model=provider/id]
 * 判负（任一成立就不做）：照旧组中位耗时降幅 < 20%；成功率低 1 个百分点以上；照旧组有一次订错或多订且那次照着走了。
 * 各组互不相干（各自的浏览器、临时目录、测试页），全部同时跑；两组在同样的负载下，比的是同一时刻的快慢。
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, requireHeadless } from "./harness.mts";

requireHeadless();

const rounds = Number(process.argv.find((arg) => arg.startsWith("--rounds="))?.slice("--rounds=".length) ?? 3);

const passThrough = process.argv.filter((arg) => arg.startsWith("--model="));

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-route-ab`);

await mkdir(out, { recursive: true });

type Run = { name: string; seconds: number; modelRequests?: number; ok?: boolean; made?: string[]; clarified?: boolean; followRoute?: string[] };

type Session = { arm: "replay" | "step"; round: number; artifacts: string; runs: Run[]; error: string | null };

const sessions: Session[] = [];

const runSession = (arm: "replay" | "step", round: number) => new Promise<Session>((done) => {
  const child = spawn(process.execPath, ["--import", "tsx", join(REPO, "scripts/acceptance/real-path/route-replay.mts"), "--headless", `--arm=${arm}`, ...passThrough], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.on("close", async () => {
    // SAFETY: route-replay.mts 最后一行打印 { status, artifacts, ... } 的 JSON。
    const last = JSON.parse(stdout.trim().split("\n").at(-1) || "{}") as { artifacts?: string };
    // SAFETY: result.json 由 route-replay.mts 写出，evidence.runs 是 Run 数组。
    const result = last.artifacts ? JSON.parse(await readFile(join(last.artifacts, "result.json"), "utf8")) as { evidence: { runs?: Run[] }; error: string | null } : { evidence: {}, error: "没有产出结果" };
    const session = { arm, round, artifacts: last.artifacts ?? "", runs: result.evidence.runs ?? [], error: result.error?.split("\n")[0] ?? null };
    console.log(`第 ${round} 组 ${arm === "replay" ? "记住上次" : "每次从头"}：${session.runs.map((run) => `${run.name} ${run.seconds}s ${run.ok ? "对" : "错"}`).join("，")}${session.error ? `（中断：${session.error}）` : ""}`);
    done(session);
  });
});

sessions.push(...await Promise.all(Array.from({ length: rounds }, (_, i) => i + 1).flatMap((round) => [runSession("replay", round), runSession("step", round)])));

const TASKS = ["照上次走", "换个说法", "页面改了"];

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length ? (sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2) : NaN;
};

const asks = (arm: "replay" | "step", task?: string) => sessions.filter((s) => s.arm === arm).flatMap((s) => s.runs).filter((run) => (task ? run.name === task : TASKS.includes(run.name)));

/** 一组里某类请求（或全部三类）的中位用时、成功几次、问过用户几次。没跑到的请求按失败算。 */
const stats = (arm: "replay" | "step", task?: string) => {
  const list = asks(arm, task);
  const expected = rounds * (task ? 1 : TASKS.length);

  return { median: median(list.map((run) => run.seconds)), ok: list.filter((run) => run.ok).length, of: expected, clarified: list.filter((run) => run.clarified).length, requests: median(list.map((run) => run.modelRequests ?? NaN).filter(Number.isFinite)) };
};

const byTask = Object.fromEntries([...TASKS, "合计"].map((task) => [task, { replay: stats("replay", task === "合计" ? undefined : task), step: stats("step", task === "合计" ? undefined : task) }]));

const all = byTask["合计"]!;

const faster = 1 - all.replay.median / all.step.median;

const rateDrop = (all.step.ok / all.step.of - all.replay.ok / all.replay.of) * 100;

// 误操作：多订，或订了但值不对；那次用过照走才算照旧导致（没订成不算误操作，算失败）。
const mistakes = sessions.filter((s) => s.arm === "replay").flatMap((s) => s.runs.filter((run) => TASKS.includes(run.name) && (run.made?.length ?? 0) > 0 && !run.ok).map((run) => ({ round: s.round, name: run.name, made: run.made, followed: (run.followRoute?.length ?? 0) > 0, artifacts: s.artifacts })));

const lose = [faster < 0.2 ? `中位耗时降幅 ${(faster * 100).toFixed(0)}% < 20%` : "", rateDrop > 1 ? `成功率低 ${rateDrop.toFixed(1)} 个百分点` : "", mistakes.some((m) => m.followed) ? `照旧导致误操作 ${mistakes.filter((m) => m.followed).length} 次` : ""].filter(Boolean);

const summary = { rounds, byTask, faster, rateDrop, mistakes, verdict: lose.length ? `不做：${lose.join("；")}` : "保留：三条判负都没触发", sessions };

await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));

const rows = Object.entries(byTask).map(([task, { replay, step }]) => `| ${task} | ${replay.median} 秒 | ${step.median} 秒 | ${replay.ok}/${replay.of} | ${step.ok}/${step.of} | ${replay.clarified} / ${step.clarified} |`);

await writeFile(join(out, "summary.md"), ["| 请求 | 照旧组中位 | 一步步组中位 | 照旧组订对 | 一步步组订对 | 来问过（照旧/一步步） |", "|---|---|---|---|---|---|", ...rows, "", summary.verdict].join("\n"));

console.log(JSON.stringify({ out, verdict: summary.verdict, faster, rateDrop, mistakes: mistakes.length }));
