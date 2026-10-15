/**
 * 回答里的代码块：上面一条写着语言名，右边「不换行」和「复制」；默认换行，窄侧栏不出横向滚动条；点「复制」只复制代码，按钮原地变成「已复制」再变回。
 *   npx tsx scripts/acceptance/real-path/code-block-header.mts --headless
 * 脚本模型慢慢答一段话，中间一个 ```js 代码块，第一行比侧栏宽。只装扩展。剪贴板只记下产品交给 navigator.clipboard 的字，不读系统剪贴板。
 * 失败方式：没有那一条或语言名不对；流式输出时代码块先出来、那一条后到（字会跳）；默认还有横向滚动条；点「换行」不能回到横向滚动；
 * 复制到的不是代码原文；没变成「已复制」或 1.5 秒后没变回；整段「复制」把条上的字也复制进去。
 * 截图：400 宽和 300 宽各一张（before / after 对比时，用 SIDEAGENT_ACCEPTANCE_DIST 指到旧版构建再跑一次）。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-code-block-header`);

await mkdir(artifacts, { recursive: true });

const ASK = "怎么把这个页面上的价格读出来？";

const CODE = "const price = document.querySelector('h1').textContent.replace(/[^0-9.]/g, '').trim(); // 读出标题里的价格数字\nconsole.log(Number(price));";

const ANSWER = `可以用这段脚本把页面价格读出来：\n\n\`\`\`js\n${CODE}\n\`\`\`\n\n读出来的是数字，可以直接拿去比价。`;

const model = await startScriptedModel([{ match: ASK, steps: [{ text: ANSWER, chunkDelayMs: 80 }] }]);

const rp = await launchRealPath();

const evidence: Record<string, unknown> = {};

let error: string | null = null;

/** 用户看得到的那一块：条上写的字、两面哪面显示、代码区有没有横向滚动。 */
const STATE = `(() => {
  const block = document.querySelector(".msg.assistant .code-block");
  const pre = document.querySelector(".msg.assistant pre");
  const shown = (el, pseudo) => el ? getComputedStyle(el, pseudo).content.replace(/^"|"$/g, "") : null;
  const op = (el) => el ? Number(getComputedStyle(el).opacity) : null;
  return { label: shown(block?.querySelector(".code-block-lang"), "::before"), wrap: shown(block?.querySelector(".code-block-wrap"), "::before"),
    copy: op(block?.querySelector(".code-block-face:not(.code-block-face-done)")), copied: op(block?.querySelector(".code-block-face-done")),
    copiedLabel: shown(block?.querySelector(".code-block-face-done"), "::before"),
    scrollWidth: pre?.scrollWidth ?? null, clientWidth: pre?.clientWidth ?? null, clipboard: window.__copied?.at(-1) ?? null };
})()`;

type State = { label: string | null; wrap: string | null; copy: number | null; copied: number | null; copiedLabel: string | null; scrollWidth: number | null; clientWidth: number | null; clipboard: string | null };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await rp.evaluate(panel, `(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; return true; })()`);
  // 代码第一次出现在页面上的那一帧：那一条在不在、回答写完没有。
  await rp.evaluate(panel, `(() => { new MutationObserver((_, o) => { const pre = document.querySelector(".msg.assistant pre"); if (!pre) return; o.disconnect(); window.__firstPre = { head: !!pre.closest(".code-block")?.querySelector(".code-block-head"), finished: !!document.querySelector(".msg.assistant .answer-primary") }; }).observe(document.body, { childList: true, subtree: true }); return true; })()`);

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector(".msg.assistant .answer-primary")`)) || undefined, 60_000, "回答写完");
  await sleep(800);
  const read = async () => await rp.evaluate(panel, STATE) as State; // SAFETY: STATE 返回上面这个形状。
  evidence.firstPre = await rp.evaluate(panel, `window.__firstPre ?? null`);

  await rp.evaluate(panel, `document.querySelector(".msg.assistant pre").scrollIntoView({ block: "center" }); true`);
  await sleep(200);
  await rp.screenshot(panel, join(artifacts, "400.png"));
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 300, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(300);
  await rp.evaluate(panel, `document.querySelector(".msg.assistant pre").scrollIntoView({ block: "center" }); true`);
  await sleep(200);
  await rp.screenshot(panel, join(artifacts, "300.png"));
  const narrow = await read();
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(300);

  const before = await read();
  await rp.click(panel, ".msg.assistant .code-block-wrap");
  await sleep(200);
  const unwrapped = await read();
  await rp.screenshot(panel, join(artifacts, "400-nowrap.png"));
  await rp.click(panel, ".msg.assistant .code-block-wrap");
  await sleep(200);
  const rewrapped = await read();

  await rp.click(panel, ".msg.assistant .code-block-copy");
  await sleep(400);
  const copied = await read();
  await rp.screenshot(panel, join(artifacts, "400-copied.png"));
  await sleep(1500);
  const back = await read();

  await rp.click(panel, ".msg.assistant .answer-primary");
  await sleep(300);
  const whole = await read();
  Object.assign(evidence, { narrow, before, unwrapped, rewrapped, copied, back, wholeAnswer: whole.clipboard });

  assert.equal(before.label, "JavaScript", "代码块上方写着 JavaScript");
  assert.deepEqual(evidence.firstPre, { head: true, finished: false }, "流式输出时代码一出来那一条就在");
  assert.ok(before.wrap === "不换行" && before.scrollWidth !== null && before.scrollWidth <= before.clientWidth!, `默认换行，400 宽没有横向滚动：${JSON.stringify(before)}`);
  assert.ok(narrow.scrollWidth !== null && narrow.scrollWidth <= narrow.clientWidth!, `300 宽也没有横向滚动：${JSON.stringify(narrow)}`);
  assert.ok(unwrapped.wrap === "换行" && unwrapped.scrollWidth! > unwrapped.clientWidth!, `点「不换行」后长行横向滚动：${JSON.stringify(unwrapped)}`);
  assert.ok(rewrapped.wrap === "不换行" && rewrapped.scrollWidth! <= rewrapped.clientWidth!, `再点「换行」回到换行：${JSON.stringify(rewrapped)}`);
  assert.equal(copied.clipboard, CODE, "「复制」只复制代码原文");
  assert.ok(copied.copied === 1 && copied.copy === 0 && copied.copiedLabel === "已复制", `点后显示「已复制 ✓」：${JSON.stringify(copied)}`);
  assert.ok(back.copied === 0 && back.copy === 1, `1.5 秒后变回「复制」：${JSON.stringify(back)}`);
  assert.ok(whole.clipboard && whole.clipboard.includes("console.log") && !/JavaScript|不换行|已复制/.test(whole.clipboard), `整段「复制」不带条上的字：${JSON.stringify(whole.clipboard)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
