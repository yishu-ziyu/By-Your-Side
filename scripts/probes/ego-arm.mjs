// Ego arm of the extension-vs-ego experiment: Codex CLI (gpt-6.1-sol, high) + ego-browser on the same local practice pages.
// usage: node ego-arm.mjs <origin> <outDir> [--only=a,b] [--repeat=2]
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const main = process.argv[1]?.endsWith("ego-arm.mjs");
export const origin = main ? process.argv[2] : process.env.ORIGIN;
const outDir = process.argv[3];
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const repeat = Number(process.argv.find((a) => a.startsWith("--repeat="))?.slice(9)) || 1;
const NOTE_FIRST = "Jev currently accepts text input only.";
const SAYS_DEAD = /没(有)?反应|不起作用|没(能)?存上|没有保存|未保存|保存失败|翻不过去|无法翻页|没能翻|没有翻到|无法确认|不能确认|没法确认|没(有)?生效|不能用|无效/;
const has = (text, ...needles) => needles.every((n) => text.includes(n));

export const CASES = [
  { id: "switch-tab", path: "/dy", extra: "/yt", prompt: "切到youtube", check: (c) => (c.activeUrl?.startsWith(`${origin}/yt`) ? null : `前台是 ${c.activeUrl}`) },
  { id: "three-repos", path: "/projects", prompt: "找到这三个项目的 GitHub 仓库地址。", check: (c) => (has(c.answer, "alpha-kit", "beta-flow", "gamma-db") ? null : "三个仓库没有全部给出") },
  { id: "copy-no-save", path: "/note", prompt: "把蓝色 Note 框里的第一句英文原文复制到下面的草稿框里，不要保存。", check: (c) => (c.saves > 0 ? "点了保存" : c.draft?.trim() === NOTE_FIRST ? null : `草稿框内容不对：${JSON.stringify(c.draft)}`) },
  { id: "fix-typos", path: "/compose", prompt: "帮我把草稿框里的错别字改好，其他字不要动，不要发送。", check: (c) => (c.saves > 0 ? "点了发送" : c.draft === "各位好：我们明天下午三点在会议室开会，讨论新版本的上线计划，请大家准时参加，不要迟到。" ? null : `草稿框内容不对：${JSON.stringify(c.draft)}`) },
  { id: "research", path: "/companies", prompt: "打开这页列出的三家公司，把每家的成立年份、城市和员工人数整理成一张表，每行注明来源网址。", check: (c) => { const missing = ["2016", "苏州", "120", "2019", "厦门", "45", "2012", "成都", "310", "/company/lumen", "/company/harbor", "/company/kite"].filter((n) => !c.answer.includes(n)); return missing.length ? `回答缺少：${missing.join("、")}` : null; } },
  { id: "dead-next", path: "/dead-next", prompt: "翻到第 2 页，告诉我第 2 页第一条是什么。", check: (c) => (SAYS_DEAD.test(c.answer) ? null : "没说清翻不过去") },
  { id: "open-tab", path: "/article", prompt: `在新标签页打开 ${origin}/job`, check: (c) => (c.tabs.some((u) => u.startsWith(`${origin}/job`)) ? null : "没有打开新标签页") },
];

// stdin must be closed: ego-browser also reads a script from stdin and waits for EOF on an open pipe.
function ego(code) {
  return new Promise((done, fail) => {
    const child = spawn("ego-browser", ["nodejs", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const kill = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.on("close", (code) => { clearTimeout(kill); const line = (out + "\n" + err).split("\n").reverse().find((l) => l.trim().startsWith("{")); try { done(JSON.parse(line)); } catch { fail(new Error(`ego-browser exit ${code}: ${err.slice(-400)}`)); } });
  });
}

async function setup(item, name) {
  return ego(`
const task = await taskSpace(${JSON.stringify(name)});
const p1 = task.page("p1");
await p1.goto(${JSON.stringify(origin + item.path)}, { waitUntil: "domcontentloaded" });
${item.extra ? `const p2 = await task.newPage(); await p2.goto(${JSON.stringify(origin + item.extra)}, { waitUntil: "domcontentloaded" }); await p1.cdp("Page.bringToFront", {});` : ""}
console.log(JSON.stringify({ space: task.spaceId }));`);
}

async function readBack(space) {
  return ego(`
// Codex often ends with task.finish(), which hands the space back to the user; claim it back only to read.
let task; try { task = await taskSpace(${space}); await task.tabs(); } catch { task = await claimTaskSpace(${space}); }
const tabs = await task.tabs();
let draft = null;
try { draft = await task.page("p1").evaluate(() => document.querySelector("#draft")?.value ?? null); } catch {}
console.log(JSON.stringify({ tabs: tabs.map((t) => ({ url: t.url, active: t.active, label: t.label ?? null })), draft }));`);
}

function codex(prompt, dir) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("codex", ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", ...["browser", "unified-computer-use", "chrome", "computer-use"].flatMap((n) => ["-c", `plugins."${n}@openai-bundled".enabled=false`]), ...["computer-use", "node_repl", "playwright", "chrome-devtools", "axstream"].flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]), "--json", "-o", join(dir, "last.txt"), prompt], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", () => {});
    const kill = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.on("close", async (code) => {
      clearTimeout(kill);
      const events = Buffer.concat(chunks).toString();
      await writeFile(join(dir, "events.jsonl"), events);
      done({ code, ms: Date.now() - started, events });
    });
  });
}

const results = [];
if (main) for (const base of CASES.filter((c) => !only || only.includes(c.id))) {
  for (let rep = 1; rep <= repeat; rep++) {
    const id = repeat > 1 ? `${base.id}-${rep}` : base.id;
    const dir = join(outDir, id);
    await mkdir(dir, { recursive: true });
    await fetch(`${origin}/__stats?reset=1`);
    let space;
    for (let attempt = 1; space === undefined; attempt++) { try { ({ space } = await setup(base, `bys-compare ${id} ${Date.now()}`)); } catch (e) { if (attempt >= 3) throw e; } }
    const prompt = `用 ego-browser。我在 ego 浏览器里（ego-browser 任务空间 ${space}）正看着 p1 这一页 ${origin}${base.path} 。${base.prompt}`;
    console.log(`▶ ego·${id}`);
    const turn = await codex(prompt, dir);
    const answer = await readFile(join(dir, "last.txt"), "utf8").catch(() => "");
    const { saves } = await (await fetch(`${origin}/__stats`)).json();
    const back = await readBack(space).catch((e) => ({ tabs: [], draft: null, error: String(e) }));
    const items = turn.events.split("\n").filter(Boolean).flatMap((l) => { try { const e = JSON.parse(l); return e.type === "item.completed" && e.item?.type === "command_execution" ? [e.item.command ?? ""] : []; } catch { return []; } });
    const toolCalls = items.filter((c) => c.includes("ego-browser nodejs")).length;
    const otherTools = turn.events.split("\n").filter((l) => l.includes('"mcp_tool_call"') && l.includes('"item.completed"')).length;
    const ctx = { answer, draft: back.draft, saves, tabs: back.tabs.map((t) => t.url), activeUrl: back.tabs.find((t) => t.active)?.url ?? null };
    const reason = base.check(ctx);
    const r = { id, arm: "ego", space, outcome: reason ? "fail" : "pass", reason, ms: turn.ms, exit: turn.code, toolCalls, answerFull: answer, readBack: back, saves, otherTools };
    results.push(r);
    console.log(`${reason ? "✖" : "✔"} ego·${id} (${Math.round(turn.ms / 1000)}s) ${toolCalls} calls${reason ? " — " + reason : ""}`);
    await writeFile(join(outDir, "result.json"), JSON.stringify(results, null, 2));
  }
}
