// npx tsx scripts/probes/compare-real.mts . <outDir> <ext|ego> [--repeat=2] [--only=S1,R1]   (ext needs extension/dist built; ego needs ego lite and the codex CLI)
// Question: on real sites with the same model (gpt-6.1-sol, high), does our extension get the same tasks right as Codex + ego, how fast, and in how many rounds?
import { join } from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const [root, outDir, arm] = process.argv.slice(2);
const repeat = Number(process.argv.find((a) => a.startsWith("--repeat="))?.slice(9)) || 2;
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const MODEL = "openai-codex/gpt-6.1-sol";
const START = "https://example.com/";
const dec = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };

type Tab = { url: string; title: string };
type Ctx = { answer: string; tabs: Tab[]; probe: unknown; truth: Record<string, string> };
type Task = { id: string; group: string; name: string; prompt: string; probeUrl?: RegExp; probe?: string; truth?: () => Promise<Record<string, string>>; check(c: Ctx): string | null };

const ghTop = async () => { const h = await (await fetch("https://github.com/trending", { headers: { "user-agent": "Mozilla/5.0" } })).text(); return h.match(/<h2 class="h3 lh-condensed">[\s\S]*?href="\/([^"]+)"/)?.[1] ?? ""; };
const hnTop = async () => { const h = await (await fetch("https://news.ycombinator.com/")).text(); return (h.match(/<span class="titleline"><a [^>]*>([^<]+)<\/a>/)?.[1] ?? "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"); };
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const TASKS: Task[] = [
  { id: "S1", group: "搜索", name: "必应搜天气", prompt: "新开一个标签页打开 https://cn.bing.com ，搜索 天气。",
    check: (c) => c.tabs.some((t) => /bing\.com\/search/.test(t.url) && dec(t.url).includes("天气")) ? null : "没有到必应“天气”的结果页" },
  { id: "S2", group: "搜索", name: "维基百科搜长城", prompt: "打开中文维基百科 https://zh.wikipedia.org ，用页面上的搜索框搜索“长城”，打开“长城”这个条目。",
    check: (c) => c.tabs.some((t) => /wikipedia\.org\/(wiki|zh-[a-z]+)\/长城$/.test(dec(t.url).split("#")[0])) ? null : "没有打开“长城”条目" },
  { id: "R1", group: "读取", name: "HN 第一条", prompt: "打开 https://news.ycombinator.com ，告诉我现在排第一的帖子标题（保留英文原文）。",
    truth: async () => ({ before: await hnTop() }),
    check: (c) => [c.truth.before, c.truth.after].some((t) => t && norm(c.answer).includes(norm(t))) ? null : `回答里没有第一条标题（应为 ${c.truth.before}）` },
  { id: "R2", group: "读取", name: "GitHub 热门第一", prompt: "打开 https://github.com/trending ，告诉我今天排第一的仓库是哪个（写成 作者/仓库名）。",
    truth: async () => ({ before: await ghTop() }),
    check: (c) => [c.truth.before, c.truth.after].some((t) => t && norm(c.answer).replace(/\s*\/\s*/g, "/").includes(norm(t))) ? null : `回答里没有 ${c.truth.before}` },
  { id: "F1", group: "填写", name: "测试表单提交", prompt: "打开 https://www.selenium.dev/selenium/web/web-form.html ，Text input 填 张三，Textarea 填 你好世界，Dropdown (select) 选 Two，然后点 Submit 提交。",
    check: (c) => { const t = c.tabs.find((x) => x.url.includes("submitted-form")); if (!t) return "没有提交"; const q = new URL(t.url).searchParams; const bad = [["my-text", "张三"], ["my-textarea", "你好世界"], ["my-select", "2"]].filter(([k, v]) => q.get(k) !== v).map(([k]) => k); return bad.length ? `提交的值不对：${bad.join("、")}` : null; } },
  { id: "F2", group: "填写", name: "TodoMVC 待办", prompt: "打开 https://todomvc.com/examples/react/dist/ ，添加两条待办：买牛奶、交电费，然后把“买牛奶”标记为已完成。",
    probeUrl: /todomvc\.com\/examples\/react/, probe: `JSON.stringify([...document.querySelectorAll(".todo-list li")].map(li => ({ t: li.innerText.trim(), done: li.classList.contains("completed") })))`,
    check: (c) => { const items = JSON.parse(String(c.probe ?? "[]")) as { t: string; done: boolean }[]; const s = JSON.stringify(items); return items.length === 2 && items.some((i) => i.t === "买牛奶" && i.done) && items.some((i) => i.t === "交电费" && !i.done) ? null : `待办是 ${s}`; } },
].filter((t) => !only || only.includes(t.id));

// ---------- progress page shared by both arms (each arm writes its own json, page merges) ----------
const statusFile = join(outDir, `status-${arm}.json`);
const status: Record<string, { state: string; detail?: string }> = {};
const page = join(outDir, "progress.html");
async function writeStatus(id: string, state: string, detail?: string) {
  status[id] = { state, detail };
  await writeFile(statusFile, JSON.stringify(status));
  const read = async (a: string) => JSON.parse(await readFile(join(outDir, `status-${a}.json`), "utf8").catch(() => "{}"));
  const all = { ext: await read("ext"), ego: await read("ego") };
  const ids = TASKS.flatMap((t) => Array.from({ length: repeat }, (_, i) => `${t.id}-${i + 1}`));
  const nameOf = (id: string) => { const t = TASKS.find((x) => id.startsWith(x.id + "-"))!; return `${t.group} · ${t.name} · 第 ${id.split("-")[1]} 次`; };
  const cell = (s?: { state: string; detail?: string }) => !s ? `<td class="wait">等待</td>` : `<td class="${s.state}">${{ run: "运行中", pass: "做对", fail: "没做对", err: "出错" }[s.state] ?? s.state}${s.detail ? `<br><small>${s.detail.replace(/</g, "&lt;")}</small>` : ""}</td>`;
  const running = Object.values(all).some((m) => Object.values(m as Record<string, { state: string }>).some((s) => s.state === "run")) || ids.some((id) => !all.ext[id] || !all.ego[id]);
  await writeFile(page, `<!doctype html><meta charset="utf-8">${running ? '<meta http-equiv="refresh" content="4">' : ""}<title>真实网站对比</title>
<style>body{font:14px system-ui;margin:20px;background:#fff;color:#222}table{border-collapse:collapse}td,th{border-bottom:1px solid #eee;padding:6px 10px;vertical-align:top;text-align:left}small{color:#666}.run{color:#b26b00}.pass{color:#1a7f37}.fail,.err{color:#c62828}.wait{color:#aaa}</style>
<h2>真实网站对比：我们的扩展 vs Codex + ego（都用 gpt-6.1-sol，思考强度高）</h2><p>${running ? "进行中" : "已结束"} · 每格写结果、用时、浏览器操作轮数</p>
<table><tr><th>任务</th><th>我们的扩展</th><th>Codex + ego</th></tr>${ids.map((id) => `<tr><td>${nameOf(id)}</td>${cell(all.ext[id])}${cell(all.ego[id])}</tr>`).join("")}</table>`);
}

// ---------- ext arm ----------
async function runExt(task: Task, id: string, dir: string) {
  const { launchRealPath, until, sleep } = await import(join(root, "scripts/acceptance/real-path/harness.mts"));
  const { storageItemsFor } = await import(join(root, "eval/harness/credentials.mjs"));
  const cfg = storageItemsFor(MODEL);
  const rp = await launchRealPath({ headed: true });
  try {
    const user = await rp.attach((await rp.targets()).find((t: { url: string }) => t.url === "about:blank")!.targetId);
    await rp.cdp.send("Page.navigate", { url: START }, user);
    const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "sw")).targetId);
    const panel = await rp.attach(await rp.openSidePanel());
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(cfg.items)}).then(() => true)`);
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "panel ready");
    const chip = async () => String(await rp.evaluate(panel, `(() => { const c = document.querySelector("#think-chip"); return c && !c.hidden ? c.innerText.replace(/\\s+/g, " ").trim() : ""; })()`));
    await until(async () => (await chip()) || undefined, 60_000, "think chip");
    await rp.click(panel, "#think-chip"); await sleep(350);
    await rp.evaluate(panel, `[...document.querySelectorAll("#think-menu [role=menuitemradio]")].find(b => b.querySelector("span").textContent === "深入").click(), true`);
    await sleep(300);
    if (!(await chip()).includes("深入")) throw new Error(`没选上深入：${await chip()}`);
    await rp.cdp.send("Page.bringToFront", {}, user); await sleep(600);

    const t0 = Date.now();
    await rp.click(panel, "#input"); await rp.typeText(panel, task.prompt); await rp.pressEnter(panel);
    const busy = `(() => { const q = (s) => document.querySelector(s); return (q("#status-pill")?.classList.contains("running") ?? false) || (q("#send-btn")?.classList.contains("stopping") ?? false) || !!q(".msg.assistant.streaming, .msg.assistant[data-revealing], .thinking.streaming"); })()`;
    await until(async () => await rp.evaluate(panel, busy), 20_000, "started").catch(() => {});
    let quietSince = 0;
    while (Date.now() - t0 < 240_000) { const b = await rp.evaluate(panel, busy); quietSince = b ? 0 : (quietSince || Date.now()); if (quietSince && Date.now() - quietSince > 4000) break; await sleep(250); }
    const ms = (quietSince || Date.now()) - t0;
    const answer = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].map(m => m.innerText.trim()).join("\\n---\\n")`));
    const tabs = (await rp.evaluate(sw, "chrome.tabs.query({}).then(ts => ts.map(t => ({ url: t.url || t.pendingUrl || '', title: t.title || '' })))")) as Tab[];
    let probe: unknown = null;
    if (task.probe) { const tg = (await rp.targets()).find((t: { url: string; type: string }) => t.type === "page" && task.probeUrl!.test(t.url)); if (tg) probe = await rp.evaluate(await rp.attach(tg.targetId), task.probe); }
    const trace = String(await rp.evaluate(panel, `new Promise((ok) => { const r = indexedDB.open("sideagent-diagnostics"); r.onsuccess = () => { const q = r.result.transaction("trace-lines").objectStore("trace-lines").getAll(); q.onsuccess = () => ok(q.result.map(x => x.line).join("")); }; r.onerror = () => ok(""); })`));
    await writeFile(join(dir, "trace.jsonl"), trace);
    const lines = trace.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const rounds = lines.filter((l) => l.type === "model_request").length;
    const tools = lines.filter((l) => l.type === "tool_execution_start").map((l) => l.data?.toolName);
    await rp.screenshot(panel, join(dir, "panel.png")).catch(() => {});
    return { ms, answer, tabs, probe, rounds, browserCalls: tools.length, tools, wasted: wastedRounds(lines), button: await showTabButton(rp, sw, panel) };
  } finally { await rp.close(); await rp.remove(); }
}

// Rounds a better harness makes unnecessary, classified from the diagnostics trace (same rules before and after a change).
function wastedRounds(lines: any[]) {
  const calls = lines.filter((l) => l.type === "message_end" && l.data?.message?.role === "assistant").flatMap((l) => l.data.message.content.filter((c: any) => c.type === "toolCall"));
  const results = lines.filter((l) => l.type === "message_end" && l.data?.message?.role === "toolResult").map((l) => l.data.message.content.map((c: any) => c.text ?? "").join(""));
  const opens = (c: any) => c?.name === "navigate" || (c?.name === "tabs" && c.arguments?.action === "open");
  const looksOnly = (c: any) => c?.name === "snapshot" || (c?.name === "browser_run" && /snapshot|pageInfo/.test(c.arguments?.code ?? "") && !/fill|click|press|type|select|check|hover|scroll|tabs/.test(c.arguments?.code ?? ""));
  return {
    tabsList: calls.filter((c: any) => c.name === "tabs" && c.arguments?.action === "list").length,
    tabsShow: calls.filter((c: any) => c.name === "tabs" && c.arguments?.action === "show").length,
    lookAfterOpen: calls.filter((c: any, i: number) => i > 0 && looksOnly(c) && opens(calls.slice(0, i).reverse().find((x: any) => !(x.name === "tabs" && x.arguments?.action !== "open")))).length,
    zeroSize: results.filter((t: string) => t.includes("零尺寸")).length,
    staleRef: results.filter((t: string) => /节点已离开文档|页面文档已变化|读取期间页面地址已变化/.test(t)).length,
  };
}

// The 切过去看 button (user decision 10-13): present exactly when the result is in a background tab; clicking it brings that tab forward.
async function showTabButton(rp: any, sw: string, panel: string) {
  const tabs = (await rp.evaluate(sw, "chrome.tabs.query({}).then(ts => ts.map(t => ({ id: t.id, url: t.url || '', active: t.active })))")) as { id: number; url: string; active: boolean }[];
  const expected = tabs.length > 1 && (tabs.find((t) => t.active)?.url ?? "") === START;
  const tabId = await rp.evaluate(panel, `(() => { const b = document.querySelector(".msg.assistant:last-of-type .answer-show-tab, .answer-latest .answer-show-tab"); return b ? Number(b.dataset.tabId) : null; })()`);
  if (tabId == null) return { expected, shown: false, ok: !expected };
  await rp.evaluate(panel, `document.querySelector(".answer-latest .answer-show-tab, .msg.assistant:last-of-type .answer-show-tab").click(), true`);
  await new Promise((r) => setTimeout(r, 800));
  const active = (await rp.evaluate(sw, "chrome.tabs.query({ active: true }).then(ts => ts.map(t => t.id))")) as number[];
  return { expected, shown: true, tabId, broughtForward: active.includes(tabId), ok: expected && active.includes(tabId) };
}

// ---------- ego arm ----------
function ego(code: string): Promise<any> {
  return new Promise((done, fail) => {
    const child = spawn("ego-browser", ["nodejs", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.on("close", (code) => { clearTimeout(kill); const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{")); try { done(JSON.parse(line!)); } catch { fail(new Error(`ego-browser exit ${code}: ${out.slice(-300)}`)); } });
  });
}
function codex(prompt: string, dir: string): Promise<{ ms: number; events: string; code: number | null }> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("codex", ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high",
      ...["browser", "unified-computer-use", "chrome", "computer-use"].flatMap((n) => ["-c", `plugins."${n}@openai-bundled".enabled=false`]),
      ...["computer-use", "node_repl", "playwright", "chrome-devtools", "axstream"].flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]),
      "--json", "-o", join(dir, "last.txt"), prompt], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d)); child.stderr.on("data", () => {});
    const kill = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.on("close", async (code) => { clearTimeout(kill); const events = Buffer.concat(chunks).toString(); await writeFile(join(dir, "events.jsonl"), events); done({ ms: Date.now() - started, events, code }); });
  });
}
async function runEgo(task: Task, id: string, dir: string) {
  let space: number | undefined;
  for (let i = 1; space === undefined; i++) { try { ({ space } = await ego(`const task = await taskSpace(${JSON.stringify(`bys-real ${id} ${Date.now()}`)}); await task.page("p1").goto(${JSON.stringify(START)}, { waitUntil: "domcontentloaded" }); console.log(JSON.stringify({ space: task.spaceId }));`)); } catch (e) { if (i >= 3) throw e; } }
  const prompt = `用 ego-browser。我在 ego 浏览器里（ego-browser 任务空间 ${space}）正看着 p1 这一页 ${START} 。${task.prompt}做完后把结果页留在浏览器里给我看。`;
  const turn = await codex(prompt, dir);
  const answer = await readFile(join(dir, "last.txt"), "utf8").catch(() => "");
  const back = await ego(`
// Codex usually hands the space back to the user when done; claim it back only to read.
let task; try { task = await claimTaskSpace(${space}); } catch { task = await taskSpace(${space}); }
const tabs = await task.tabs();
let probe = null;
${task.probe ? `const hit = tabs.find((t) => ${task.probeUrl}.test(t.url)); if (hit) { const pg = hit.label ? task.page(hit.label) : await task.adopt(hit.page); probe = await pg.evaluate(${JSON.stringify(task.probe)}); }` : ""}
console.log(JSON.stringify({ tabs: tabs.map((t) => ({ url: t.url, title: t.title })), probe }));
// finish() only hands the space back and ego refills an emptied window with a blank tab, so close every tab at the protocol level; that closes the space.
for (const t of tabs) await task.cdp("Target.closeTarget", { targetId: t.targetId }).catch(() => {});`).catch((e) => ({ tabs: [], probe: null, error: String(e) }));
  const cmds = turn.events.split("\n").filter(Boolean).flatMap((l) => { try { const e = JSON.parse(l); return e.type === "item.completed" && e.item?.type === "command_execution" ? [String(e.item.command ?? "")] : []; } catch { return []; } });
  return { ms: turn.ms, answer, tabs: back.tabs as Tab[], probe: back.probe, rounds: null, browserCalls: cmds.filter((c) => c.includes("ego-browser")).length, otherCalls: cmds.filter((c) => !c.includes("ego-browser")).length, exit: turn.code, readBackError: back.error };
}

// ---------- main ----------
await mkdir(outDir, { recursive: true });
const results: unknown[] = [];
for (const task of TASKS) for (let rep = 1; rep <= repeat; rep++) {
  const id = `${task.id}-${rep}`;
  const dir = join(outDir, arm, id);
  await mkdir(dir, { recursive: true });
  await writeStatus(id, "run");
  console.log(`▶ ${arm} ${id} ${task.name}`);
  try {
    const truthOf = async () => { for (let i = 0; i < 3; i++) { try { return (await task.truth!()).before; } catch { await new Promise((r) => setTimeout(r, 2000)); } } return ""; };
    const truth: Record<string, string> = task.truth ? { before: await truthOf() } : {};
    const r = arm === "ext" ? await runExt(task, id, dir) : await runEgo(task, id, dir);
    if (task.truth) truth.after = await truthOf();
    const reason = task.check({ answer: r.answer, tabs: r.tabs, probe: r.probe, truth });
    const row = { id, arm, task: task.name, outcome: reason ? "fail" : "pass", reason, seconds: +(r.ms / 1000).toFixed(1), ...r, truth };
    results.push(row);
    await writeStatus(id, reason ? "fail" : "pass", `${row.seconds} 秒 · ${r.browserCalls} 次浏览器操作${reason ? " · " + reason : ""}`);
    console.log(`${reason ? "✖" : "✔"} ${arm} ${id} ${row.seconds}s calls=${r.browserCalls}${reason ? " — " + reason : ""}`);
  } catch (e) {
    results.push({ id, arm, task: task.name, outcome: "error", error: String(e) });
    await writeStatus(id, "err", String(e).slice(0, 120));
    console.log(`! ${arm} ${id} ${String(e).slice(0, 200)}`);
  }
  await writeFile(join(outDir, `result-${arm}.json`), JSON.stringify(results, null, 2));
}
if (arm === "ext") {
  const ok = (results as any[]).filter((r) => r.outcome !== "error");
  const sum = (k: string) => ok.reduce((n, r) => n + (r.wasted?.[k] ?? 0), 0);
  const secs = ok.map((r) => r.seconds).sort((a, b) => a - b);
  console.log(JSON.stringify({ pass: ok.filter((r) => r.outcome === "pass").length, of: results.length, rounds: ok.reduce((n, r) => n + r.rounds, 0), medianSeconds: secs[Math.floor(secs.length / 2)],
    wasted: Object.fromEntries(["tabsList", "tabsShow", "lookAfterOpen", "zeroSize", "staleRef"].map((k) => [k, sum(k)])), buttonOk: ok.filter((r) => r.button?.ok).length }));
}
console.log(`done ${arm}`);
