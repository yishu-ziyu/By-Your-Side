/** 设置页「各模型速度」：点「测一下」，已连接的模型各问一遍同一个问题，每行写出几秒开口、答没答对；连不上的写「不能用」。
 * npx tsx scripts/acceptance/real-path/model-speed-test.mts --headless
 * 用真实模型：ChatGPT 登录取自 Pi，阶跃取 ~/.sideagent/step-plan.key；MiniMax 故意填一把坏 key。
 */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";
import { loadModelPlan } from "./inproc-config.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-model-speed-test`);
await mkdir(out, { recursive: true });
const codex = await loadModelPlan("openai-codex/gpt-6-luna");
const stepKey = (await readFile(join(homedir(), ".sideagent/step-plan.key"), "utf8")).trim();
const rp = await launchRealPath();
let error: string | null = null;
let rows: Array<{ model: string; state: string; result: string }> = [];

try {
  const { targetId } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` });
  const page = await rp.attach(targetId);
  await until(async () => (await rp.evaluate(page, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页渲染服务商");
  await rp.evaluate(page, `chrome.storage.local.set(${JSON.stringify({
    "inproc_cred:openai-codex": codex.credential,
    "inproc_cred:stepfun": { type: "api_key", key: stepKey },
    "inproc_cred:minimax-cn": { type: "api_key", key: "sk-cp-broken-key-for-acceptance" },
    inproc_model_config: { provider: "stepfun", modelId: "step-5-preview" },
    inproc_fast_model_config: { provider: "openai-codex", modelId: "gpt-6-luna" },
  })}).then(() => location.reload())`);
  await until(async () => (await rp.evaluate(page, `!!document.querySelector("#speed-test") && document.querySelector('.provider-option[data-provider="stepfun"]')?.innerText.includes("使用中")`)) || undefined, 15_000, "设置页读到已连接的服务商");
  await rp.click(page, "#speed-test");
  await until(async () => (await rp.evaluate(page, `document.querySelectorAll(".speed-row").length`)) > 0 || undefined, 5000, "出现测速列表");
  await until(async () => (await rp.evaluate(page, `[...document.querySelectorAll(".speed-row")].every((r) => r.dataset.state)`)) || undefined, 120_000, "每一行都有结果");
  rows = (await rp.evaluate(page, `[...document.querySelectorAll(".speed-row")].map((r) => ({ model: r.dataset.model, state: r.dataset.state, result: r.querySelector(".speed-name").textContent + " → " + r.querySelector(".speed-result").textContent }))`)) as typeof rows;
  await rp.screenshot(page, join(out, "speed.png"));
  const models = rows.map((r) => r.model);

  assert.deepEqual(models.slice(0, 2), ["stepfun/step-5-preview", "openai-codex/gpt-6-luna"], "主模型、快速模型排在最前");
  assert.match(rows[0]!.result, /（主模型）/, "主模型那一行标出「主模型」");
  assert.match(rows[1]!.result, /（快速模型）/, "快速模型那一行标出「快速模型」");
  for (const m of ["stepfun/step-3.7-flash", "openai-codex/gpt-6.1-sol", "minimax-cn/MiniMax-M2.7-highspeed"]) assert.ok(models.includes(m), `测了 ${m}`);
  assert.ok(!models.some((m) => m.startsWith("kimi-coding/") || m.startsWith("opencode-go/")), "没连的服务商不测");
  assert.equal(rows.find((r) => r.model === "minimax-cn/MiniMax-M2.7-highspeed")?.state, "fail", "坏 key 那一行写「不能用」");
  assert.match(rows.find((r) => r.model === "minimax-cn/MiniMax-M2.7-highspeed")?.result ?? "", /不能用/);

  for (const r of rows.filter((x) => !x.model.startsWith("minimax-cn/"))) {
    assert.match(r.result, /\d+(\.\d)? 秒开口 · 答(对|错)/, `${r.model} 写出几秒开口和对错：${r.result}`);
  }
  assert.ok(rows.some((r) => r.state === "ok"), "至少一个模型答对");
  assert.match(String(await rp.evaluate(page, `document.querySelector(".speed-note")?.textContent ?? ""`)), /共用 \d+ 秒/);
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
} finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ case: "model-speed-test", ok: !error, error, rows }, null, 2));
  await rp.close();
}

console.log(rows.map((r) => r.result).join("\n"));
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", error, out }, null, 2));
process.exit(error ? 1 : 0);
