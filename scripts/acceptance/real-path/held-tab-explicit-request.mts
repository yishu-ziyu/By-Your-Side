import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const out = process.env.OUT_DIR ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-held-tab-explicit-request`);
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>账号页</title><body><h1>账号页</h1><input id="name" aria-label="昵称"><button id="mark" onclick="fetch('/clicked',{method:'POST'})">记一下</button></body></html>`;
const posts: string[] = [];
const site = createServer((req, res) => { if (req.method === "POST") posts.push(req.url ?? ""); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE); });
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const HOLD = "用例 held-a：换一下账号页的头像。";
const ASK_HOLD = "请你在页面上选好头像";
const REFUSED = "用例 held-b：把账号页关掉。";
const REFUSED_ANSWER = "账号页还开着，它被另一个任务占着，我这边关不掉。";
const NAMED = "用例 held-c：就是要关这个账号页。";
const NAMED_ANSWER = "账号页已关掉。";
const RESUMED = "原任务接着做完了。";

const verdict = { text: JSON.stringify({ items: [{ text: "关闭账号页", done: false }], goalOnPage: false, status: "continue", repair: "complete_task", verificationSubject: "answer", remaining: "关闭账号页", correction: "账号页还没关，应继续尝试", finding: "账号页未关闭", evidence: REFUSED_ANSWER }) };
const rules: Rule[] = [{ match: '"goalPage"', steps: [verdict] }, { match: "[GOAL CHECK]", steps: [{ text: "（被强制继续）" }] }, { match: "[HANDOFF BOUNDARY]", steps: [{ text: RESUMED }] },
  { match: HOLD, steps: [{ tool: { name: "fill", args: { target: "#name", value: "小王" } } }, { tool: { name: "hand_to_user", args: { ask: ASK_HOLD, targets: ["#mark"] } } }, { text: "（不该走到这一步）" }] }];
type Message = { role: string; content?: string | Array<{ text?: string }> | null };
const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";
const toolTexts = new Set<string>(); const payloads: string[] = [];
const model = await startScriptedModel(rules, undefined, payload => {
  payloads.push(JSON.stringify(payload.messages ?? []));
  for (const message of (payload.messages ?? []) as Message[]) if (message.role === "tool") toolTexts.add(textOf(message));
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const shown = (text: string) => `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(text)})`;

try {
  const port = siteAddress(site).port;
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/account` }, work);
  await rp.cdp.send("Target.createTarget", { url: "about:blank", background: true });
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const tabId = await until(async () => await rp.evaluate(panel, `chrome.tabs.query({url:"http://127.0.0.1/account*"}).then(t=>t[0]?.id)`) as number | undefined, 15_000, "账号页标签");
  const say = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const tabAlive = () => rp.evaluate(panel, `chrome.tabs.get(${tabId}).then(()=>true,()=>false)`);

  await rp.cdp.send("Page.bringToFront", {}, work);
  await say(HOLD);
  await until(async () => await rp.evaluate(panel, '!!document.querySelector(".handoff-card")') || undefined, 30_000, "交给用户的卡片");
  await rp.click(panel, "#conversation-new");
  await sleep(1_500);
  await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");

  rules.push({ match: REFUSED, steps: [{ tool: { name: "tabs", args: { action: "open", url: `http://127.0.0.1:${port}/other` } } }, { tool: { name: "tabs", args: { action: "close", tabId } } }, { text: REFUSED_ANSWER }] });
  await say(REFUSED);
  await until(async () => await rp.evaluate(panel, shown(REFUSED_ANSWER)) || undefined, 30_000, "没明确要求时的回答");
  await sleep(3_000);
  const refusal = [...toolTexts].find(t => t.includes("暂停等用户交还")) ?? "";
  check("没带明确要求时页面不动，报错写明被哪个任务占着、怎么解开", refusal.includes("「") && refusal.includes("userNamedThisPage") && await tabAlive() === true, { refusal: refusal.slice(0, 200), all: [...toolTexts].map(t => t.slice(0, 80)) });
  const nudged = payloads.filter(p => p.includes(REFUSED) && p.includes("[GOAL CHECK]")).length;
  check("被占用是确定事实，目标检查不再强制继续", nudged === 0, { nudged });
  await rp.screenshot(panel, join(out, "refused.png"));

  verdict.text = JSON.stringify({ status: "done", remaining: "", correction: "" });
  rules.push({ match: NAMED, steps: [
    { tool: { name: "take_tab", args: { tabId, userNamedThisPage: true } } },
    { tool: { name: "tabs", args: { action: "switch", tabId } } },
    { tool: { name: "click", args: { target: "#mark" } } },
    { tool: { name: "tabs", args: { action: "close", tabId } } },
    { text: NAMED_ANSWER },
  ] });
  await say(NAMED);
  await until(async () => await rp.evaluate(panel, shown(NAMED_ANSWER)) || undefined, 30_000, "明确要求后的回答");
  const taken = [...toolTexts].find(t => t.includes("已交回本会话")) ?? "";
  check("用户明确要求后，页面能操作也能关掉", posts.includes("/clicked") && await tabAlive() === false, { posts, taken: taken.slice(0, 160) });
  const notice = await rp.evaluate(panel, `document.body.innerText.includes("仍暂停")`);
  await rp.screenshot(panel, join(out, "taken.png"));
  check("告诉用户旧任务还暂停着", notice === true && taken.includes("仍暂停"), { notice: notice as Json, taken: taken.slice(0, 160) });

  await rp.click(panel, "#conversation-switcher");
  await sleep(300);
  const rows = await rp.evaluate(panel, `[...document.querySelectorAll('#conversation-menu button')].map(e=>({id:e.dataset.conversationId,title:e.title,selected:e.getAttribute("aria-checked")==="true"||e.classList.contains("selected")}))`) as Array<{ id: string; title: string; selected: boolean }>;
  const old = rows.find(row => row.id !== undefined && !row.selected)!;
  await rp.click(panel, `[data-conversation-id="${old.id}"]`);
  const card = await until(async () => await rp.evaluate(panel, '(()=>{const c=document.querySelector(".handoff-card");return c?c.innerText:null})()') as string | null, 10_000, "回到旧任务看到交接卡");
  check("回到旧任务，它还在暂停，可以交还", card.includes(ASK_HOLD), { card: card.slice(0, 160) });
  await rp.click(panel, ".handoff-card button");
  await until(async () => await rp.evaluate(panel, shown(RESUMED)) || undefined, 30_000, "旧任务接着做");
  check("页面已关掉时交还，旧任务仍能接着做", true, { resumed: RESUMED });
  await rp.screenshot(panel, join(out, "resumed.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, tools: [...toolTexts], modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
