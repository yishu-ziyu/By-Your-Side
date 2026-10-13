/**
 * 起点建议写清只读还是会改页面；用鼠标点开会话列表，列表不自己关上，每行写结局。
 *   npx tsx scripts/acceptance/real-path/starter-history.mts --headless
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-starter-history`);

await mkdir(out, { recursive: true });

const FORM = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>活动报名表</title><body><h1>活动报名表</h1>
<p>请填写下面的信息。</p><p>报名截止到本周五。</p><p>如需改期，请联系主办方。</p>
<label>姓名 <input id="name" value="原来的名字"></label><label>城市 <input id="city"></label><button id="submit">提交</button></body></html>`;
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FORM));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "把张三填进报名表，城市填上海，不要提交";
const ANSWER = "填好了姓名和城市两栏，没有点提交。";
const model = await startScriptedModel([{ match: ASK, steps: [
  { tool: { name: "fill", args: { target: "#name", value: "张三", label: "姓名" } } },
  { tool: { name: "fill", args: { target: "#city", value: "上海", label: "城市" } } },
  { text: ANSWER },
] }]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false`), 60_000, "侧栏就绪");

  // (a) 起点建议：表单页上「帮我填写表单」写会改页面，「概括这一页」写只读；会改页面不用出错的红色。
  const chips = await until(async () => {
    const list = await rp.evaluate(panel, `[...document.querySelectorAll("#starter-actions .starter-chip")].map(c => ({ label: c.querySelector(".starter-chip-label")?.textContent ?? "", tag: c.querySelector(".starter-chip-tag")?.textContent ?? "", color: c.querySelector(".starter-chip-tag") ? getComputedStyle(c.querySelector(".starter-chip-tag")).color : "" }))`) as Array<{ label: string; tag: string; color: string }>;

    return list.some((c) => c.label === "帮我填写表单") ? list : undefined;
  }, 15_000, "起点建议");
  const errColor = await rp.evaluate(panel, `(() => { const p = document.createElement("p"); p.style.color = "var(--err)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`) as string;
  const fill = chips.find((c) => c.label === "帮我填写表单");
  const read = chips.find((c) => c.label === "概括这一页");
  check("建议写清会改页面还是只读，会改页面不用红色", !!fill?.tag.includes("会改页面") && read?.tag === "只读" && fill.color !== errColor, { chips, errColor });
  await rp.screenshot(panel, join(out, "starter.png"));

  // (b) 做一件填表的事，给会话列表一个结局。
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `document.body.innerText.includes(${JSON.stringify(ANSWER)})`)) || undefined, 60_000, "回答出现");

  // (c) 用鼠标点开会话列表：列表不自己关上，刚才那件事写结局，不写「空闲」。
  await rp.click(panel, "#conversation-new");
  await sleep(800);
  await rp.click(panel, "#conversation-switcher");
  await sleep(600);
  const menu = await rp.evaluate(panel, `({ open: !document.querySelector("#conversation-menu").hidden, text: document.querySelector("#conversation-menu").innerText.replace(/\\s+/g, " ") })`) as { open: boolean; text: string };
  check("鼠标点开会话列表后列表还开着", menu.open, menu);
  check("会话列表写结局，不写空闲", menu.text.includes("把张三填进报名表") && !menu.text.includes("空闲") && /填好 2 栏，没提交/.test(menu.text), menu);
  await rp.screenshot(panel, join(out, "history.png"));
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(out);

if (!checks.length || checks.some((c) => !c.pass)) process.exitCode = 1;
