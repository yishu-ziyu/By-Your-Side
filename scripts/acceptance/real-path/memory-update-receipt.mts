/**
 * 改了一条记忆，回执写出新值和旧值，点「撤销」恢复旧值（YIS-85）。真实模型，只装扩展，无头。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/memory-update-receipt.mts --headless [--model=provider/id]
 * 失败方式：回执只写「记忆已更新」；没写旧值；点「撤销」只改了字，记忆库里生效的仍是新值。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-memory-update-receipt`);

await mkdir(artifacts, { recursive: true });

const rp = await launchRealPath();

let error: string | null = null;

let panel = "";

const evidence: JsonRecord = { model: modelArg };

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

// SAFETY: 页面脚本返回字符串数组。
const receipts = () => rp.evaluate(panel, `[...document.querySelectorAll(".memory-receipt")].map((e) => e.innerText)`) as Promise<string[]>;

const ask = async (text: string) => {
  const before = (await receipts()).length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 120_000, `回答「${text}」`, 500);

  return until(async () => { const all = await receipts();

 return all.length > before ? all.at(-1) : undefined; }, 30_000, `「${text}」的记忆回执`);
};

/** 记忆库里生效的记忆原文。 */
const active = async (): Promise<string[]> => {
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId as string;

  try {
    const ext = await rp.attach(target);
    await until(async () => (await rp.evaluate(ext, `location.protocol === "chrome-extension:" && document.readyState === "complete"`)) || undefined, 10_000, "扩展页");

    // SAFETY: 页面脚本返回 kv 里 memories 的 JSON 文本。
    const raw = await rp.evaluate(ext, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => rej(r.error);
      r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get("memories"); q.onsuccess = () => res(q.result ?? ""); q.onerror = () => rej(q.error); }; })`) as string;

    // SAFETY: memories 键由扩展写入，形状是 { entries: [{ text, status }] }。
    return raw ? (JSON.parse(raw) as { entries: Array<{ text: string; status: string }> }).entries.filter((e) => e.status === "active").map((e) => e.text) : [];
  } finally {
    await rp.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
  }
};

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");

  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "默认会话建好");

  evidence.saved = await ask("记住我住在北京");
  assert.match(String(evidence.saved), /已记住.*北京/, "第一句记下北京");

  evidence.updated = await ask("我搬到杭州了，记一下");
  await rp.screenshot(panel, join(artifacts, "updated.png"));
  assert.match(String(evidence.updated), /已更新：.*杭州.*（原来是.*北京.*）/, "回执写出新值和旧值");
  assert.match(String(evidence.updated), /撤销/, "回执带撤销");
  const beforeUndo = await active();
  evidence.beforeUndo = beforeUndo;
  assert.ok(beforeUndo.some((t) => t.includes("杭州")) && !beforeUndo.some((t) => t.includes("北京")), "更新后生效的是杭州");

  await rp.evaluate(panel, `[...document.querySelectorAll(".memory-receipt-updated [data-memory-undo]")].at(-1).click(), true`);
  await until(async () => (await receipts()).at(-1)?.includes("已撤销") || undefined, 15_000, "回执显示已撤销");
  evidence.undone = (await receipts()).at(-1);
  await rp.screenshot(panel, join(artifacts, "undone.png"));
  const afterUndo = await active();
  evidence.afterUndo = afterUndo;
  assert.ok(afterUndo.some((t) => t.includes("北京")) && !afterUndo.some((t) => t.includes("杭州")), "撤销后生效的回到北京");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => undefined);
  evidence.receipts = panel ? await receipts().catch(() => null) : null;
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
