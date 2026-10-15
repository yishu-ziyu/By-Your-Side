/**
 * 两个侧栏页面各看各的会话（docs/evals/20261015-per-panel-conversation.md）。
 *   甲 侧栏 A 问一句，答完。
 *   乙 第二个窗口开侧栏 B：先跟 A 看同一个会话；B 点「新会话」再问一句，A 仍是甲会话。
 *   丙 A 点「新会话」，问一句慢慢写出来的；写的过程中和写完后，B 都只有乙会话，没有这段字。
 *   丁 A 从会话菜单切回甲会话，B 不动。
 *   戊 刷新 B：回放的仍是乙会话的问答，不是 A 正在看的会话。
 * 失败方式：一个侧栏切会话，另一个跟着切；A 正在写的回答出现在 B；刷新 B 后换成 A 的会话。
 * 产物：out/acceptance/real-path/<时间>-per-panel-conversation/*.png、result.json。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = process.env.OUT ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-per-panel-conversation`);

await mkdir(artifacts, { recursive: true });

const ASK = { a: "甲会话问题", b: "乙会话问题", slow: "丙慢慢说" };

const ANSWER = { a: "甲答完了。", b: "乙答完了。", slow: `丙开始写。${"丙一段一段地写出来，".repeat(10)}丙写完了。` };

// 任务请求带上当前标签页的文字（第二个侧栏开在标签页里，会带上别的会话的问题），脚本模型按顺序挑第一条匹配的：后问的排前面。
const model = await startScriptedModel([
  { match: ASK.slow, steps: [{ text: ANSWER.slow, chunkDelayMs: 250 }] },
  { match: ASK.b, steps: [{ text: ANSWER.b }] },
  { match: ASK.a, steps: [{ text: ANSWER.a }] },
]);

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let a = "";

let b = "";

try {
  a = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(a, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "test-key" },
  })}).then(() => true)`);

  const text = async (panel: string) => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'));
  const ready = (panel: string, label: string) => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, label);
  const shows = (panel: string, needle: string, label: string, ms = 40_000) => until(async () => (await text(panel)).includes(needle) || undefined, ms, label);
  const send = async (panel: string, ask: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, ask);
    await rp.pressEnter(panel);
  };
  const newConversation = async (panel: string, label: string) => {
    const before = await text(panel);
    await rp.click(panel, "#conversation-new");
    await until(async () => (await text(panel)) !== before && !(await text(panel)).includes(ASK.a) || undefined, 15_000, label);
    await ready(panel, `${label}：可以输入`);
  };

  evidence.stage = "甲";
  await ready(a, "甲：侧栏 A 就绪");
  await send(a, ASK.a);
  await shows(a, ANSWER.a, "甲：A 看到回答");

  evidence.stage = "乙";
  const extensionId = String(await rp.evaluate(a, "chrome.runtime.id"));
  b = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/sidepanel.html`, newWindow: true })).targetId);
  await shows(b, ANSWER.a, "乙：新开的 B 先显示 A 的会话");
  await newConversation(b, "乙：B 换到新会话");
  await send(b, ASK.b);
  await shows(b, ANSWER.b, "乙：B 看到回答");
  await sleep(1_000);
  const aAfterB = await text(a);
  assert.ok(aAfterB.includes(ANSWER.a) && !aAfterB.includes(ASK.b), "乙：B 新建会话并提问后，A 仍是甲会话");

  evidence.stage = "丙";
  await newConversation(a, "丙：A 换到新会话");
  assert.ok((await text(b)).includes(ANSWER.b), "丙：A 新建会话后，B 仍是乙会话");
  await send(a, ASK.slow);
  await shows(a, "丙开始写", "丙：A 开始写");
  const during: string[] = [];

  while (!(await text(a)).includes("丙写完了")) {
    const seen = await text(b);
    during.push(seen.includes("丙") ? "B 出现了丙" : "B 没有丙");
    assert.ok(!seen.includes("丙"), "丙：A 写的过程中，B 不出现这段字");
    assert.ok(seen.includes(ANSWER.b), "丙：A 写的过程中，B 仍是乙会话");
    await sleep(300);
  }

  evidence.slowSamples = during.length;
  assert.ok(during.length >= 3, "丙：至少在写的过程中看了 B 三次");
  await rp.screenshot(a, join(artifacts, "a-streaming-done.png"));
  await rp.screenshot(b, join(artifacts, "b-while-a-streams.png"));
  assert.ok(!(await text(b)).includes("丙"), "丙：A 写完后，B 也没有这段字");

  evidence.stage = "丁";
  await rp.click(a, "#conversation-switcher");
  await sleep(200);
  await rp.click(a, `#conversation-menu [data-conversation-id][title*="${ASK.a}"]`);
  await shows(a, ANSWER.a, "丁：A 切回甲会话");
  await sleep(1_000);
  const bAfterSwitch = await text(b);
  assert.ok(bAfterSwitch.includes(ANSWER.b) && !bAfterSwitch.includes(ASK.a), "丁：A 切会话后，B 仍是乙会话");

  evidence.stage = "戊";
  await rp.evaluate(b, "setTimeout(() => location.reload(), 0), true");
  await sleep(1_500);
  await shows(b, ANSWER.b, "戊：刷新后 B 回放乙会话");
  await sleep(1_500);
  const bReloaded = await text(b);
  assert.ok(!bReloaded.includes(ASK.a) && !bReloaded.includes("丙"), "戊：刷新后 B 没有换成 A 的会话");
  assert.ok((await text(a)).includes(ANSWER.a), "戊：刷新 B 后 A 仍是甲会话");
  await rp.screenshot(b, join(artifacts, "b-after-reload.png"));

  evidence.stage = "done";
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  for (const [name, panel] of [["a", a], ["b", b]] as const) {
    if (!panel) continue;
    evidence[`messages_${name}`] = await rp.evaluate(panel, '[...document.querySelectorAll("#messages > *")].map(el => `${el.className}: ${el.textContent.slice(0, 80)}`)').catch(() => null);
    await rp.screenshot(panel, join(artifacts, `failure-${name}.png`)).catch(() => undefined);
  }
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(artifacts);

if (error) {
  console.error(error);
  process.exitCode = 1;
}
