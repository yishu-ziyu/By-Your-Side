/**
 * 附上的文件交给真模型（MiniMax M3.1，收图）：看它能不能照文件内容答对。只装扩展、隔离构建、真模型。
 *   npx tsx scripts/acceptance/real-path/file-attachments-real.mts --headless
 * 一次附上扫描件 PDF、Excel、PPT、长文本，问四个只有读了文件才答得出的问题：
 *   扫描件上的收据编号（只在图里）、Excel 里的金额、PPT 第 3 页备注里的日期、长文本第 2401 行的暗号（不在消息里，要用 read_attachment 去找）。
 * 密钥在 ~/.pi/agent/auth.json（minimax-cn），只在运行时读，不打印、不落盘。
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until, type Json } from "./harness.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-file-attachments-real`);
const files = join(REPO, "scripts/acceptance/fixtures/files");

await mkdir(out, { recursive: true });

const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined);
const keyValue = field(field(JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8")), "minimax-cn"), "key");

if (typeof keyValue !== "string" || !keyValue) throw new Error("~/.pi/agent/auth.json 里没有 minimax-cn 的密钥");
const MODEL = { provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview" };

const ASK = "只根据我附上的文件回答，每题一行：1）扫描的收据上，收据编号和金额是多少？2）销售表里华东那一天的金额是多少？3）PPT 第 3 页的演讲者备注提醒合同哪天到期？4）long-notes.txt 里的暗号是什么？";

/** 每题答案里必须出现的字（任一写法）。 */
const EXPECT: Array<{ item: string; any: string[] }> = [
  { item: "1 扫描件（只在图里）的收据编号", any: ["A-1024"] },
  { item: "1 扫描件的金额", any: ["860"] },
  { item: "2 Excel 华东的金额", any: ["4520.5", "4,520.5", "4520.50"] },
  { item: "3 PPT 备注里的日期", any: ["4 月 30 日", "4月30日", "4/30", "04-30"] },
  { item: "4 长文本的暗号（要用 read_attachment 找）", any: ["紫色长颈鹿"] },
];

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
let answer = "";

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: MODEL, inproc_fast_model_config: MODEL })}).then(() => true)`);
  await rp.evaluate(panel, `chrome.storage.local.set({["inproc_cred:" + ${JSON.stringify(MODEL.provider)}]: {type: "api_key", key: ${JSON.stringify(keyValue)}}}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");

  await rp.cdp.send("DOM.enable", {}, panel);
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: 0 }, panel) as { root: { nodeId: number } };
  const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#file-input" }, panel) as { nodeId: number };
  await rp.cdp.send("DOM.setFileInputFiles", { nodeId, files: ["receipt-scan.pdf", "sales.xlsx", "review.pptx", "long-notes.txt"].map(name => join(files, name)) }, panel);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#attachments-strip .tile-file.complete")].length === 4`) || undefined, 60_000, "4 个文件读完");

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 30_000, "开始回答");
  await until(async () => await rp.evaluate(panel, ready), 240_000, "回答完成", 1_000);
  answer = await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant:not(.opening-line)")].at(-1)?.innerText ?? ""`) as string;
  await rp.screenshot(panel, join(out, "answer.png"));

  for (const expect of EXPECT) check(expect.item, expect.any.some(text => answer.includes(text)), expect.any);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", model: MODEL, answer, checks }, null, 2));
  await rp.close(); await rp.remove();
}

console.log(`回答：${answer}`);
console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
