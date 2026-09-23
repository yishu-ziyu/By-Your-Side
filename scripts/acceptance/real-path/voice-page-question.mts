/**
 * 用户在真侧栏点「语音」，对着麦克风问页面上的内容，听到并看到答案。
 * 麦克风是 macOS say 合成的一段中文 WAV（Chrome 假设备只放一遍）；语音模型、断句、伴随进程都是真的。
 * 判定只看结果：侧栏进入聆听、识别出的问题、回答里有页面原文。
 *
 *   npx tsx scripts/acceptance/real-path/voice-page-question.mts --headless
 *
 * 验收文件：docs/evals/20260923-repo-cleanup.md
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import type { JsonRecord } from "./harness.mts";

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

const verdict = (pass: boolean | null, evidence: JsonRecord): Verdict => ({ status: pass === null ? "未确定" : pass ? "yes" : "no", evidence });

const result: JsonRecord = { case: "voice-page-question", command: "npx tsx scripts/acceptance/real-path/voice-page-question.mts --headless", startedAt: startedAt.toISOString(), question: QUESTION };

const verdicts: Record<string, Verdict> = {};

result.verdicts = verdicts;

const rp = await launchRealPath({ microphoneWav: wav });

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
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => {
    const state: PanelState = await rp.evaluate(panel, PANEL_STATE);

    if (state.setupVisible) throw new Error("侧栏打开了调试通道设置页");

    return state.connected && state.pill?.includes("订单备注") ? state : undefined;
  }, 90_000, "侧栏连上伴随进程并认出练习页", 500);

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
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  const closed = await rp.close();
  verdicts.hostExited = verdict(closed?.exitedWithChrome ?? false, closed ?? {});
  await writeFile(join(artifacts, "host.log"), await rp.hostLog()).catch(() => {});
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
