/**
 * 模型的输出切在链接中间（网址里、方括号前后、裸网址中间）时，回答显示完后每个链接的文字和地址都完整，链接外没有多出来的字；
 * 切在代码块语言名中间（「```j」「s」）时，写代码的过程中语言名一直是完整的，代码里没有混进语言名的后半截。
 *   npx tsx scripts/acceptance/real-path/stream-link-split.mts --headless
 * 脚本模型按给定的段写一段回答，每段之间停 700ms，让侧栏先把前半截放出来。只装扩展。
 * 失败方式：后半截网址被接进链接文字里，链接地址停在「https:」；「[来源]」后面接上的「(网址)」露成原文；裸网址只有前半截能点；
 * 代码块那一条写着「j」，代码以「s」开头，直到代码块写完才变对。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";
import { startScriptedModel, type TextStep } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-stream-link-split`);

await mkdir(artifacts, { recursive: true });

const ASK = "把出处列一下。";

const url = (n: number) => `https://example.com/a/b?x=${n}`;

/** 每段：前半截、后半截。切点依次在 `(` 后、`(https:` 后、路径中间、`)` 前、`]` 前、`]` 后、裸网址中间。 */
const CASES: Array<[string, string]> = [
  [`一、[来源A](`, `${url(1)})`],
  [`二、[来源B](https:`, `${url(2).slice("https:".length)})`],
  [`三、[来源C](https://example.com/a/`, `b?x=3)`],
  [`四、[来源D](${url(4)}`, `)`],
  [`五、[来源E`, `](${url(5)})`],
  [`六、[来源F]`, `(${url(6)})`],
  [`七、见 https://exam`, `ple.com/x 完`],
];

const PIECES: NonNullable<TextStep["pieces"]> = [
  ...CASES.flatMap(([head, tail], i) => [{ text: `${i ? "\n\n" : ""}${head}`, delayMs: 700 }, { text: tail, delayMs: 700 }]),
  { text: "\n\n```j", delayMs: 700 },
  { text: "s\nconst a = 1;", delayMs: 700 },
  { text: "\nconst b = 2;", delayMs: 700 },
  { text: "\n```\n\n以上。", delayMs: 700 },
];

const EXPECTED = {
  paragraphs: ["一、来源A", "二、来源B", "三、来源C", "四、来源D", "五、来源E", "六、来源F", "七、见 https://example.com/x 完", "以上。"],
  links: [
    ...["A", "B", "C", "D", "E", "F"].map((name, i) => ({ text: `来源${name}`, href: url(i + 1) })),
    { text: "https://example.com/x", href: "https://example.com/x" },
  ],
};

/** 代码块每次变化时那一条的语言名和代码，只记已经有代码的时候。 */
const WATCH_CODE = `(() => { const seen = window.__code = new Set(); new MutationObserver(() => {
  const block = [...document.querySelectorAll(".msg.assistant")].at(-1)?.querySelector(".code-block"); const code = block?.querySelector("pre code")?.textContent ?? "";
  if (code.trim()) seen.add(JSON.stringify({ label: block.querySelector(".code-block-lang")?.getAttribute("data-label") ?? null, code }));
}).observe(document.body, { childList: true, subtree: true, characterData: true }); return true; })()`;

const model = await startScriptedModel([{ match: ASK, steps: [{ text: PIECES.map((p) => p.text).join(""), pieces: PIECES }] }]);

const rp = await launchRealPath();

let evidence: unknown = null;

let error: string | null = null;

/** 回答正文里看得到的段落和链接（不算回答下面的按钮区）。 */
const STATE = `(() => {
  const m = [...document.querySelectorAll(".msg.assistant")].at(-1);
  const body = (el) => !el.closest(".answer-actions, .answer-panel");
  return { paragraphs: [...m.querySelectorAll("p")].filter(body).map((p) => p.textContent),
    links: [...m.querySelectorAll("a")].filter(body).map((a) => ({ text: a.textContent, href: a.getAttribute("href") })) };
})()`;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);

  await rp.evaluate(panel, WATCH_CODE);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `(() => { const m = [...document.querySelectorAll(".msg.assistant")].at(-1); return !!m?.querySelector(".answer-primary") && !m.matches("[data-revealing]") && !m.querySelector("[data-revealing]"); })()`)) || undefined, 60_000, "回答显示完");
  const state = await rp.evaluate(panel, STATE);
  const code = (await rp.evaluate(panel, `[...window.__code].map((s) => JSON.parse(s))`)) as Array<{ label: string | null; code: string }>; // SAFETY: WATCH_CODE 只记这个形状。
  evidence = { ...(state as object), code };
  await rp.screenshot(panel, join(artifacts, "answer.png"));

  assert.deepEqual(state, EXPECTED, `切在链接中间的回答显示完后，链接完整、没有多出来的字：${JSON.stringify(state)}`);
  const wrong = code.filter((c) => c.label !== "JavaScript" || !"const a = 1;\nconst b = 2;\n".startsWith(c.code.replace(/\n$/, "")));
  assert.ok(code.length > 1 && !wrong.length, `代码块边写边显示时语言名完整、代码没有混进别的字：${JSON.stringify(code)}`);
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
