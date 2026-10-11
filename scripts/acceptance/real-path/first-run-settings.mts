/** 设置页首启：一家没连时列表已展开、文字与实际状态一致；连上阶跃星辰后回到「已连接 + 其余」。
 * npx tsx scripts/acceptance/real-path/first-run-settings.mts --headless
 * 验收：docs/evals/20261011-first-run-settings.md。只读设置页上看得到的结果，不连真实模型。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-first-run-settings`);
await mkdir(out, { recursive: true });
const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;

/** 列表里出现首字就是缺图标。 */
const LETTER_ALLOWED: string[] = [];

try {
  const { targetId } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` });
  const page = await rp.attach(targetId);
  const text = async () => String(await rp.evaluate(page, "document.body.innerText"));
  const rendered = () => until(async () => (await rp.evaluate(page, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页渲染服务商");
  const shortcut = String(await until(async () => {
    await rendered();

    return rp.evaluate(page, `chrome.commands.getAll().then((all) => all.find((c) => c.name === "ask-selection")?.shortcut ?? "")`);
  }, 15_000, "读到快捷键"));
  // 快捷键文字在 getAll 回来后才写上。
  await until(async () => (await text()).includes(shortcut ? `按 ${shortcut}` : "chrome://extensions/shortcuts") || undefined, 5000, "划词一行写出快捷键");

  // 1. 全新配置，不点任何东西。
  const first = await rp.evaluate(page, `(() => {
    const row = document.querySelector('.provider-option[data-provider="stepfun"]')?.getBoundingClientRect();
    const letters = [...document.querySelectorAll(".plist .pv-letter")].map((el) => el.closest(".provider-option")?.dataset.provider).sort();
    return {
      open: document.querySelector("#provider-more").open,
      stepfunInFirstScreen: !!row && row.top >= 0 && row.bottom <= innerHeight,
      viewport: [innerWidth, innerHeight],
      label: document.querySelector("#provider-more-names .grp")?.textContent,
      letters,
      typesafe: !!document.querySelector('[data-provider="typesafe"]'),
      mainPick: document.querySelector("#main-pick").checkVisibility(),
      mainSelect: document.querySelector("#main-model").checkVisibility(),
      voiceNote: document.querySelector("#voice-key-note").textContent,
      voiceModel: document.querySelector("#voice-model-state").textContent,
    };
  })()`);
  await rp.screenshot(page, join(out, "1-first-screen.png"));
  const body = await text();
  evidence.first = { ...first, shortcut };
  assert.ok(first.open, "没有已连接服务商时，列表默认展开");
  assert.ok(first.stepfunInFirstScreen, "第一屏看得到「阶跃星辰」一行");
  assert.match(first.label, /^选一个服务商 · \d+$/);
  assert.ok(!body.includes("其余服务商"), "一家没连时不写「其余」");
  assert.ok(!body.includes("已经填了阶跃星辰的 key") && !body.includes("沿用"), "没有 key 时语音区不说已经填了、沿用");
  assert.match(first.voiceNote, /只给语音用/);
  assert.ok(first.mainPick && !first.mainSelect, "主模型一行是「去选服务商」按钮，不是只有一项的下拉");
  assert.ok(!first.typesafe && !body.includes("TypeSafe"), "列表里没有已退役的 TypeSafe");
  assert.deepEqual(first.letters, LETTER_ALLOWED, "每家都有品牌图标");
  assert.ok(shortcut, "全新配置有默认快捷键");

  if (process.platform === "linux") assert.ok(body.includes("Ctrl+J") && !body.includes("⌘"), "Linux 上写 Ctrl+J，不写 ⌘");

  // 2. 用户收起后，存储变化引起的重绘不把它再打开；「去选服务商」把列表打开并把焦点放到搜索框。
  await rp.click(page, "#provider-more > summary");
  await until(async () => !(await rp.evaluate(page, `document.querySelector("#provider-more").open`)) || undefined, 3000, "收起列表");
  await rp.evaluate(page, `chrome.storage.local.set({ inproc_voice_model: "stepaudio-3-realtime-preview" }).then(() => true)`);
  await sleep(800);
  assert.equal(await rp.evaluate(page, `document.querySelector("#provider-more").open`), false, "用户收起后保持收起");
  await rp.evaluate(page, `scrollTo(0, 0); true`);
  await rp.click(page, "#main-pick");
  const picked = await until(async () => {
    const state = await rp.evaluate(page, `({ open: document.querySelector("#provider-more").open, focus: document.activeElement?.id })`);

    return state.open && state.focus === "provider-search" ? state : undefined;
  }, 3000, "点「去选服务商」后列表展开、焦点在搜索框");
  evidence.pick = picked;
  await sleep(600);
  await rp.screenshot(page, join(out, "2-provider-list.png"));
  // 整个列表一张图，人看图标（#236 P2 由人看截图验收）。
  const clip = await rp.evaluate(page, `(() => { const r = document.querySelector(".plist").getBoundingClientRect(); return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 }; })()`);
  const { data } = await rp.cdp.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true }, page);
  await writeFile(join(out, "2b-provider-list-full.png"), Buffer.from(data, "base64"));

  // 3. 存入阶跃星辰主模型的 key（与设置页保存的格式相同），重开设置页。
  await rp.evaluate(page, `chrome.storage.local.set({ inproc_model_config: { provider: "stepfun", modelId: "step-3.7-flash" }, "inproc_cred:stepfun": { type: "api_key", key: "fixture-stepfun-key" } }).then(() => true)`);
  await rp.cdp.send("Page.reload", {}, page);
  await sleep(300);
  await rendered();
  const second = await until(async () => {
    const state = await rp.evaluate(page, `({
      connected: document.querySelector("#provider-connected .grp")?.textContent ?? "",
      label: document.querySelector("#provider-more-names .grp")?.textContent ?? "",
      open: document.querySelector("#provider-more").open,
      mainPick: document.querySelector("#main-pick").checkVisibility(),
      voiceNote: document.querySelector("#voice-key-note").textContent,
      voiceState: document.querySelector("#voice-state").textContent,
      voiceModel: document.querySelector("#voice-model-state").textContent,
    })`);

    return state.connected ? state : undefined;
  }, 10_000, "已连接组出现");
  evidence.connected = second;
  await rp.evaluate(page, `document.querySelector("#voice-title").scrollIntoView({ block: "start" }); true`);
  await rp.screenshot(page, join(out, "3-stepfun-connected-voice.png"));
  assert.match(second.connected, /^已连接 · 1$/);
  assert.match(second.label, /^其余服务商 · \d+$/);
  assert.equal(second.open, false, "有已连接服务商时其余默认折起");
  assert.equal(second.mainPick, false);
  assert.match(second.voiceNote, /正在沿用/);
  assert.match(second.voiceModel, /正在沿用/);
} catch (caught) { error = caught instanceof Error ? caught.stack ?? caught.message : String(caught); }
finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", error, evidence }, null, 2));
  await rp.close(); await rp.remove();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
