/**
 * 真扩展 + 隔离 Chrome + 本机脚本模型：标签组名是按任务和网站起的短名，不是用户原话的前半句。
 * 脚本模型对起名请求回「起名 N 站」（N = 碰过几个网站）；任务在 127.0.0.1 开始，再打开 localhost 的页面。
 * 判定：标签组名先变成「起名 1 站」或直接「起名 2 站」，打开第二个网站后变成「起名 2 站」，从没停在原话上；侧栏会话标题跟着变。
 * 不证明真实模型起的名字好不好，只证明名字从哪来、什么时候换。
 * --live：主模型换成真实模型（默认 gpt-6-luna），在真网站上做一件跨两个网站的事，只看起出来的名字：不是原话、不超过 12 个字。
 * npx tsx scripts/acceptance/real-path/task-group-name.mts --headless [--live] [--model=服务商/模型]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();
const live = process.argv.includes("--live");
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-task-group-name`);
await mkdir(out, { recursive: true });
const site = createServer((req, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" })
  .end(req.url === "/b" ? "<!doctype html><meta charset=utf-8><title>开源仓库</title><h1>仓库</h1>" : "<!doctype html><meta charset=utf-8><title>我的收藏</title><h1>收藏</h1>"));
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const port = siteAddress(site).port;
const goal = live ? "打开 Hacker News 首页，找到排在第一的帖子，再到 GitHub 上搜一下它讲的项目" : "打开我的收藏夹，找到我的收藏里提到的开源项目仓库打开";
const model = live ? null : await startScriptedModel([{ match: goal, steps: [
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "tabs", args: { action: "open", url: `http://localhost:${port}/b` } } },
  { text: "已经打开仓库。", delayMs: 6000 },
] }]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: live ? "https://news.ycombinator.com/" : `http://127.0.0.1:${port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = model ? { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } }
    : modelStorageItems(await loadModelPlan(process.argv.find(a => a.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL));
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(()=>true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60000, "侧栏就绪");
  await rp.click(panel, "#input"); await rp.typeText(panel, goal); await rp.pressEnter(panel);
  if (live) {
    // 真模型：一直采样到这一轮结束（发送键回来），看起过哪些名字。
    const seen: string[] = [];
    await until(async () => {
      const titles = await rp.evaluate(panel, "chrome.tabGroups.query({}).then(gs=>gs.map(g=>g.title??''))") as string[];
      for (const title of titles) if (title && seen.at(-1) !== title) seen.push(title);
      return seen.length > 0 && await rp.evaluate(panel, '!document.querySelector("#status-pill.running, #send-btn.stopping, .thinking.streaming") && !!document.querySelector("details.run-steps.done")');
    }, 240000, "真模型这一轮结束", 250).catch(err => check("流程完成", false, String(err)));
    await rp.screenshot(panel, join(out, "panel.png"));
    const last = seen.at(-1) ?? "";
    check("真模型起的名字不是原话、不超过 12 个字", !!last && last !== goal && [...last.replace(/[\s·]/g, "")].length <= 12, seen);
  } else {
    // 从发出到回答一直采样所有标签组名：看到过什么名字，最后停在哪。
    const seen: string[] = [];
    await until(async () => {
      const titles = await rp.evaluate(panel, "chrome.tabGroups.query({}).then(gs=>gs.map(g=>g.title??''))") as string[];
      for (const title of titles) if (seen.at(-1) !== title) seen.push(title);
      return titles.includes("起名 2 站") && await rp.evaluate(panel, 'document.body.innerText.includes("已经打开仓库")');
    }, 40000, "标签组名换成两个网站的短名", 100).catch(err => check("流程完成", false, String(err)));
    await rp.screenshot(panel, join(out, "panel.png"));
    check("标签组名跟着网站换成「起名 2 站」", seen.at(-1) === "起名 2 站", seen);
    // 第一个名字可能还没回来时标签组已建好，那一刻显示原话；名字回来后不应再回到原话。
    const named = seen.findIndex(title => title.startsWith("起名"));
    check("起名之后不再回到用户原话", named >= 0 && seen.slice(named).every(title => title.startsWith("起名")), seen);
    check("侧栏会话标题和标签组名一致", await rp.evaluate(panel, 'document.body.innerText.includes("起名 2 站")') as boolean, {});
  }
} catch (err) { check("流程完成", false, String(err)); }
finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model?.close(); await new Promise<void>(done => site.close(() => done()));
}
console.log(`证据：${out}`);
if (!checks.length || checks.some(c => !c.pass)) process.exitCode = 1;
