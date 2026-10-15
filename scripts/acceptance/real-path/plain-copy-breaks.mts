/**
 * 回答的「复制」（纯文本）贴出来和屏幕上读起来一样：段落之间断开，列表每项一行，表格每行一行，代码块的行照原样，没有代码块条上的字。
 *   npx tsx scripts/acceptance/real-path/plain-copy-breaks.mts --headless
 * 脚本模型答一段带两段话、三项列表、小表格、行内代码、代码块和链接的回答，只装扩展。回答里有表格，主按钮是「复制为表格」，
 * 所以从「…」菜单点「复制」。剪贴板只记下产品交给 navigator.clipboard 的字，不读系统剪贴板。
 * 失败方式：段落连成一行（「…62.4%。报表截图…」）；列表项或表格行挤在一行；代码块的行被并起来；带进「JavaScript」「不换行」「复制」。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-plain-copy-breaks`);

await mkdir(artifacts, { recursive: true });

const ASK = "把这份季度报表的要点整理一下。";

const PARA_1 = "本季度毛利率是 62.4%。";

const PARA_2 = "报表截图在附件里，用 `sumRevenue()` 算的总收入见 [原报表](https://example.com/report)。";

const ITEMS = ["收入增长 12%", "成本下降 3%", "现金流转正"];

const ROWS = [["月份", "收入"], ["七月", "120"], ["八月", "135"]];

const CODE = ["const total = rows.reduce((sum, r) => sum + r.revenue, 0);", "console.log(total);"];

const ANSWER = [
  PARA_1,
  PARA_2,
  ITEMS.map((item) => `- ${item}`).join("\n"),
  [`| ${ROWS[0].join(" | ")} |`, "| --- | --- |", ...ROWS.slice(1).map((row) => `| ${row.join(" | ")} |`)].join("\n"),
  ["```js", ...CODE, "```"].join("\n"),
].join("\n\n");

const model = await startScriptedModel([{ match: ASK, steps: [{ text: ANSWER }] }]);

const rp = await launchRealPath();

const evidence: Record<string, unknown> = {};

let error: string | null = null;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await rp.evaluate(panel, `(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; return true; })()`);

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector(".msg.assistant .answer-primary")`)) || undefined, 60_000, "回答写完");
  await sleep(800);
  await rp.screenshot(panel, join(artifacts, "answer.png"));

  // 回答出来后第一次 focusin 才给主按钮补上「↵」，按钮变宽把「…」推开，按下和松手不在同一个按钮上。
  // 这里先点回答正文、再点输入框，让「↵」先出来；这个挪位是另一个问题，不在这条用例里判。
  await rp.click(panel, ".msg.assistant p");
  await rp.click(panel, "#input");
  await sleep(300);
  await rp.click(panel, ".msg.assistant .answer-command-btn");
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector(".answer-command-item")`)) || undefined, 3_000, "动作菜单");
  const index = await rp.evaluate(panel, `[...document.querySelectorAll(".answer-command-item")].findIndex((r) => r.querySelector(".answer-command-name")?.textContent === "复制")`);
  assert.ok(typeof index === "number" && index >= 0, "菜单里有「复制」");
  await rp.click(panel, `.answer-command-item:nth-child(${index + 1})`);
  await until(async () => (await rp.evaluate(panel, `window.__copied.length > 0`)) || undefined, 3_000, "复制拿到字");
  const text = String(await rp.evaluate(panel, `window.__copied.at(-1)`));
  evidence.copied = text;
  const lines = text.split("\n").map((line) => line.trim());
  evidence.lines = lines;

  const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle));
  assert.ok(lineOf("62.4%") >= 0 && lineOf("报表截图") > lineOf("62.4%"), `两段话分在不同行：${JSON.stringify(text)}`);
  assert.ok(lineOf("sumRevenue()") === lineOf("报表截图") && lineOf("原报表") === lineOf("报表截图"), `行内代码和链接留在所在那段：${JSON.stringify(text)}`);
  for (const item of ITEMS) assert.ok(lines.includes(item), `列表项「${item}」单独一行：${JSON.stringify(text)}`);
  for (const row of ROWS) assert.ok(lines.some((line) => line.split(/\t|\s{2,}/).map((cell) => cell.trim()).join("|") === row.join("|")), `表格行「${row.join(" ")}」单独一行：${JSON.stringify(text)}`);
  assert.ok(text.includes(CODE.join("\n")), `代码块的两行照原样：${JSON.stringify(text)}`);
  assert.ok(!/JavaScript|不换行|已复制|复制/.test(text), `没有代码块条上的字：${JSON.stringify(text)}`);
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
