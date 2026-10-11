/**
 * 读 turns-baseline.mts 的产物：每题每次，你说完（插话或补一句）到助手收到、到下一段正文出字、到做完各几秒，
 * 以及你说话时助手正在做什么。用法：npx tsx scripts/eval/turns-read.mts <out/eval/turns/时间戳>
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.argv[2]!;

type Line = { time: string; sessionId: string; type: string; data?: { text?: string; toolName?: string; status?: string; attempt?: number; remaining?: string; finding?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } } };

// SAFETY: 诊断记录一行一个 JSON 对象，字段见 shared/run-trace-core.ts；rows.json 由 turns-baseline.mts 写出。
const lines = (await readFile(join(dir, "traces.jsonl"), "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l) as Line);

const { rows } = JSON.parse(await readFile(join(dir, "rows.json"), "utf8")) as { rows: Array<{ task: string; run: number; askedAt: number; turnAt: number; doneAt: number; ok: boolean; why: string; oldDirectionSteps: number }> };

const at = (l: Line) => Date.parse(l.time);

const result = rows.map(row => {
  // 这一题的会话：第一句话在 askedAt 之后开始的那个。
  const session = lines.find(l => l.type === "run_start" && at(l) >= row.askedAt - 1000 && at(l) <= row.turnAt)?.sessionId;
  const own = lines.filter(l => l.sessionId === session && at(l) >= row.turnAt - 50);
  // 收到：插话交给模型的那条用户消息（插话），或补一句开的新一轮（答完以后）。
  const heard = own.find(l => (l.type === "message_start" && l.data?.message?.role === "user") || l.type === "run_start");
  const text = heard && own.find(l => l.type === "first_text" && at(l) >= at(heard));
  const end = [...own].reverse().find(l => l.type === "agent_end");
  // 你说话到助手收到之间，助手在做的动作。
  const busy = own.filter(l => l.type === "tool_execution_start" && heard && at(l) < at(heard)).map(l => l.data?.toolName);
  const running = lines.filter(l => l.sessionId === session && l.type === "tool_execution_start" && at(l) <= row.turnAt).at(-1);
  // 目标核对判「继续」并真的多跑了一轮：用户先看到了一个没做完或做错的回答。记下核对说还差什么，好分出抓对的和白跑的。
  const continues = own.filter(l => l.type === "goal_check" && l.data?.status === "continue" && l.data.attempt !== undefined).map(l => l.data?.remaining ?? "");
  const corrections = continues.length;
  // 最后一段回答取诊断记录里助手最后写的正文，不读侧栏（侧栏里链接和「按上次做过的」会粘在同一行）。
  const answer = own.filter(l => l.type === "message_end" && l.data?.message?.role === "assistant").map(l => (l.data?.message?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("").trim()).filter(Boolean).at(-1) ?? "";
  const named = [...answer.matchAll(/(青羽|云帆|星河|极光|晨风)[^，。；*]{0,8}\**最轻|最轻的?是?\**[^，。；]{0,4}(青羽|云帆|星河|极光|晨风)/g)].map(m => m[1] ?? m[2]);
  const ok = row.task === "addinfo" ? named.length > 0 && named.every(n => n === "晨风") : row.ok;
  const sec = (l?: Line) => l ? Number(((at(l) - row.turnAt) / 1000).toFixed(1)) : null;

  return { task: row.task, run: row.run, ok, why: row.task === "addinfo" ? answer.slice(0, 160) : row.why, continues, oldDirectionSteps: row.oldDirectionSteps, heardS: sec(heard), firstTextS: sec(text), doneS: sec(end), busyBeforeHeard: busy, lastActionBeforeTurn: running?.data?.toolName ?? null, corrections };
});

for (const r of result) console.log(`${r.task}-${r.run}\t${r.ok ? "对" : "错"}\t听到 ${r.heardS}s\t出字 ${r.firstTextS}s\t做完 ${r.doneS}s\t说话时在做 ${r.lastActionBeforeTurn}\t旧方向多做 ${r.oldDirectionSteps}\t被核对纠正 ${r.corrections} 次`);

await writeFile(join(dir, "timings.json"), JSON.stringify(result, null, 2));
