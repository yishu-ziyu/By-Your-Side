/**
 * 过程灰字探针（docs/evals/20261006-process-line.md）：只装扩展的无头 Chrome、真侧栏、本机脚本模型。
 * 同一个填表任务跑两遍：一遍做成，一遍最后一步点空。读进行中那一行、任务条、收尾标题、展开的步骤、
 * 「继续原任务」的位置，并截图。
 *
 *   npx tsx scripts/probes/shell/process-line.mts --headless
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";
import { startScriptedModel } from "../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/probes/shell");

await mkdir(out, { recursive: true });

const html = "<!doctype html><meta charset=\"utf-8\"><title>订票</title><label>出发日期 <input id=\"d\"></label><label>乘客 <input id=\"n\"></label><button id=\"b\" onclick=\"this.textContent='已查询'\">查询车票</button>";

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(html));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

type ScriptedTool = { name: string; args: Record<string, string> };

const slow = (tool: ScriptedTool) => ({ tool, delayMs: 2500 });

const task = (word: string, target: string) => ({ match: word, steps: [{ tool: { name: "tabs", args: { action: "active" } } }, { tool: { name: "snapshot", args: {} } }, slow({ name: "fill", args: { target: "#d", value: "2026-10-20", label: "出发日期" } }), slow({ name: "fill", args: { target: "#n", value: "张三", label: "乘客" } }), slow({ name: "click", args: { target, label: "查询车票" } }), { text: "日期和乘客填好了，也点了「查询车票」。" }] });

const model = await startScriptedModel([task("订票甲", "#b"), task("订票乙", "#nope")]);

const failures: string[] = [];

/** evidence 是已序列化的 JSON 文本：探针只打印，不再解析。 */
const check = (name: string, ok: boolean, evidence: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${evidence}`);

  if (!ok) failures.push(name);
};

const LINE = `(() => { const r = [...document.querySelectorAll("details.run-steps")].pop(); const t = r?.querySelector(".run-title"); return r ? { done: r.classList.contains("done"), text: t.textContent, verb: t.querySelector(".act-verb")?.textContent ?? null, object: t.querySelector(".act-object")?.textContent ?? null, height: Math.round(t.getBoundingClientRect().height), orb: !!r.querySelector("canvas"), anim: getComputedStyle(t).animationName } : null; })()`;

const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#send-btn\")?.disabled===false") || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);

  for (const [word, tag] of [["订票甲", "ok"], ["订票乙", "fail"]] as const) {
    if (tag === "fail") {
      await rp.click(panel, "#conversation-new");
      await until(async () => await rp.evaluate(panel, "document.querySelectorAll(\"#messages .msg.user\").length === 0") || undefined, 15_000, "新会话");
    }

    await rp.click(panel, "#input");
    await rp.typeText(panel, `${word}：把出发日期填成 2026-10-20，乘客填张三，然后点查询车票`);
    await rp.pressEnter(panel);

    const live = await until(async () => {
      const line = await rp.evaluate(panel, LINE);

      return line?.object ? line : undefined;
    }, 30_000, "进行中那一行写到对象");

    const bar = await rp.evaluate(panel, "!document.querySelector(\".task-bar\") || document.querySelector(\".task-bar\").hidden");
    await rp.screenshot(panel, join(out, `process-${tag}-running.png`));

    if (tag === "ok") {
      check("进行中：一行「正在 动词 对象」，没有光球，有扫光", live.text.startsWith("正在") && !!live.verb && !live.orb && live.height <= 26 && live.anim === "runShine", JSON.stringify(live));
      check("进行中：任务条不出现", bar, JSON.stringify(null));
    }

    await until(async () => (await rp.evaluate(panel, LINE))?.done || undefined, 60_000, "这一轮收尾");
    await sleep(1500);
    const done = await rp.evaluate(panel, LINE);
    await rp.screenshot(panel, join(out, `process-${tag}-done.png`));
    await rp.click(panel, "details.run-steps:last-of-type > summary");
    await sleep(400);
    const steps = await rp.evaluate(panel, "[...document.querySelectorAll(\"details.run-steps[open] .run-body .chip-label\")].map((e) => e.textContent)");
    await rp.screenshot(panel, join(out, `process-${tag}-open.png`));
    // SAFETY: 页面脚本返回元素在消息区里的顺序：类名数组。
    const order = await rp.evaluate(panel, "[...document.querySelectorAll(\"#messages > *\")].filter((e) => e.getClientRects().length).map((e) => e.className.split(\" \")[0] + (e.classList.contains(\"assistant\") ? \".assistant\" : \"\"))") as string[];

    if (tag === "ok") {
      check("做完：收成「做了 N 件事」，不扫光", /^做了 \d+ 件事$/.test(done.text) && done.anim === "none", JSON.stringify(done));
      check("做完：展开是一步一行，含填写与点击", steps.length >= 3 && steps.some((s: string) => s.includes("出发日期")) && steps.some((s: string) => s.includes("查询车票")), JSON.stringify(steps));
      check("做完：没有「继续原任务」", !order.includes("ai-task-card"), JSON.stringify(order));
    } else {
      check("没做完：标题写出有一件没成功", done.text.includes("没成功"), JSON.stringify(done));
      check("没做完：失败那一步后面写「没成功」", steps.some((s: string) => s.includes("查询车票") && s.includes("没成功")), JSON.stringify(steps));
      const card = order.indexOf("ai-task-card");
      check("没做完：「继续原任务」在回答之后", card > order.lastIndexOf("msg.assistant") && card > -1, JSON.stringify(order));
      check("没做完：按钮名字是「继续原任务」", String(await rp.evaluate(panel, "document.querySelector(\".ai-task-card .resume-action\")?.textContent ?? \"\"")).includes("继续原任务"), JSON.stringify(null));
    }
  }
} finally {
  console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");
  await rp.close().catch(() => undefined);
  await model.close();
  site.closeAllConnections();
  site.close();
}
