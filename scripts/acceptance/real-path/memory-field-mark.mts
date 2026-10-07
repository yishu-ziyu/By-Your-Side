/**
 * 按记忆填的那一格带「记得的」记号（YIS-87 第一步）。真实模型，只装扩展，无头。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/memory-field-mark.mts --headless [--model=provider/id]
 * 失败方式：按记忆填的邮箱没有记号；不是记忆的备注也带了记号；记号改了网页的值或留下属性；你自己改了这一格记号还在。
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const email = `mark-${randomBytes(3).toString("hex")}@example.com`;

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-memory-field-mark`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>报名表</title>
<style>body{font:16px system-ui;margin:40px} label{display:block;margin:14px 0} input{font:16px system-ui;width:320px;padding:8px 10px;border:1px solid #bbb;border-radius:6px}</style>
<h1>报名表</h1><label>邮箱 <input id="email" name="email" aria-label="邮箱"></label><label>备注 <input id="note" name="note" aria-label="备注"></label>`);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();

let error: string | null = null;

let panel = "";

let work = "";

const evidence: JsonRecord = { model: modelArg, email };

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

const ask = async (text: string) => {
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 180_000, `回答「${text.slice(0, 12)}」`, 500);
};

type PageView = { email: string; note: string; marks: string[]; leftover: number };

// SAFETY: 页面脚本返回与 PageView 一一对应的字段。
const page = () => rp.evaluate(work, `({ email: email.value, note: note.value,
  marks: [...document.querySelectorAll('[data-sideagent-overlay="memory-field"]')].map((h) => h.dataset.memoryId),
  leftover: document.querySelectorAll("[data-sideagent-memory-field]").length })`) as Promise<PageView>;

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");

  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "默认会话建好");

  await ask(`记住我的邮箱是 ${email}`);

  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  const tab = (await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${siteAddress(site).port}/` })).targetId as string;
  await rp.cdp.send("Target.activateTarget", { targetId: tab });
  work = await rp.attach(tab);
  await sleep(1000);
  await ask("帮我填当前网页的报名表：邮箱填我的邮箱，备注写「第一次参加」。不用提交。");

  const filled = await until(async () => { const v = await page();

 return v.email && v.note ? v : undefined; }, 20_000, "两格都填上");

  await sleep(800);
  const view = await page();
  evidence.filled = view;
  await rp.screenshot(work, join(artifacts, "marked.png"));
  assert.equal(filled.email, email, "邮箱一格的值就是记住的邮箱，没有多余内容");
  assert.equal(view.marks.length, 1, "只有一格带记号（邮箱），备注没有");
  assert.equal(view.leftover, 0, "网页元素上没有留下记号属性");

  // 你自己在邮箱一格里打一个字（真实键盘输入）：记号消失。
  await rp.evaluate(work, `email.focus(); email.setSelectionRange(email.value.length, email.value.length); true`);
  await rp.cdp.send("Input.insertText", { text: "x" }, work);
  await sleep(500);
  const edited = await page();
  evidence.edited = edited;
  assert.equal(edited.marks.length, 0, "你改过这一格后记号消失");
  await rp.screenshot(work, join(artifacts, "edited.png"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => undefined);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
  evidence.panelText = panel ? await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.slice(-1500)`).catch(() => null) : null;
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
