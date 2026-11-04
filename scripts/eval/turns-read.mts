import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dir = process.argv[2]!;

type Line = { time: string; sessionId: string; type: string; data?: { text?: string; toolName?: string; status?: string; attempt?: number; remaining?: string; finding?: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } } };

const lines = (await readFile(join(dir, "traces.jsonl"), "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l) as Line);

const { rows } = JSON.parse(await readFile(join(dir, "rows.json"), "utf8")) as { rows: Array<{ task: string; run: number; askedAt: number; turnAt: number; doneAt: number; ok: boolean; why: string; oldDirectionSteps: number }> };

const at = (l: Line) => Date.parse(l.time);

const result = rows.map(row => {
  const session = lines.find(l => l.type === "run_start" && at(l) >= row.askedAt - 1000 && at(l) <= row.turnAt)?.sessionId;
  const own = lines.filter(l => l.sessionId === session && at(l) >= row.turnAt - 50);
  const heard = own.find(l => (l.type === "message_start" && l.data?.message?.role === "user") || l.type === "run_start");
  const text = heard && own.find(l => l.type === "first_text" && at(l) >= at(heard));
  const end = [...own].reverse().find(l => l.type === "agent_end");
  const busy = own.filter(l => l.type === "tool_execution_start" && heard && at(l) < at(heard)).map(l => l.data?.toolName);
  const running = lines.filter(l => l.sessionId === session && l.type === "tool_execution_start" && at(l) <= row.turnAt).at(-1);
  const continues = own.filter(l => l.type === "goal_check" && l.data?.status === "continue" && typeof l.data.attempt === "number").map(l => l.data?.remaining ?? "");
  const corrections = continues.length;
  const answer = own.filter(l => l.type === "message_end" && l.data?.message?.role === "assistant").map(l => (l.data?.message?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("").trim()).filter(Boolean).at(-1) ?? "";
  const MODELS = /青羽|云帆|星河|极光|晨风/g;
  const named = [...answer.matchAll(/最轻/g)].map(m => {
    const after = answer.slice(m.index!, m.index! + 12).match(/^最轻的?是?\**\s*(青羽|云帆|星河|极光|晨风)/)?.[1];

    return after ?? [...answer.slice(Math.max(0, m.index! - 80), m.index!).matchAll(MODELS)].at(-1)?.[0];
  }).filter(Boolean);
  const ok = row.task === "addinfo" ? named.length > 0 && named.every(n => n === "晨风") : row.ok;
  const sec = (l?: Line) => l ? Number(((at(l) - row.turnAt) / 1000).toFixed(1)) : null;

  return { task: row.task, run: row.run, ok, why: row.task === "addinfo" ? answer.slice(0, 160) : row.why, continues, oldDirectionSteps: row.oldDirectionSteps, heardS: sec(heard), firstTextS: sec(text), doneS: sec(end), busyBeforeHeard: busy, lastActionBeforeTurn: running?.data?.toolName ?? null, corrections };
});

for (const r of result) console.log(`${r.task}-${r.run}\t${r.ok ? "对" : "错"}\t听到 ${r.heardS}s\t出字 ${r.firstTextS}s\t做完 ${r.doneS}s\t说话时在做 ${r.lastActionBeforeTurn}\t旧方向多做 ${r.oldDirectionSteps}\t被核对纠正 ${r.corrections} 次`);

await writeFile(join(dir, "timings.json"), JSON.stringify(result, null, 2));
