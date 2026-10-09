/**
 * 上一个对话在这页留下一步「结果未知」后，新对话照样能在同一页上动手（docs/evals/20261010-drop-retry-locks.md R6）。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/tab-handover-after-unknown.mts --headless
 * 路径：对话一 snapshot 拿到「保存」的 @ref → 页面让按钮 3 秒内不可见 → click：回执「结果未知」，网站没收到 → 不重做，直接回答。
 * 等对话一空闲，新开对话二，同一页：snapshot → click「保存」→ 回答。
 * 判据：对话一的点击回执结果未知且网站没收到；对话二的点击送达（/save 计数 1）；对话二的回执和侧栏都没有「其他会话」。
 * 失败方式：恢复「旧对话有结果未知项就不让出标签页」的判定，对话二被「该页正在由其他会话使用」拦下，/save 停在 0。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-tab-handover-after-unknown`);

await mkdir(artifacts, { recursive: true });

const MARK_A = "交接一";
const MARK_B = "交接二";
const FINAL_A = `【${MARK_A}结束】`;
const FINAL_B = `【${MARK_B}结束】`;

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

// 点击目标在拿到各自对话的 snapshot 之后才知道：先占位，读到真实 @ref 后改写。
const clickA = { tool: { name: "click", args: { target: "@0" } } };
const clickB = { tool: { name: "click", args: { target: "@0" } } };

const stepsA: Step[] = [
  { tool: { name: "tabs", args: { action: "active" } } },
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "js", args: { code: "(() => { const b = document.querySelector('#save'); b.style.display = 'none'; setTimeout(() => { b.style.display = ''; }, 3000); return 'rerendering'; })()" } } },
  clickA,
  { text: FINAL_A },
];

const stepsB: Step[] = [
  { tool: { name: "tabs", args: { action: "active" } } },
  { tool: { name: "snapshot", args: {} } },
  clickB,
  { text: FINAL_B },
];

const lastPayload: Record<string, Payload> = {};
const savesAtReceipt: Record<string, Record<number, number>> = { [MARK_A]: {}, [MARK_B]: {} };

const model = await startScriptedModel([{ match: MARK_A, steps: stepsA }, { match: MARK_B, steps: stepsB }], undefined, payload => {
  // SAFETY: 脚本模型把产品的 OpenAI 兼容请求体原样交给这里；Payload 只取其中可选的 tools 与 messages。
  const p = payload as Payload;

  if (!p.tools?.length) return;
  const mark = [MARK_B, MARK_A].find(m => p.messages?.some(msg => msg.role === "user" && textOf(msg.content).includes(m)));

  if (!mark) return;
  lastPayload[mark] = p;
  const tools = (p.messages ?? []).filter(m => m.role === "tool");

  if (tools.length > 0 && !(tools.length in savesAtReceipt[mark]!)) savesAtReceipt[mark]![tools.length] = saves;
  const click = mark === MARK_A ? clickA : clickB;

  if (click.tool.args.target === "@0" && tools.length >= 2) {
    const line = textOf(tools[1]!.content).split(/\\n|\n/).find(l => l.includes('button "保存"'));
    const found = line?.match(/\[ref=(\d+)\]/)?.[1];

    if (found) click.tool.args.target = `@${found}`;
  }
});

const receiptsOf = (mark: string) => (lastPayload[mark]?.messages ?? []).filter(m => m.role === "tool").map(m => textOf(m.content).slice(0, 400));

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

const rp = await launchRealPath();
const screenshot = join(artifacts, "sidebar.png");
let error: string | null = null;
let receiptsA: string[] = [];
let receiptsB: string[] = [];
let panelTextB = "";

try {
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  const target = (await rp.cdp.send("Target.createTarget", { url: origin })).targetId as string;
  await rp.cdp.send("Target.activateTarget", { targetId: target });
  const work = await rp.attach(target);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.cdp.send("Target.activateTarget", { targetId: target });

  const ask = async (text: string, final: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `${idle} && document.querySelector("#messages")?.textContent.includes(${JSON.stringify(final)})`) || undefined, 90_000, final);
    await sleep(1500);
  };

  await ask(`${MARK_A}：把这页的草稿保存一下。`, FINAL_A);
  receiptsA = receiptsOf(MARK_A);
  // 前提：对话一的点击记成结果未知，网站没收到。
  assert.match(receiptsA[3] ?? "", /结果未知/, "conversation A click came back with an unknown result");
  assert.equal(saves, 0, "conversation A click did not reach the site");

  // 对话一让按钮暂时不可见：等它回来，对话二的 snapshot 才看得到。
  await until(async () => await rp.evaluate(work, 'document.querySelector("#save")?.style.display === ""') || undefined, 10_000, "save button visible again");
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "new conversation");
  await rp.cdp.send("Target.activateTarget", { targetId: target });
  await ask(`${MARK_B}：把这页的草稿保存一下。`, FINAL_B);

  receiptsB = receiptsOf(MARK_B);
  panelTextB = String(await rp.evaluate(panel, `[...document.querySelectorAll(".msg")].slice(-6).map(m => m.innerText).join("\\n")`));
  await rp.screenshot(panel, screenshot);

  assert.notEqual(clickB.tool.args.target, "@0", "conversation B snapshot exposed a @ref for the 保存 button");
  assert.equal(savesAtReceipt[MARK_B]![3], 1, "conversation B click reached the site");
  assert.equal(saves, 1, "site received exactly one save");

  for (const receipt of receiptsB) assert.ok(!receipt.includes("其他会话"), `conversation B receipt not blocked by another conversation: ${receipt.slice(0, 120)}`);
  assert.ok(!panelTextB.includes("其他会话"), "side panel does not mention 其他会话");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", refs: { A: clickA.tool.args.target, B: clickB.tool.args.target }, saves, savesAtReceipt, receiptsA, receiptsB, panelTextB, screenshot, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, saves, savesAtReceipt, receiptsB: receiptsB.map(r => r.slice(0, 160)), error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
