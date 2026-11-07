import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { recheckProbe, reverifyContinue, startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-panel-tidy`);

await mkdir(out, { recursive: true });

const SITE = "shop.test";

const site = createServer((req, res) => {
  const canvas = req.url === "/canvas";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${canvas ? "画板" : "商品页"}</title></head><body>${canvas
    ? `<h1>画板</h1><button id="rect" onclick="document.getElementById('tool').textContent='已选矩形工具'">矩形</button><p id="tool">未选工具</p>`
    : "<h1>商品页</h1><p>保温杯 99 元，到货提醒可订阅。</p>"}</body></html>`);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const PAST_GOAL = "对了，登录一下我的少数派吧";
const PAST_REVISIONS = ["我会去发文章", "你先看看我之前发过的文章，还有一些被官方推流了", "现在我想看看有没有些新的活动是我可以参加的。", "其实我们就要利用好这些渠道，才能让我们的项目被看见。"];

const ASK = { unrelated: "这些任务的评测集我能搞到吗？", related: "少数派登录成功了吗", work: "整理一下流程图数据备用", csv: "把商品导出成 CSV 文件", draw: "在画板上画一个登录流程图" };

const GIVE_UP = ["我没能完成流程图：画布上还没有方框。", "流程图还没画到画布上：缺四个方框和箭头。"];

const model = await startScriptedModel([
  { match: "[GOAL CHECK]", steps: [{ tool: { name: "send_user_message", args: { kind: "finding", outcome: "partial", content: GIVE_UP[1], unfinished: ["画出四个方框并用箭头连起来"] } } }, { text: "" }] },
  { match: ASK.unrelated, steps: [{ text: "这页的保温杯 99 元。" }] },
  { match: ASK.related, steps: [{ text: "到货提醒订阅已经生效。" }] },
  { match: ASK.work, steps: [{ tool: { name: "browser_run", args: { label: "存流程图数据", code: 'return await browser.saveFile({ filename: "login-flow.json", content: "{\\"steps\\":4}" });' } } }, { text: "流程图数据已整理好。" }] },
  { match: ASK.csv, steps: [{ tool: { name: "artifacts", args: { command: "create", filename: "products.csv", content: "name,price\n保温杯,99\n", deliver: true } } }, { text: "已导出 products.csv。" }] },
  { match: ASK.draw, steps: [{ tool: { name: "click", args: { target: "#rect" } } }, { text: GIVE_UP[0] }] },
  { match: "DECISION::none", steps: [{ text: JSON.stringify({ action: "none", text: "", evidence: "", scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: false, date: null, onlyThisTask: false, explicitRequest: false } }) }] },
  { match: "VERDICT-CONTINUE", steps: [{ text: JSON.stringify({ status: "continue", remaining: "画出流程图", correction: "画布上没有方框和箭头。", finding: "画布上还没有流程图" }) }] },
  { match: "VERDICT-DONE", steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
]);

type ChatMessage = { role: string; content?: string | Array<{ text?: string }> | null };

const textOf = (c: ChatMessage["content"]) => Array.isArray(c) ? c.map(p => p.text ?? "").join("") : c ?? "";

const mainSystems: string[] = [];

const verdicts: string[] = [];
let goalChecks = 0;
let lastFirst = "VERDICT-DONE";

const proxy = createServer(async (req, res) => {
  let body = "";

  req.setEncoding("utf8"); for await (const c of req) body += c;

  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
    const payload = JSON.parse(body) as { messages?: ChatMessage[]; tools?: unknown[] };
    const system = (payload.messages ?? []).filter((m, i, all) => m.role === "system" || m.role === "developer" || (m.role === "user" && textOf(m.content).startsWith("本次运行的上下文") && !all.slice(i + 1).some(n => n.role === "user" && textOf(n.content).startsWith("本次运行的上下文")))).map(m => textOf(m.content)).join("\n");

    if (payload.tools?.length) mainSystems.push(system);

    if (system.includes("You interpret the CURRENT direct user message")) body = JSON.stringify({ ...payload, messages: [{ role: "user", content: "DECISION::none" }] });

    if (system.startsWith("You check whether a browser assistant has finished the user's goal")) {
      const again = reverifyContinue(body);
      if (!again) { goalChecks++; lastFirst = verdicts.shift() ?? "VERDICT-DONE"; }
      body = JSON.stringify({ ...payload, messages: [{ role: "user", content: again ? recheckProbe(lastFirst, again) : lastFirst }] });
    }
  }

  try {
    const reply = await fetch(new URL(model.baseUrl).origin + (req.url ?? "/"), { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : body });
    res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await reply.arrayBuffer()));
  } catch { res.writeHead(502).end(); }
});

await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${SITE} 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server"] });

const evidence: Record<string, unknown> = {};

let error: string | null = null;

let panel = "";

const PANEL = `(() => {
  const m = document.querySelector("#messages");
  if (!m) return { idle: false, users: 0, lastTurn: "", usedLine: null, answers: [], fixes: [], cards: [] };
  const all = [...m.children], lastUser = all.map(n => n.matches(".msg.user")).lastIndexOf(true);
  return {
    idle: document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running"),
    users: m.querySelectorAll(".msg.user").length,
    lastTurn: all.slice(lastUser + 1).map(n => n.textContent.trim()).join("\\n"),
    usedLine: [...all.slice(lastUser + 1)].map(n => n.matches(".memory-used-toggle") ? n : n.querySelector(".memory-used-toggle")).find(Boolean)?.textContent.trim() ?? null,
    answers: [...m.querySelectorAll(".msg.assistant[data-delivery-id]")].map(n => n.textContent.trim()),
    // 判继续后续做那一轮过程行第二行的「核对发现：… / 还差：…」（收尾后隐藏，文字还在）。
    fixes: [...m.querySelectorAll("details.run-steps > summary > .run-meta")].map(n => n.textContent.trim()).filter(t => /^(核对发现|还差)/.test(t)),
    cards: [...document.querySelectorAll(".artifact-card")].map(n => n.dataset.filename),
  };
})()`;

type Panel = { idle: boolean; users: number; lastTurn: string; usedLine: string | null; answers: string[]; fixes: string[]; cards: string[] };

const read = async () => (await rp.evaluate(panel, PANEL)) as Panel;

async function turn(text: string, expect: string): Promise<{ system: string; view: Panel }> {
  const mark = mainSystems.length, before = await read();
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(async () => { const s = await read(); return s.users > before.users && s.idle && s.lastTurn.includes(expect) ? s : undefined; }, 60_000, `回答「${expect}」`, 250);
  await sleep(2_000);

  return { system: mainSystems[mark] ?? "", view: await read() };
}

const TASKS_HEADER = "# Tasks you did for this user before";

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://${SITE}/` }, work);
  const ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const items = { inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => (await read()).idle || undefined, 60_000, "侧栏就绪");

  const now = Date.now();
  const task = { id: "seed-task", conversationId: "seed", goal: PAST_GOAL, revisions: PAST_REVISIONS, hosts: [SITE], outcome: "complete", summary: "已登录少数派。", unfinished: [], startedAt: now - 3_600_000, endedAt: now - 3_000_000 };
  await rp.evaluate(ext, `(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(${JSON.stringify(JSON.stringify({ format: 1, tasks: [task] }) + "\n")}, "tasks");
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); db.close(); return true; })()`);
  await rp.click(panel, "#conversation-new");
  await sleep(1_000);
  const unrelated = await turn(ASK.unrelated, "99 元");
  await rp.screenshot(panel, join(out, "a-unrelated.png"));
  const related = await turn(ASK.related, "已经生效");
  evidence.a = { unrelated: { tasksInPrompt: unrelated.system.includes(TASKS_HEADER), line: unrelated.view.usedLine }, related: { tasksInPrompt: related.system.includes(TASKS_HEADER) && related.system.includes(PAST_GOAL), line: related.view.usedLine } };
  await rp.screenshot(panel, join(out, "a-related.png"));
  assert.ok(unrelated.system.length > 0 && !unrelated.system.includes(TASKS_HEADER), "a: 无关请求的系统提示里没有过往任务");
  assert.ok(!unrelated.view.usedLine, `a: 无关请求的回答下没有记忆行（实际：${unrelated.view.usedLine}）`);
  assert.ok(related.system.includes(TASKS_HEADER) && related.system.includes(PAST_GOAL), "a: 相关请求的系统提示里有这条过往任务");
  assert.ok(related.view.usedLine?.startsWith("本轮提供的过往任务"), `a: 相关请求的回答下有「本轮提供的过往任务」（实际：${related.view.usedLine}）`);

  await turn(ASK.work, "已整理好");
  const afterWork = await read();
  await turn(ASK.csv, "已导出");
  const afterCsv = await read();
  evidence.b = { cardsAfterWork: afterWork.cards, cardsAfterCsv: afterCsv.cards };
  await rp.screenshot(panel, join(out, "b-csv.png"));
  assert.ok(!afterWork.cards.includes("login-flow.json"), `b: 中间文件没有卡片（实际：${afterWork.cards.join("、")}）`);
  assert.ok(afterCsv.cards.includes("products.csv") && !afterCsv.cards.includes("login-flow.json"), `b: 只有用户要的 CSV 有卡片（实际：${afterCsv.cards.join("、")}）`);

  await rp.cdp.send("Page.navigate", { url: `http://${SITE}/canvas` }, work);
  await sleep(800);
  verdicts.push(...Array(5).fill("VERDICT-CONTINUE"));
  const checksBefore = goalChecks, fixesBefore = (await read()).fixes.length;
  await turn(ASK.draw, GIVE_UP[1]);
  await sleep(8_000);
  const end = await read();
  const giveUps = end.answers.filter(t => GIVE_UP.some(g => t.includes(g.slice(0, 8))));
  evidence.c = { goalChecks: goalChecks - checksBefore, nudges: end.fixes.length - fixesBefore, fixes: end.fixes.slice(fixesBefore), giveUps };
  await rp.screenshot(panel, join(out, "c-give-up.png"));
  assert.equal(end.fixes.length - fixesBefore, 1, "c: 只催了一次（侧栏一条「核对发现」）");
  assert.equal(goalChecks - checksBefore, 1, "c: 催后网页没变又说做不成，不再问核对模型");
  assert.equal(giveUps.length, 1, `c: 侧栏只留一段「做不成」，不是更多（实际 ${giveUps.length} 段）`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) await rp.screenshot(panel, join(out, "fatal.png")).catch(() => undefined);
} finally {
  await writeFile(join(out, "main-system-prompts.json"), JSON.stringify(mainSystems, null, 2));
  await writeFile(join(out, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error, modelRequests: model.requests }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  proxy.closeAllConnections(); proxy.close();
  site.closeAllConnections(); site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
