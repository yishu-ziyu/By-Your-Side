/**
 * 用户在真侧栏点「语音」，对着麦克风问页面上的内容，听到并看到答案。
 * 麦克风是 macOS say 合成的一段中文 WAV（Chrome 假设备只放一遍）；语音模型、断句都是真的。
 * 只装扩展、不装伴随进程：语音在扩展里连 StepFun，密钥来自 ~/.sideagent/stepfun-api.key；
 * 文字模型来自 ~/.sideagent/providers.local.json（--model=provider/id，默认 DEFAULT_TEST_MODEL）。
 * 判定只看结果：侧栏进入聆听、识别出的问题、回答里有页面原文。
 *
 *   npx tsx scripts/acceptance/real-path/voice-page-question.mts --headless
 *
 * 验收文件：docs/evals/20260923-repo-cleanup.md
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import type { JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const QUESTION = "这个页面上的备注写的是什么";

const NOTE = "周五前发货";

const TURN_LIMIT_MS = 2 * 60_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-voice-page-question`);

await mkdir(artifacts, { recursive: true });

// 前面垫静音：语音连上之前到的音频帧会被丢弃；后面垫静音让服务端断句。
const wav = join(artifacts, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", `[[slnc 6000]]${QUESTION}[[slnc 4000]]`]);

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单备注</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:520px;margin:40px auto;padding:0 20px}
textarea{width:100%;height:90px}</style></head>
<body><h1>订单备注</h1><label for="note">备注</label><textarea id="note">${NOTE}</textarea></body></html>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const pageUrl = `http://127.0.0.1:${siteAddress(site).port}/note`;

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const voiceKey = (await readFile(join(homedir(), ".sideagent/stepfun-api.key"), "utf8")).trim();

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    pill: q("#tab-title-text")?.textContent?.trim() ?? null,
    setupVisible: q("#setup") ? !q("#setup").hidden : false,
    voiceState: q(".voice-progress")?.dataset.state ?? null,
    voiceStatus: q(".voice-state")?.textContent?.trim() ?? "",
    heard: q(".voice-question")?.textContent?.trim() ?? "",
    answer: q(".voice-answer")?.textContent?.trim() ?? "",
  };
})()`;

type PanelState = { connected: boolean; pill: string | null; setupVisible: boolean; voiceState: string | null; voiceStatus: string; heard: string; answer: string };

type Verdict = { status: "yes" | "no" | "未确定"; evidence: JsonRecord };

let panelSession: string | undefined;

const verdict = (pass: boolean | null, evidence: JsonRecord): Verdict => ({ status: pass === null ? "未确定" : pass ? "yes" : "no", evidence });

const result: JsonRecord = { case: "voice-page-question", command: "npx tsx scripts/acceptance/real-path/voice-page-question.mts --headless", startedAt: startedAt.toISOString(), question: QUESTION, model: modelArg, path: "extension-only" };

const verdicts: Record<string, Verdict> = {};

result.verdicts = verdicts;

const rp = await launchRealPath({ microphoneWav: wav, withoutNativeHost: true });

const states: string[] = [];

let last: PanelState | null = null;

result.panel = { states };

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, page);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, page);
  await until(async () => ((await rp.evaluate(page, `!!document.querySelector("#note")`).catch(() => false)) ? true : undefined), 15_000, "练习页加载");

  const panel = await rp.attach(await rp.openSidePanel());
  panelSession = panel;
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // 相当于用户在设置里填好文字模型和语音密钥。
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ ...modelStorageItems(plan), inproc_voice_key: voiceKey })}).then(() => true)`);
  await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL_STATE);

    if (state.setupVisible) throw new Error("侧栏打开了调试通道设置页");

    return state.connected && state.pill?.includes("订单备注") ? state : undefined;
  }, 60_000, "侧栏连上扩展内 agent 并认出练习页", 500);
  // 侧栏启动时的新建会话要等配置后才建好；在它切换会话之前点语音，会和会话切换撞在一起。
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") !== "true"`)) || undefined, 20_000, "启动时的新会话建好", 300);

  await rp.click(panel, ".voice-start");
  let settled = 0;
  await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL_STATE);
    last = state;
    result.panel = { states, ...state };

    if (state.voiceState && states.at(-1) !== state.voiceState) states.push(state.voiceState);

    if (state.voiceState === "error") return true;
    settled = state.answer.includes(NOTE) || (state.answer && state.voiceState === "listening" && states.includes("speaking")) ? settled + 1 : 0;

    return settled >= 4 ? true : undefined;
  }, TURN_LIMIT_MS, "语音回答", 500);
  await rp.screenshot(panel, join(artifacts, "panel.png"));

  // SAFETY: last 只从 PANEL_STATE 读数赋值，形状是 PanelState。
  const final = last as PanelState | null;
  verdicts.voiceListening = verdict(states.includes("listening"), { states, status: final?.voiceStatus });
  verdicts.heardQuestion = verdict(!!final?.heard.includes("备注"), { heard: final?.heard });
  verdicts.answerFromPage = verdict(!!final?.answer.includes(NOTE), { answer: final?.answer });
  verdicts.noVoiceError = verdict(!states.includes("error"), { states });
  // 原先把伴随进程的 agent.log 存成 host.log；扩展内没有这份日志，改为像用户一样从设置页导出诊断记录留作证据（不作判据）。
  const { exportStatus, voice } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  result.diagnostics = { exportStatus, voiceLines: voice.split("\n").filter(Boolean).length, containsVoiceKey: voice.includes(voiceKey) };
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  if (panelSession) await rp.screenshot(panelSession, join(artifacts, "failure.png")).catch(() => {});
  result.failureDiagnostics = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"))
    .then(({ exportStatus, voice }) => ({ exportStatus, voiceLines: voice.split("\n").filter(Boolean).length, containsVoiceKey: voice.includes(voiceKey) }))
    .catch(caught => ({ error: String(caught) }));
} finally {
  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  const closed = await rp.close();
  // 原判据 hostExited 核对伴随进程随 Chrome 退出；只装扩展时换成「全程没有起任何本机伴随进程」。
  verdicts.noLocalHost = verdict((closed?.hostPids ?? []).length === 0, { hostPids: closed?.hostPids ?? [] });
  site.close();
}

result.finishedAt = new Date().toISOString();

result.ok = !result.error && Object.values(verdicts).every((v) => v.status === "yes");

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

console.log(`\n结果：${result.ok ? "通过" : "未通过"}  产物：${artifacts}`);

for (const [name, v] of Object.entries(verdicts)) console.log(`  ${v.status.padEnd(4)} ${name}  ${JSON.stringify(v.evidence)}`);

if (result.error) console.log(`  错误：${String(result.error).split("\n")[0]}`);

process.exit(result.ok ? 0 : 1);
