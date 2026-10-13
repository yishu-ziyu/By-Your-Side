/**
 * 输入框里边说边出字（docs/evals/20261013-live-dictation.md）。
 * Chrome 自带识别会绕开假麦克风、直接听这台电脑的真麦克风（10-13 小实验），所以这里换成脚本识别：
 * 只证明侧栏这一层（声波、实时字、确认、取消、换阶跃）；真识别由人在日常 Chrome 里试。
 *   npx tsx scripts/acceptance/real-path/live-dictation.mts --headless
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-live-dictation`);

await mkdir(out, { recursive: true });

// 假麦克风放一段真人说话的录音（macOS 自带语音合成）：只为让声波有起伏，识别不读它。
// 稳定的单音会被麦克风的降噪当成噪声压掉，所以不用正弦波。
const wav = join(out, "speech.wav");
const aiff = join(out, "speech.aiff");
execFileSync("say", ["-v", "Tingting", "-o", aiff, "帮我把这页的报名表填好，姓名写张三，城市写上海，先别提交，填完让我看一眼。"]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", aiff, "-ar", "48000", "-ac", "1", wav]);

const model = await startScriptedModel([]);
const rp = await launchRealPath({ microphoneWav: wav });
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual));
};

/** 脚本识别：按时间先给猜测、再定下一段；第一轮说完后像 Chrome 一样自己停一次（onend），重开后再说一段。mode=network 时一开始就报连不上服务。 */
const fakeRecognition = (mode: "ok" | "network") => `(() => {
  const seg = (text, isFinal) => ({ isFinal, 0: { transcript: text } });
  const rounds = [
    [[300, [seg("帮我", false)]], [700, [seg("帮我把报名表", false)]], [1100, [seg("帮我把报名表填好，", true)]], [1600, [seg("帮我把报名表填好，", true), seg("姓名写", false)]], [2000, [seg("帮我把报名表填好，", true), seg("姓名写张三。", true)]]],
    [[300, [seg("城市写上海。", true)]]],
  ];
  class Fake {
    constructor() { this.lang = ""; this.continuous = false; this.interimResults = false; this.onresult = null; this.onerror = null; this.onend = null; this.timers = []; this.round = 0; }
    start() {
      window.__srStarted = (window.__srStarted ?? 0) + 1;
      if (${JSON.stringify(mode)} === "network") { this.timers.push(setTimeout(() => this.onerror?.({ error: "network" }), 200)); return; }
      const steps = rounds[this.round] ?? [];
      for (const [at, list] of steps) this.timers.push(setTimeout(() => this.onresult?.({ results: Object.assign([...list], { length: list.length }) }), at));
      if (this.round === 0) this.timers.push(setTimeout(() => { this.round = 1; this.onend?.(); }, 2200));
    }
    stop() { this.timers.forEach(clearTimeout); }
    abort() { this.timers.forEach(clearTimeout); }
  }
  window.SpeechRecognition = Fake; window.webkitSpeechRecognition = Fake;
  // 记下侧栏开过的每一路麦克风，退出后查它们是不是都关了。
  if (!window.__micWrapped) {
    window.__micWrapped = true; window.__streams = [];
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const m = await real(c); window.__streams.push(m); return m; };
  }
  return true;
})()`;
const micsLive = (panel: string) => rp.evaluate(panel, `(window.__streams ?? []).flatMap(m => m.getTracks()).filter(t => t.readyState === "live").length`) as Promise<number>;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled===false`), 60_000, "侧栏就绪");
  await rp.evaluate(panel, fakeRecognition("ok"));
  const state = () => rp.evaluate(panel, `({ dictating: document.querySelector("#composer").classList.contains("dictating"), live: document.querySelector("#dictation-text")?.innerText ?? "", input: document.querySelector("#input").value, row: !!document.querySelector("#dictation-row:not([hidden])") })`) as Promise<{ dictating: boolean; live: string; input: string; row: boolean }>;

  // (a) 点话筒：输入框换成实时文字，工具栏换成声波；字先猜后定。
  await rp.click(panel, "#dictate-btn");
  await sleep(800);
  const early = await state();
  await sleep(2300);
  const later = await state();
  // 只数离开基线 3 像素以上的墨：只有基线、没有柱子时是 0。
  const wave = await rp.evaluate(panel, `(() => { const c = document.querySelector(".dictation-wave"); const g = c.getContext("2d"); const d = g.getImageData(0, 0, c.width, c.height).data; const mid = c.height / 2, far = 3 * (devicePixelRatio || 1); let ink = 0; for (let y = 0; y < c.height; y++) { if (Math.abs(y - mid) <= far) continue; for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 0) ink++; } return { w: c.width, h: c.height, ink }; })()`) as { w: number; h: number; ink: number };
  await rp.screenshot(panel, join(out, "listening.png"));
  check("点话筒后进入说话输入：有声波一行，字边说边出", early.dictating && early.row && early.live.includes("帮我") && later.live.includes("张三") && later.live.includes("城市写上海"), { early, later });
  check("有声音时画出声波柱（不只是基线）", wave.ink > 40, wave);
  check("说的时候没有发给模型", model.requests.length === 0, model.requests.length);

  // (b) 回车：字留在输入框，不发出去。
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, panel);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, panel);
  await sleep(500);
  const kept = await state();
  await rp.screenshot(panel, join(out, "kept.png"));
  const liveAfterOk = await micsLive(panel);
  check("回车后字留在输入框（含 Chrome 自己重开前后两段）、退出说话输入、没有发出", kept.input === "帮我把报名表填好，姓名写张三。城市写上海。" && !kept.dictating && model.requests.length === 0, { ...kept, requests: model.requests.length });
  check("确认后麦克风全关了", liveAfterOk === 0, liveAfterOk);

  // (c) 已有字时再说，按 Esc：输入框回到说之前。
  await rp.evaluate(panel, `(() => { const i = document.querySelector("#input"); i.value = "前面写好的"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await rp.click(panel, "#dictate-btn");
  await sleep(2700);
  const mid = await state();
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, panel);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, panel);
  await sleep(400);
  const undone = await state();
  check("说的字接在原有的字后面；Chrome 自己重开过以后按 Esc，输入框仍回到说之前", mid.live.startsWith("前面写好的") && mid.live.includes("城市写上海") && undone.input === "前面写好的" && !undone.dictating, { mid, undone });
  check("Esc 后麦克风全关了", (await micsLive(panel)) === 0, await micsLive(panel));

  // (d) Chrome 识别连不上服务：换成阶跃听写，提示说完才出字。
  await rp.evaluate(panel, fakeRecognition("network"));
  await rp.click(panel, "#dictate-btn");
  const hint = await until(async () => {
    const t = await rp.evaluate(panel, `document.querySelector(".dictation-hint")?.textContent ?? ""`) as string;
    const s = await state();

    const notice = await rp.evaluate(panel, `[...document.querySelectorAll(".msg.notice")].at(-1)?.textContent ?? ""`) as string;

    return t || /没接上|没成功/.test(notice) ? { hint: t, dictating: s.dictating, notice } : undefined;
  }, 5_000, "换阶跃或说明原因");
  await rp.screenshot(panel, join(out, "fallback.png"));
  check("连不上 Chrome 识别：改用阶跃听写开始录（提示“改用阶跃”）", hint.dictating && /改用阶跃/.test(String(hint.hint)), hint);
  if (await rp.evaluate(panel, `document.querySelector("#composer").classList.contains("dictating")`)) await rp.click(panel, ".dictation-cancel");
} catch (error) {
  check("流程完成", false, String(error));
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(out);

if (!checks.length || checks.some((c) => !c.pass)) process.exitCode = 1;
