/**
 * 助手在干活时看得出在动（docs/evals/20261015-running-shimmer.md）：过程行的标签有一道扫光，秒数不扫；
 * 第一个字出来之前，回答位置有三行骨架；字一出来骨架淡掉、回答落在骨架原来的位置；收尾后、出错时都不留骨架；
 * 少动效设置下两样都不动。
 *   npx tsx scripts/acceptance/real-path/running-shimmer.mts --headless
 * 脚本模型先慢慢想、再调一步工具、再慢慢想，最后逐段写回答，一轮跑好几秒。只装扩展，判用户看得到的样子。
 * 失败方式：标签不动或秒数也在扫；想的时候回答位置空着；出字后骨架还在或回答往下跳；收尾、出错后还留着骨架；少动效下还在动。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-running-shimmer`);

await mkdir(artifacts, { recursive: true });

const ANSWER = "页面写的是 299 元，主打降噪和 30 小时续航。同价位里续航突出，降噪没有实测数据，建议先看评测再决定。";

const slowTurn = (match: string) => ({
  match,
  steps: [
    { tool: { name: "tabs", args: { action: "active" } }, delayMs: 2500 },
    { text: ANSWER, delayMs: 1500, chunkDelayMs: 120 },
  ],
});

const model = await startScriptedModel([
  slowTurn("耳机甲"),
  { match: "出错乙", steps: [{ status: 400, body: JSON.stringify({ error: { message: "scripted bad request" } }) }] },
  slowTurn("耳机丙"),
  slowTurn("耳机丁"),
]);

const rp = await launchRealPath();

const evidence: Record<string, unknown> = {};

let error: string | null = null;

let stopVideo: (() => Promise<string | null>) | null = null;

/**
 * 页面里每 50ms 记一次最后一轮用户看到的样子：过程行还在跑没有、标签和秒数上正在跑的动画、骨架看不看得见、
 * 骨架和回答的排版位置（offsetTop：回答入场时有上浮位移，量排版不量画面）、回答有没有字、有没有出错卡。
 */
const SAMPLER = `(() => {
  window.__samples = [];
  const t0 = performance.now();
  const running = (el) => el ? el.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName ?? a.transitionProperty ?? "?") : [];
  window.__sampler = setInterval(() => {
    const kids = [...document.querySelectorAll("#messages > *")];
    const from = kids.findLastIndex((e) => e.matches(".msg.user"));
    const turn = kids.slice(from + 1);
    const run = turn.find((e) => e.matches("details.run-steps"));
    const sk = turn.find((e) => e.matches(".answer-skeleton"));
    const ans = turn.find((e) => e.matches(".msg.assistant") && e.innerText.trim().length > 0);
    const skStyle = sk ? getComputedStyle(sk) : null;
    const bars = sk ? [...sk.children] : [];
    window.__samples.push({
      t: Math.round(performance.now() - t0),
      live: !!run && !run.classList.contains("done") && !run.hidden,
      label: run?.querySelector(".run-title")?.textContent ?? null,
      labelAnim: running(run?.querySelector(".run-title")),
      timeText: run?.querySelector(".run-time")?.textContent ?? null,
      timeAnim: running(run?.querySelector(".run-time")),
      timeInLabel: !!run?.querySelector(".run-title .run-time"),
      skInDom: !!sk,
      skVisible: !!sk && skStyle.display !== "none" && Number(skStyle.opacity) > 0.05 && bars.some((b) => b.getBoundingClientRect().height > 0),
      skTop: sk ? sk.offsetTop : null,
      skAnim: bars.flatMap(running).concat(running(sk)),
      answerTop: ans ? ans.offsetTop : null,
      answerChars: ans ? ans.innerText.trim().length : 0,
      errorCard: turn.some((e) => e.matches(".error-card") || !!e.querySelector?.(".error-card")),
    });
  }, 50);
  return true;
})()`;

type Sample = {
  t: number; live: boolean; label: string | null; labelAnim: string[]; timeText: string | null; timeAnim: string[]; timeInLabel: boolean;
  skInDom: boolean; skVisible: boolean; skTop: number | null; skAnim: string[]; answerTop: number | null; answerChars: number; errorCard: boolean;
};

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  stopVideo = await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")).catch(() => null);

  /** 发一句话，边跑边采样，到这一轮收尾（过程行收起、骨架拿掉）后再多采 1 秒。中途按 shots 的时刻截图。 */
  const turn = async (text: string, shots: Array<{ when: (s: Sample) => boolean; file: string }> = []) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.evaluate(panel, SAMPLER);
    await rp.pressEnter(panel);
    const pending = [...shots];
    let sawLive = false;

    await until(async () => {
      const samples = await rp.evaluate(panel, `window.__samples`) as Sample[]; // SAFETY: SAMPLER 推进去的就是 Sample。
      const last = samples.at(-1);

      if (!last) return undefined;

      for (const shot of [...pending]) {
        if (!shot.when(last)) continue;
        pending.splice(pending.indexOf(shot), 1);
        await rp.screenshot(panel, join(artifacts, shot.file));
      }

      sawLive ||= last.live;

      return (sawLive || last.errorCard) && !last.live && !last.skInDom && (last.answerChars > 0 || last.errorCard) ? true : undefined;
    }, 60_000, `${text.slice(0, 4)} 收尾`, 100).catch(async (caught) => {
      evidence.stuck = { text, samples: (await rp.evaluate(panel, `window.__samples`) as Sample[]).slice(-5) }; // SAFETY: 同上。
      throw caught;
    });
    await sleep(1000);
    const samples = await rp.evaluate(panel, `(clearInterval(window.__sampler), window.__samples)`) as Sample[]; // SAFETY: 同上。

    return samples;
  };

  // 一、普通一轮：想 → 一步工具 → 想 → 逐段写回答。
  const normal = await turn("耳机甲：这款耳机值不值得买", [
    { when: (s) => s.live && s.skVisible && s.label === "正在思考" && s.t > 1200, file: "after-thinking.png" },
    { when: (s) => s.answerChars > 0, file: "after-first-text.png" },
  ]);
  await rp.screenshot(panel, join(artifacts, "after-done.png"));
  // 二、模型直接报错：出错卡出来时骨架已经没了，收尾后也没有。
  const errored = await turn("出错乙：再说一遍");
  // 三、出错之后的下一轮（深色模式，顺便截图）：任务卡挂在末尾时骨架照样出来。
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, panel);
  const dark = await turn("耳机丙：这款耳机值不值得买", [{ when: (s) => s.live && s.skVisible && s.t > 1200, file: "after-thinking-dark.png" }]);
  // 四、少动效设置。
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  const reduced = await turn("耳机丁：这款耳机值不值得买", [{ when: (s) => s.live && s.skVisible && s.t > 1200, file: "reduced-motion.png" }]);

  const firstText = normal.findIndex((s) => s.answerChars > 0);
  const before = normal.slice(0, firstText).filter((s) => s.live);
  const shimmering = before.filter((s) => s.labelAnim.includes("runShimmer"));
  const skeleton = before.filter((s) => s.skVisible && s.skAnim.includes("skeletonSweep"));
  const t0Text = normal[firstText]?.t ?? Infinity;
  const settled = normal.filter((s) => s.t >= t0Text + 400);
  const atText = normal[firstText];
  const end = normal.at(-1);
  Object.assign(evidence, {
    normal: { samples: normal.length, firstTextAt: t0Text, beforeLive: before.length, shimmering: shimmering.length, skeleton: skeleton.length, atText, end,
      labels: [...new Set(before.map((s) => s.label))], tool: before.find((s) => s.label && s.label !== "正在思考") ?? null, timeShimmer: before.filter((s) => s.timeAnim.includes("runShimmer") || s.timeInLabel).length },
    errored: { samples: errored.length, skAfterError: errored.filter((s) => s.errorCard && s.skVisible).length, end: errored.at(-1) },
    reduced: { samples: reduced.length, live: reduced.filter((s) => s.live && s.answerChars === 0).slice(0, 3), anyAnim: reduced.filter((s) => s.labelAnim.length || s.skAnim.length).slice(0, 3) },
  });

  assert.ok(firstText > 0 && before.length >= 20, `一轮跑了好几秒才出第一个字：${JSON.stringify({ firstText, live: before.length })}`);
  assert.ok(shimmering.length >= before.length * 0.9, `R1 出字前过程行标签一直在扫光：${shimmering.length}/${before.length}`);
  assert.equal(before.filter((s) => s.timeAnim.includes("runShimmer") || s.timeInLabel).length, 0, "R1 秒数不扫光");
  assert.ok(skeleton.length >= before.length * 0.9, `R2 出字前回答位置有三行在扫的骨架：${skeleton.length}/${before.length}`);
  assert.ok(settled.length > 0 && settled.every((s) => !s.skVisible), `R2 出字 400ms 后骨架看不见：${JSON.stringify(settled.find((s) => s.skVisible))}`);
  assert.ok(atText && atText.answerTop !== null && atText.skTop !== null && Math.abs(atText.answerTop - atText.skTop) <= 1, `R2 回答落在骨架的位置：${JSON.stringify(atText)}`);
  assert.ok(end && atText && end.answerTop === atText.answerTop, `R2 骨架拿掉时回答不跳：${JSON.stringify({ atText: atText?.answerTop, end: end?.answerTop })}`);
  assert.ok(end && !end.live && !end.skInDom, `R3 收尾后不留骨架：${JSON.stringify(end)}`);
  assert.ok(errored.some((s) => s.errorCard), "R3 出错那一轮出了出错卡");
  assert.ok(errored.filter((s) => s.errorCard && s.skVisible).length === 0 && !errored.at(-1)?.skInDom, `R3 出错时、出错后都没有骨架：${JSON.stringify(errored.find((s) => s.errorCard && s.skVisible) ?? errored.at(-1))}`);
  const darkBefore = dark.filter((s) => s.live && s.answerChars === 0);
  Object.assign(evidence, { dark: { live: darkBefore.length, skeleton: darkBefore.filter((s) => s.skVisible).length } });
  assert.ok(darkBefore.length > 0 && darkBefore.filter((s) => s.skVisible).length >= darkBefore.length * 0.9, `R2 出错之后的下一轮照样有骨架：${JSON.stringify(evidence.dark)}`);
  const reducedLive = reduced.filter((s) => s.live && s.answerChars === 0);
  assert.ok(reducedLive.some((s) => s.skVisible), "R4 少动效下骨架照样占着回答位置");
  assert.ok(reducedLive.every((s) => s.labelAnim.length === 0 && s.skAnim.length === 0), `R4 少动效下标签和骨架都不动：${JSON.stringify(reducedLive.find((s) => s.labelAnim.length || s.skAnim.length))}`);
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
