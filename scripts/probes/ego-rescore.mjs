// Re-read every Ego space after the run (claiming finished spaces back) and re-apply the same checks.
// usage: ORIGIN=http://127.0.0.1:PORT node ego-rescore.mjs <ego result.json>
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { CASES, origin } from "./ego-arm.mjs";

const file = process.argv[2];
const results = JSON.parse(await readFile(file, "utf8"));
const ego = (code) => new Promise((done, fail) => {
  const child = spawn("ego-browser", ["nodejs", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  child.on("close", () => { const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{")); try { done(JSON.parse(line)); } catch { fail(new Error(out.slice(-300))); } });
});
for (const r of results) {
  const base = CASES.find((c) => r.id.replace(/-\d+$/, "") === c.id);
  const back = await ego(`
let task; try { task = await claimTaskSpace(${r.space}); } catch { task = await taskSpace(${r.space}); }
const tabs = await task.tabs();
const mine = tabs.find((t) => t.url.startsWith(${JSON.stringify(origin + base.path)}));
let draft = null;
if (mine) { try { const pg = mine.label ? task.page(mine.label) : await task.adopt(mine.page); draft = await pg.evaluate(() => document.querySelector("#draft")?.value ?? null); } catch {} }
console.log(JSON.stringify({ tabs: tabs.map((t) => ({ url: t.url, active: t.active })), draft }));`).catch((e) => ({ tabs: [], draft: null, error: String(e) }));
  const ctx = { answer: r.answerFull, draft: back.draft, saves: r.saves, tabs: back.tabs.map((t) => t.url), activeUrl: back.tabs.find((t) => t.active)?.url ?? null };
  const reason = base.check(ctx);
  Object.assign(r, { outcome: reason ? "fail" : "pass", reason, readBack: back });
  console.log(`${reason ? "✖" : "✔"} ${r.id} ${reason ?? ""}`);
}
await writeFile(file.replace(/\.json$/, ".rescored.json"), JSON.stringify(results, null, 2));
