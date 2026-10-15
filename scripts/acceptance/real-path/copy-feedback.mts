/**
 * 回答下点「复制」：按钮原地变成一笔画出的对勾和「已复制」，1.5 秒后变回「复制」；旁边的按钮不挪位置；读屏念「已复制」但屏幕上不多一行字。
 *   npx tsx scripts/acceptance/real-path/copy-feedback.mts --headless
 * 脚本模型答一句话，只装扩展。剪贴板只记下产品交给 navigator.clipboard 的字，不读系统剪贴板。
 * 失败方式：点了没出对勾；对勾不是画出来的（一上来就画满）；1.5 秒后没变回或一直留着「已复制」；「…」挪了位置；
 * 屏幕上多出一行「已复制」；剪贴板没拿到回答；少动效设置下还在画线。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-copy-feedback`);

await mkdir(artifacts, { recursive: true });

const ASK = "这个网站是哪家公司运营的？";

const ANSWER = "比价小站由 Lumen Labs 运营。";

const model = await startScriptedModel([{ match: ASK, steps: [{ text: ANSWER }] }]);

const rp = await launchRealPath();

const evidence: Record<string, unknown> = {};

let error: string | null = null;

let stopVideo: (() => Promise<string | null>) | null = null;

/** 当下用户看得到的样子：哪一面显示、对勾画了多少、「…」在哪、末尾有没有一行看得见的字。 */
const STATE = `(() => {
  const b = document.querySelector(".msg.assistant .answer-primary");
  const faces = [...b.querySelectorAll(".answer-face")];
  const op = (el) => el ? Number(getComputedStyle(el).opacity) : null;
  const path = b.querySelector(".answer-face-done svg path");
  const more = document.querySelector(".msg.assistant .answer-command-btn").getBoundingClientRect();
  const fb = document.querySelector(".msg.assistant .answer-action-feedback");
  const fr = fb.getBoundingClientRect();
  return { copied: b.classList.contains("copied"), idle: op(faces[0]), done: op(faces[1]), dash: path ? Number(getComputedStyle(path).strokeDashoffset.replace("px", "")) : null,
    moreX: Math.round(more.left), feedbackText: fb.textContent, feedbackVisible: fr.width > 2 && fr.height > 2 && getComputedStyle(fb).display !== "none", copiedText: window.__copied?.at(-1) ?? null };
})()`;

type State = { copied: boolean; idle: number | null; done: number | null; dash: number | null; moreX: number; feedbackText: string; feedbackVisible: boolean; copiedText: string | null };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await rp.evaluate(panel, `(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; return true; })()`);
  stopVideo = await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")).catch(() => null);

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector(".msg.assistant .answer-primary .answer-face")`)) || undefined, 60_000, "回答下出现复制按钮");
  await sleep(800);
  const read = async () => await rp.evaluate(panel, STATE) as State; // SAFETY: STATE 返回上面这个形状。

  const before = await read();
  // 点下后第一帧就记下对勾画了多少：等截图或读数回来时可能已经画完。
  await rp.evaluate(panel, `(() => { const b = document.querySelector(".msg.assistant .answer-primary"); new MutationObserver((_, o) => { if (!b.classList.contains("copied")) return; o.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__dashAtStart = Number(getComputedStyle(b.querySelector(".answer-face-done svg path")).strokeDashoffset.replace("px", "")); })); }).observe(b, { attributes: true, attributeFilter: ["class"] }); return true; })()`);
  await rp.click(panel, ".msg.assistant .answer-primary");
  await sleep(90);
  const drawing = { ...(await read()), dash: Number(await rp.evaluate(panel, `window.__dashAtStart ?? -1`)) };
  await sleep(400);
  const shown = await read();
  await rp.screenshot(panel, join(artifacts, "copied.png"));
  await sleep(1500);
  const back = await read();

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  await rp.click(panel, ".msg.assistant .answer-primary");
  await sleep(40);
  const reduced = await read();
  Object.assign(evidence, { before, drawing, shown, back, reduced });

  assert.ok(!before.copied && before.idle === 1 && before.done === 0, `点之前显示「复制」：${JSON.stringify(before)}`);
  assert.ok(drawing.copied && drawing.dash !== null && drawing.dash > 0.05, `对勾是一笔画出来的，刚点时还没画完：${JSON.stringify(drawing)}`);
  assert.ok(shown.done === 1 && shown.idle === 0 && shown.dash === 0, `点后显示画好的对勾和「已复制」：${JSON.stringify(shown)}`);
  assert.equal(shown.moreX, before.moreX, "「…」不挪位置");
  assert.ok(shown.feedbackText === "已复制" && !shown.feedbackVisible, `读屏念「已复制」，屏幕上不多一行字：${JSON.stringify(shown)}`);
  assert.equal(shown.copiedText, ANSWER, "剪贴板拿到回答");
  assert.ok(!back.copied && back.idle === 1 && back.feedbackText === "", `1.5 秒后变回「复制」：${JSON.stringify(back)}`);
  assert.ok(reduced.copied && reduced.dash === 0, `少动效设置下不画线，直接显示对勾：${JSON.stringify(reduced)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  evidence.video = await stopVideo?.().catch(() => null) ?? null;
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
