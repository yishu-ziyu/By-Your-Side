/**
 * 结果账本满了，用户插一句话之后助手还能接着动手（PR 描述有标准）：
 * 一件事里登记满 64 项，下一个动作被拒；用户在任务进行中插话，已完成的结果收起来，助手重试同一个动作，网页上真的做成了；
 * 没做成的那一项还在账上。只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/ledger-full-interject.mts --headless
 * 失败方式：插话之后重试仍被拒（网页上的格子是空的）；或没做成的那一项被一起收掉了。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-ledger-full-interject`);

await mkdir(artifacts, { recursive: true });

const TASK = "把这一页一张一张翻过去，最后在格子里写上完成";

const ADD = "翻完了就在格子里写完成";

const FULL = "结果账本已满";

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>翻页</title><h1>翻页</h1><input id=\"final\" aria-label=\"结果\">");
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

// 一项没做成（点一个不存在的按钮）+ 63 次打开不同的页 = 账本 64 项；第 65 个动作（写格子）被拒。
// 被拒之后读一次标签页，挂 4 秒：测试在这期间插话。之后重试写格子。
const steps: Step[] = [
  { tool: { name: "click", args: { target: "#missing-button", label: "不存在的按钮" } } },
  ...Array.from({ length: 63 }, (_, i): Step => ({ tool: { name: "navigate", args: { url: `${origin}/page?n=${i + 1}` } } })),
  { tool: { name: "fill", args: { target: "#final", value: "完成" } } },
  { tool: { name: "tabs", args: { action: "list" } }, delayMs: 4_000 },
  { tool: { name: "fill", args: { target: "#final", value: "完成" } } },
  { text: "翻完了，格子里写上了完成。" },
];

/** 主模型收到的工具结果里出现过的「账本已满」拒绝。 */
const refusals: string[] = [];

const model = await startScriptedModel([{ match: TASK, steps }], undefined, payload => {
  for (const message of payload.messages ?? []) {
    const text = typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("");

    if (message.role === "tool" && text.includes(FULL) && !refusals.includes(text)) refusals.push(text);
  }
});

const rp = await launchRealPath();

let error: string | null = null;

/** 写进 result.json 的证据。 */
interface Evidence { refusedBeforeInterjection?: boolean; finalValue?: string; outstanding?: string[]; resultsAfter?: number; foldedShown?: unknown }

const evidence: Evidence = {};

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/page` }, work);
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  // 在侧栏页面里另开一条面板端口，收后台转来的任务视图（还没做的项、账上的项）。
  await rp.evaluate(panel, `(() => {
    window.__views = [];
    const port = chrome.runtime.connect({ name: "sideagent-panel" });
    port.onMessage.addListener(m => { if (m.kind === "server" && m.msg?.type === "task_view") window.__views.push(m.msg.view); });
    return true;
  })()`);

  const send = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
  };

  await send(TASK);
  await until(async () => refusals.length > 0 || undefined, 180_000, "the write after 64 results was refused", 100);
  evidence.refusedBeforeInterjection = true;
  // 被拒之后模型读标签页、挂 4 秒：这时插话。
  await sleep(1_000);
  await send(ADD);
  const finalValue = async () => String(await rp.evaluate(work, 'document.querySelector("#final")?.value ?? ""'));
  await until(async () => (await finalValue()) === "完成" || undefined, 60_000, "the retried write landed on the page", 200);
  evidence.finalValue = await finalValue();
  await until(async () => !(await rp.evaluate(panel, 'document.querySelector("#status-pill")?.classList.contains("running")')) || undefined, 60_000, "run idle");
  await sleep(500);
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  // SAFETY: 后台转来的 TaskView；只读 outstanding 和 results 两个数组。
  const view = (await rp.evaluate(panel, "window.__views.at(-1) ?? null")) as { outstanding?: Array<{ description: string; status: string }>; results?: unknown[] } | null;
  evidence.outstanding = view?.outstanding?.map(item => `${item.status}:${item.description}`) ?? [];
  evidence.resultsAfter = view?.results?.length;
  assert.equal(evidence.finalValue, "完成", "the field holds the value written after the interjection");
  assert.ok(evidence.outstanding.some(item => item.includes("不存在的按钮")), `the unfinished item is still on the ledger (${JSON.stringify(evidence.outstanding)})`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, refusals: refusals.map(text => text.slice(0, 200)), error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
