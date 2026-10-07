/**
 * 输入框左下角「模型 · 快/深入」（docs/evals/20261007-thinking-chip.md）：看得到、点得开、选了真的换档、关掉侧栏再开还记得。真实模型，只装扩展，无头，全程录侧栏。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/thinking-chip.mts --headless [--model=provider/id]
 * 失败方式：开关不出现或没写模型名；选「深入」后助手仍用低档；选「快」后仍用高档；重开侧栏后忘了选过什么。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-thinking-chip`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>团队周报</title><h1>团队周报</h1><p>本周完成 12 项，延期 2 项。负责人：李雷。</p>`);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();

const evidence: JsonRecord = { model: modelArg };

let error: string | null = null;

let panel = "";

let stopVideo: (() => Promise<string | null>) | null = null;

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

const chipText = async () => String(await rp.evaluate(panel, `(() => { const c = document.querySelector("#think-chip"); return c && !c.hidden ? c.innerText.replace(/\\s+/g, " ").trim() : ""; })()`));

const ask = async (text: string) => {
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 180_000, text, 500);
};

const pick = async (label: "快" | "深入") => {
  await rp.click(panel, "#think-chip");
  await sleep(350);
  await rp.screenshot(panel, join(artifacts, `menu-${label}.png`));
  await rp.evaluate(panel, `[...document.querySelectorAll("#think-menu [role=menuitemradio]")].find(b => b.querySelector("span").textContent === ${JSON.stringify(label)}).click(), true`);
  await sleep(300);
};

const openPanel = async () => {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
};

try {
  const base = `http://127.0.0.1:${siteAddress(site).port}/`;
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  await rp.cdp.send("Target.createTarget", { url: base });
  await openPanel();
  stopVideo = await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")).catch(() => null);

  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await until(async () => (await chipText()) || undefined, 60_000, "输入框旁出现模型与思考强度");
  evidence.chipStart = await chipText();
  await rp.screenshot(panel, join(artifacts, "chip.png"));

  await pick("深入");
  evidence.chipDeep = await chipText();
  await ask("这页写了什么？一句话回答。");

  await pick("快");
  evidence.chipFast = await chipText();
  await ask("负责人是谁？一句话回答。");

  // 关掉侧栏再开：还记得选过「快」以外的选择。先选回「深入」再重开。
  await pick("深入");
  await rp.cdp.send("Target.closeTarget", { targetId: (await rp.targets()).find((t) => t.url.includes("sidepanel"))!.targetId }).catch(() => undefined);
  await sleep(1000);
  await openPanel();
  await until(async () => (await chipText()) || undefined, 60_000, "重开后输入框旁出现开关");
  evidence.chipReopened = await chipText();

  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  // SAFETY: 诊断记录每行是 { runId, type, data } 的 JSON。
  const lines = traces.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { runId?: string; type: string; data?: { text?: string; effort?: string } });
  const effortsOf = (text: string) => {
    const runId = lines.find((l) => l.type === "run_start" && l.data?.text?.includes(text))?.runId;

    return lines.filter((l) => l.runId === runId && l.type === "model_request").map((l) => l.data?.effort ?? "?");
  };
  evidence.effortDeep = effortsOf("这页写了什么");
  evidence.effortFast = effortsOf("负责人是谁");

  assert.match(String(evidence.chipStart), /· 快/, "一开始是「快」");
  assert.match(String(evidence.chipDeep), /· 深入/, "选了深入，按钮写深入");
  assert.ok((evidence.effortDeep as string[]).length > 0 && (evidence.effortDeep as string[]).every((e) => e === "high"), `选深入后用高档：${JSON.stringify(evidence.effortDeep)}`);
  assert.ok((evidence.effortFast as string[]).length > 0 && (evidence.effortFast as string[]).every((e) => e === "low"), `选快后用低档：${JSON.stringify(evidence.effortFast)}`);
  assert.match(String(evidence.chipReopened), /· 深入/, "重开侧栏还记得选了深入");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
} finally {
  evidence.video = await stopVideo?.().catch(() => null) ?? null;
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
