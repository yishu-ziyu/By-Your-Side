/**
 * 一步写入的结果未知之后，助手重读页面、对同一个目标再做一次：网站收到，侧栏给出最终回答，没有放弃或「没有重复执行」的话
 * （docs/evals/20261010-drop-retry-locks.md R1）。只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/retry-after-unknown.mts --headless
 * 路径：snapshot 拿到「保存」按钮的 @ref → 页面重渲染，按钮 3 秒内不可见（模型用 js 模拟）→ click @ref：
 * 量不到元素位置，回执「结果未知」→ 等按钮回来再 snapshot → 对同一个 @ref 再 click → 回答。
 * 判据：第一次点击的回执写着结果未知且网站没收到；第二次点击送达（/save 计数 1）；侧栏有最终回答，
 * 没有「没有重复执行」「已暂停」「不能自动重做」「查不清」，也没有把这件事标成没做完。
 * 失败方式：恢复「结果未知就暂停写入、拒绝重做」的锁，第二次点击被拒，/save 停在 0（反例结果见验收文件）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-retry-after-unknown`);

await mkdir(artifacts, { recursive: true });

const MARK = "重试保存";
const FINAL = `【${MARK}结束】`;

/** 产品发给模型的 OpenAI 兼容请求里本脚本要读的部分。 */
type Payload = { tools?: unknown[]; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };

const textOf = (content: string | Array<{ text?: string }> | null | undefined) => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "";

let saves = 0;

const site = createServer((req, res) => {
  if (req.url === "/save") { saves++; res.writeHead(204).end(); return; }

  if (req.url !== "/") { res.writeHead(404).end(); return; }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>草稿页</title><p>草稿还没保存。</p><button id="save" onclick="fetch('/save')">保存</button>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

// 两次点击的目标在拿到 snapshot 之后才知道：先占位，读到真实 @ref 后改写这两步。
const firstClick = { tool: { name: "click", args: { target: "@0" } } };
const retryClick = { tool: { name: "click", args: { target: "@0" } } };

const steps: Step[] = [
  { tool: { name: "tabs", args: { action: "active" } } },
  { tool: { name: "snapshot", args: {} } },
  // 页面重渲染：按钮 3 秒内不可见，同一个元素随后回来。
  { tool: { name: "js", args: { code: "(() => { const b = document.querySelector('#save'); b.style.display = 'none'; setTimeout(() => { b.style.display = ''; }, 3000); return 'rerendering'; })()" } } },
  firstClick,
  // 重读页面：等按钮回来再看。
  { tool: { name: "snapshot", args: {} }, delayMs: 3500 },
  retryClick,
  { text: FINAL },
];

const payloads: Payload[] = [];
const savesAtReceipt: Record<number, number> = {};
let ref: string | null = null;

const model = await startScriptedModel([{ match: MARK, steps }], undefined, payload => {
  // SAFETY: 脚本模型把产品的 OpenAI 兼容请求体原样交给这里；Payload 只取其中可选的 tools 与 messages。
  const p = payload as Payload;
  payloads.push(p);
  const tools = (p.messages ?? []).filter(m => m.role === "tool");

  if (p.tools?.length && tools.length > 0 && !(tools.length in savesAtReceipt)) savesAtReceipt[tools.length] = saves;

  if (!ref && tools.length >= 2) {
    const line = textOf(tools[1]!.content).split(/\\n|\n/).find(l => l.includes('button "保存"'));
    const found = line?.match(/\[ref=(\d+)\]/)?.[1];

    if (found) { ref = `@${found}`; firstClick.tool.args.target = ref; retryClick.tool.args.target = ref; }
  }
});

const rp = await launchRealPath();
const screenshot = join(artifacts, "sidebar.png");
let error: string | null = null;
let receipts: string[] = [];
let panelText = "";

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, `${MARK}：把这页的草稿保存一下。`);
  await rp.pressEnter(panel);

  await until(async () => await rp.evaluate(panel, `!document.querySelector("#status-pill")?.classList.contains("running") && document.querySelector("#send-btn")?.disabled===false && document.querySelector("#messages")?.textContent.includes(${JSON.stringify(FINAL)})`) || undefined, 90_000, "final answer");
  await sleep(1500);

  const last = payloads.findLast(p => p.tools?.length && p.messages?.some(m => m.role === "user" && textOf(m.content).includes(MARK)));
  receipts = (last?.messages ?? []).filter(m => m.role === "tool").map(m => textOf(m.content).slice(0, 400));
  panelText = String(await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText ?? ""'));
  await rp.screenshot(panel, screenshot);

  assert.ok(ref, "snapshot exposed a @ref for the 保存 button");
  // 前提：第一次点击确实记成结果未知，且网站没收到。
  assert.match(receipts[3] ?? "", /结果未知/, "first click came back with an unknown result");
  assert.equal(savesAtReceipt[4], 0, "first click did not reach the site");
  // 第二次点击同一个目标：照常执行并送达。
  assert.doesNotMatch(receipts[5] ?? "", /结果未知|已暂停|不能自动重做|不重复执行|未执行/, "retry on the same target was not refused");
  assert.equal(saves, 1, "retry click reached the site once");
  // 侧栏：有最终回答，没有放弃或「没重做」的话，也没有把任务标成没做完。
  assert.ok(panelText.includes(FINAL), "final answer shown in the side panel");

  for (const phrase of ["没有重复执行", "已暂停", "不能自动重做", "查不清", "没算作完成", "还没全部完成"]) {
    assert.ok(!panelText.includes(phrase), `side panel does not say 「${phrase}」`);
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", ref, saves, savesAtReceipt, receipts, panelText, screenshot, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, ref, saves, savesAtReceipt, receipts: receipts.map(r => r.slice(0, 160)), error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
