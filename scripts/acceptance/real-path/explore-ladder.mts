/**
 * 探索阶梯（docs/evals/20261014-explore-ladder.md，程序层）：找不到目标时，工具结果里写明下一步。
 *   npx tsx scripts/acceptance/real-path/explore-ladder.mts --headless
 * 本机一个笔记页：三个菜单（点开是展开的菜单，里面没有「加标签」）、一个正文框、一个保存键。脚本模型：
 *   对话一：连开三个菜单，每开一个按 Esc 关掉；再四次去点不存在的「Add tag」「Tags」。
 *   对话二：开两个菜单都关掉，去点不存在的「删除笔记」，再去点不存在的「Tags」，然后交半成品问用户。
 *   对话三：正常一次就找到：填正文，三个菜单各开一次、都点了里面的项，保存。
 *   对话四：开两个菜单都关掉，填一次正文，再开两个菜单都关掉。
 *   对话五：开两个菜单都点了里面的项，交「没能做到」的半成品；退回后再交一次。
 * 判据：
 *   绕路 对话一前两次关菜单的结果里没有下一步；第三次的结果说换做法（输入语法、快捷键、右键）。
 *   报错 每次没找到都带下一步；第五处说查官方帮助（browser.fetch），第七处说问用户、带上打算怎么做。
 *   例外 对话二找删除第一次没找到就说问用户，不说换做法、查帮助；接着找普通目标时不再说问用户；它去问用户时照常发出。
 *   正常 对话三的工具结果里都没有下一步（用上的菜单不算死路）。
 *   清零 对话四填写之后重新数：四次关菜单都没有下一步。
 *   放弃 对话五第一次交半成品被退回、结果写明换做法和查帮助，侧栏里看不到这句；第二次照常发出。
 *   侧栏 给模型的下一步不出现在侧栏里。
 * 失败方式：只数报错、不数关掉的菜单，「绕路」失败；去掉付款/删除/发送的例外，「例外」失败；例外整轮有效，「例外」后半失败；
 * 打开就算死路，「正常」失败；成功的填写不清零，「清零」失败；不拦过早的半成品，「放弃」失败；拦住了问用户的半成品，「例外」失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-explore-ladder`);

await mkdir(out, { recursive: true });

const menu = (id: string, items: string[]) => `<div class="m"><button id="${id}" aria-expanded="false" aria-haspopup="menu" onclick="toggle(this, ${JSON.stringify(items).replace(/"/g, "&quot;")})">${id}</button></div>`;

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fixture Notes</title><body><main><h1>Fixture Notes</h1>
${menu("more", ["Pin", "Archive"])}${menu("view", ["Compact", "Wide"])}${menu("share", ["Copy link"])}
<textarea id="content" aria-label="Note content"></textarea> <button id="save" type="button" onclick="document.getElementById('saved').textContent='Saved'">Save</button><p id="saved"></p></main>
<script>
function closeAll() { document.querySelectorAll("[role=menu]").forEach((m) => m.remove()); document.querySelectorAll("[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false")); }
function toggle(button, items) {
  const open = button.getAttribute("aria-expanded") === "true";
  closeAll();
  if (open) return;
  button.setAttribute("aria-expanded", "true");
  const list = document.createElement("div"); list.setAttribute("role", "menu");
  for (const item of items) { const b = document.createElement("button"); b.setAttribute("role", "menuitem"); b.textContent = item; b.onclick = () => { closeAll(); document.getElementById("saved").textContent = item + " done"; }; list.append(b); }
  document.body.append(list);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
</script></body></html>`;

const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE); });

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const NOTES = `http://127.0.0.1:${siteAddress(site).port}/`;

const ASKS = ["案例一：给这条笔记加上标签 工作。", "案例二：把这条笔记删掉。", "案例三：在正文写上 买牛奶，置顶后保存。", "案例四：看看菜单，再写上 交电费。", "案例五：给这条笔记设个提醒。"];
const RISKY_ASK = "没找到删除按钮。我打算在笔记菜单里找 Delete，可以吗？";
const GIVE_UP = ["没能设上提醒：菜单里没有提醒选项。", "还是没能设上提醒：试过的地方都没有。"];
/** 侧栏里等到这句就算这一轮做完：发出半成品时本轮就此结束，不会再有收尾的一句。 */
const FINALS = ["没找到加标签的地方。", RISKY_ASK, "已写好并保存。", "已写好。", GIVE_UP[1]!];
const partial = (content: string) => ({ tool: { name: "send_user_message", args: { kind: "finding", outcome: "partial", content, unfinished: ["设提醒"] } } });
const esc = { tool: { name: "press_key", args: { key: "Escape" } } };
const missing = (label: string, target: string) => ({ tool: { name: "click", args: { target, label } } });
const open = (id: string, label: string) => ({ tool: { name: "click", args: { target: `#${id}`, label } } });
const choose = (item: string) => ({ tool: { name: "click", args: { target: `text=${item}`, label: item } } });

type Message = { role: string; content?: string | Array<{ text?: string }> | null; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };

const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";

/** 主任务请求里模型收到的每条工具结果，按对话和调用顺序。 */
const toolResults: Array<{ conv: number; name: string; args: string; text: string }> = [];
const seen = new Set<string>();

const model = await startScriptedModel([
  { match: '"visitedHosts"', steps: [{ text: JSON.stringify({ notes: [] }) }] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASKS[0]!, steps: [
    open("more", "打开笔记菜单"), esc, open("view", "打开视图菜单"), esc, open("share", "打开分享菜单"), esc,
    missing("加标签", "text=Add tag"), missing("加标签", "text=Add tag"), missing("标签选项", "text=Tags"), missing("标签选项", "text=Tags"),
    { text: FINALS[0]! },
  ] },
  { match: ASKS[1]!, steps: [open("more", "打开笔记菜单"), esc, open("view", "打开视图菜单"), esc, missing("删除笔记", "text=Delete note"), missing("标签选项", "text=Tags"), partial(RISKY_ASK)] },
  { match: ASKS[2]!, steps: [
    { tool: { name: "fill", args: { target: "#content", value: "买牛奶" } } },
    open("more", "打开笔记菜单"), choose("Pin"), open("view", "打开视图菜单"), choose("Wide"), open("share", "打开分享菜单"), choose("Copy link"),
    { tool: { name: "click", args: { target: "#save", label: "保存" } } },
    { text: FINALS[2]! },
  ] },
  { match: ASKS[3]!, steps: [
    open("more", "打开笔记菜单"), esc, open("view", "打开视图菜单"), esc,
    { tool: { name: "fill", args: { target: "#content", value: "交电费" } } },
    open("share", "打开分享菜单"), esc, open("more", "打开笔记菜单"), esc,
    { text: FINALS[3]! },
  ] },
  { match: ASKS[4]!, steps: [open("more", "打开笔记菜单"), choose("Archive"), open("view", "打开视图菜单"), choose("Compact"), partial(GIVE_UP[0]!), partial(GIVE_UP[1]!)] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const messages = (payload.messages ?? []) as Message[];
  const last = [...messages].reverse().find(m => m.role === "user" && ASKS.some(ask => textOf(m).includes(ask)));
  const conv = last ? ASKS.findIndex(ask => textOf(last).includes(ask)) : -1;

  if (conv < 0) return;
  const calls = new Map<string, { name: string; args: string }>();

  for (const m of messages) for (const call of m.tool_calls ?? []) calls.set(call.id, { name: call.function.name, args: call.function.arguments });

  for (const m of messages) {
    if (m.role !== "tool" || !m.tool_call_id || seen.has(m.tool_call_id)) continue;
    seen.add(m.tool_call_id);
    const call = calls.get(m.tool_call_id);
    toolResults.push({ conv, name: call?.name ?? "?", args: call?.args ?? "", text: textOf(m) });
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const hintOf = (text: string) => text.match(/\[Next step\][^\n]*/)?.[0] ?? null;

let panel = "";
let panelText = "";

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");

  const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#send-btn")?.classList.contains("stopping") && !document.querySelector("#status-pill")?.classList.contains("running")`;

  const ask = async (i: number) => {
    await rp.cdp.send("Page.navigate", { url: NOTES }, work);
    await until(async () => (await rp.evaluate(work, `document.readyState === "complete" && !!document.querySelector("#content")`).catch(() => false)) || undefined, 15_000, "打开笔记页");
    await rp.cdp.send("Page.bringToFront", {}, work);

    if (i > 0) {
      await rp.click(panel, "#conversation-new");
      await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`)) || undefined, 15_000, "新会话");
    }

    await rp.click(panel, "#input"); await rp.typeText(panel, ASKS[i]!); await rp.pressEnter(panel);
    const done = `document.querySelector("#messages")?.innerText.includes(${JSON.stringify(FINALS[i])}) && ${idle}`;
    await until(async () => await rp.evaluate(panel, done) || undefined, 180_000, `回答「${FINALS[i]}」`);
  };

  await ask(0);
  await rp.screenshot(panel, join(out, "panel-wander.png")).catch(() => {});
  const wander = toolResults.filter(r => r.conv === 0);
  const hints = wander.map(r => hintOf(r.text));
  const third = hints[5] ?? "";
  check("绕路 前两次关菜单没有下一步，第三次说换做法（输入语法、快捷键、右键）",
    wander.length === 10 && /expanded/.test(wander[4]!.text) && hints.slice(0, 5).every(h => !h) && /another way/.test(third) && /#tag/.test(third) && /keyboard shortcut/.test(third) && /right-click/.test(third),
    { count: wander.length, hints: hints.slice(0, 6), opened: wander[4]?.text.slice(0, 160) ?? null });
  const missed = hints.slice(6);
  check("报错 每次没找到都带下一步；第五处说查官方帮助，第七处说问用户、带上打算",
    missed.length === 4 && missed.every(Boolean) && /official help/.test(missed[1] ?? "") && /browser\.fetch/.test(missed[1] ?? "") && /ask the user/i.test(missed[3] ?? "") && /plan to do it/.test(missed[3] ?? "") && /可以/.test(missed[3] ?? ""),
    { notFound: wander.slice(6).map(r => r.text.split("\n")[0]!.slice(0, 80)), hints: missed });

  await ask(1);
  const second = toolResults.filter(r => r.conv === 1);
  const risky = second.filter(r => /未找到/.test(r.text)).map(r => hintOf(r.text));
  check("例外 删除类目标第一次没找到就说问用户，不说换做法、查帮助；接着找普通目标时不再说问用户；问用户照常发出（侧栏等到了这句）",
    risky.length === 2 && /deletes or sends/.test(risky[0] ?? "") && /ask the user/i.test(risky[0] ?? "") && !/another way|official help/.test(risky[0] ?? "") && /another way/.test(risky[1] ?? "") && !/deletes or sends|ask the user/i.test(risky[1] ?? "") && !second.some(r => r.name === "send_user_message" && /Not delivered/.test(r.text)),
    { hints: risky, held: second.filter(r => r.name === "send_user_message").map(r => r.text.slice(0, 60)) });

  await ask(2);
  const normal = toolResults.filter(r => r.conv === 2);
  check("正常 一次就找到的任务（三个菜单都用上），工具结果里都没有下一步",
    normal.length === 8 && normal.every(r => !hintOf(r.text)) && [1, 3, 5].every(i => /expanded/.test(normal[i]!.text)), { results: normal.map(r => `${r.name}: ${r.text.split("\n")[0]!.slice(0, 100)}`) });

  await ask(3);
  const again = toolResults.filter(r => r.conv === 3);
  check("清零 填写之后重新数：四次关菜单都没有下一步",
    again.length === 9 && again.every(r => !hintOf(r.text)) && [0, 2, 5, 7].every(i => /expanded/.test(again[i]!.text)), { results: again.map(r => `${r.name}: ${hintOf(r.text) ?? r.text.split("\n")[0]!.slice(0, 60)}`) });

  await ask(4);
  const gaveUp = toolResults.filter(r => r.conv === 4 && r.name === "send_user_message").map(r => r.text);
  const messages = String(await rp.evaluate(panel, `document.querySelector("#messages")?.innerText ?? ""`));
  check("放弃 第一次交半成品被退回（写明换做法、查帮助，侧栏看不到）；第二次照常发出（侧栏等到了这句）",
    gaveUp.length >= 1 && /Not delivered/.test(gaveUp[0] ?? "") && /another way/.test(gaveUp[0] ?? "") && /official help/.test(gaveUp[0] ?? "") && !messages.includes(GIVE_UP[0]!),
    { results: gaveUp.map(t => t.slice(0, 160)), firstShown: messages.includes(GIVE_UP[0]!), secondShown: messages.includes(GIVE_UP[1]!) });
  const shown = String(await rp.evaluate(panel, `document.body.innerText`));
  check("侧栏 给模型的下一步不出现在侧栏里", !/Next step|places tried/.test(shown), { found: shown.match(/.{0,40}(Next step|places tried).{0,40}/)?.[0] ?? null });
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  panelText = String(await rp.evaluate(panel, `document.querySelector("#messages")?.innerText ?? ""`).catch(() => ""));
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, toolResults, requests: model.requests, panelText }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}

console.log(`${checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL"} explore-ladder → ${out}`);
process.exit(checks.length && checks.every(c => c.pass) ? 0 : 1);
