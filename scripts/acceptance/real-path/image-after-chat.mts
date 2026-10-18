/**
 * 先聊一句、再只发一张图（真实模型，只装扩展，无头）。默认用 Command Code 的 Claude Haiku 5.5：
 * 只发图那一轮的系统提示和上一轮不同，上一轮的思考块原样回传就被拒（400「Invalid `signature` in `thinking` block」）。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/image-after-chat.mts --headless [--model=provider/id]
 * 失败方式：第二条只出现「模型这次没有给出回答」的错误卡，或者没有新的回答。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type JsonRecord } from "./harness.mts";
import { configureViaSettings, loadModelPlan } from "./inproc-config.mts";

requireHeadless();

const started = Date.now();
const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? "commandcode/claude-haiku-5-5";
const plan = await loadModelPlan(modelArg);
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-image-after-chat`);
await mkdir(artifacts, { recursive: true });

const rp = await launchRealPath();
let error: string | null = null;
let panel = "";
const evidence: JsonRecord = { model: modelArg };

type PanelState = { ready: boolean; busy: boolean; users: number; answers: string[]; errors: string[] };

// SAFETY: 页面脚本返回的对象与 PanelState 逐字段对应。
const state = () => rp.evaluate(panel, `({
  ready: document.querySelector("#send-btn")?.disabled === false,
  busy: !!(document.querySelector("#send-btn")?.classList.contains("stopping") || document.querySelector("#status-pill")?.classList.contains("running") || document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")),
  users: document.querySelectorAll("#messages .msg.user").length,
  answers: [...document.querySelectorAll("#messages .msg.assistant")].map((e) => e.innerText),
  errors: [...document.querySelectorAll("#messages .msg.error-card")].map((e) => e.innerText),
})`) as Promise<PanelState>;

/** 点发送键发出当前输入框内容（空输入框只带附件时回车不发送），等助手停下来；返回新增的回答和错误卡。 */
const send = async (label: string) => {
  const before = await state();
  await rp.click(panel, "#send-btn");
  await until(async () => (await state()).users > before.users || undefined, 30_000, `${label}进入对话`);
  const after = await until(async () => {
    const now = await state();

    return !now.busy && (now.answers.length > before.answers.length || now.errors.length > before.errors.length) ? now : undefined;
  }, 120_000, `真实模型回应${label}`, 500);
  await sleep(500);

  return { answers: after.answers.slice(before.answers.length), errors: after.errors.slice(before.errors.length) };
};

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await state()).ready || undefined, 60_000, "侧栏就绪");
  evidence.configure = (await configureViaSettings(rp, panel, plan)).saveStatus;
  // 日常出错时思考档位是「高」：这一档下连「你好」也会带回思考块，第二轮才有旧思考块可回传。
  await rp.evaluate(panel, `localStorage.setItem("sideagent.thinkingLevels", JSON.stringify({ ${JSON.stringify(modelArg)}: "high" })); location.reload(); true`);
  await sleep(2000);
  await until(async () => (await state()).ready || undefined, 60_000, "侧栏重载后就绪");
  evidence.effortLabel = await rp.evaluate(panel, `document.querySelector("#composer")?.innerText.match(/[低中高]/)?.[0] ?? null`);
  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "默认会话建好");

  await rp.click(panel, "#input");
  await rp.typeText(panel, "你好");
  const first = await send("「你好」");
  evidence.first = first;
  if (!first.answers.length || first.errors.length) throw new Error(`第一条没有正常回答：${JSON.stringify(first)}`);

  // 和用户在输入框里粘贴截图走同一个 paste 事件。
  await rp.click(panel, "#input");
  await rp.evaluate(panel, `(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 160, height: 90 });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2f6fdf"; ctx.fillRect(0, 0, 160, 90);
    ctx.fillStyle = "#fff"; ctx.font = "bold 40px sans-serif"; ctx.fillText("42", 52, 60);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "shot.png", { type: "image/png" }));
    document.querySelector("#input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(1000);
  const second = await send("只发的图片");
  evidence.second = second;
  await rp.screenshot(panel, join(artifacts, "after-image.png"));
  if (second.errors.length) throw new Error(`只发图片后出现错误卡：${second.errors.join(" | ").slice(0, 200)}`);
  if (!second.answers.some((a) => a.trim().length > 0)) throw new Error("只发图片后没有回答");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => undefined);
} finally {
  const wallSeconds = Math.round((Date.now() - started) / 1000);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", wallSeconds, evidence, error }, null, 2));
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", wallSeconds, artifacts, error: error?.split("\n")[0] ?? null }));
}

if (error) process.exitCode = 1;
