import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, sleep, until, REPO } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `composer-glide-${randomUUID()}`);
await mkdir(out, { recursive: true });
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: "整理成三条", steps: [{ text: "1. 第一条。\n2. 第二条。\n3. 第三条。" }] },
]);
const TRACE = `(()=>{window.__trace=[];const d=document.querySelector(".composer-dock-wrap");const t0=performance.now();const f=()=>{window.__trace.push([performance.now()-t0,d.getBoundingClientRect().bottom]);if(performance.now()-t0<1500)requestAnimationFrame(f)};requestAnimationFrame(f);return 1})()`;
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
try {
  rp = await launchRealPath();
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 1, mobile: false }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const idle = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  const runOnce = async (reduce: boolean) => {
    await rp!.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] }, panel);
    await until(() => rp!.evaluate(panel, idle), 60_000, "侧栏就绪");
    if (reduce) await rp!.evaluate(panel, 'document.querySelector("#conversation-new").click(),1');
    await until(() => rp!.evaluate(panel, idle), 30_000, "新会话就绪");
    await sleep(1500);
    const centered = await rp!.evaluate(panel, 'innerHeight - document.querySelector(".composer-dock-wrap").getBoundingClientRect().bottom') as number;
    await rp!.click(panel, "#input"); await rp!.typeText(panel, "把这页的要点整理成三条"); await sleep(500);
    await rp!.evaluate(panel, TRACE);
    await rp!.pressEnter(panel);
    await until(() => rp!.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(e=>e.textContent.includes("第三条"))`), 30_000, "回答");
    await sleep(1600);
    const trace = await rp!.evaluate(panel, "window.__trace") as Array<[number, number]>;
    const gapAtEnd = await rp!.evaluate(panel, 'innerHeight - document.querySelector(".composer-dock-wrap").getBoundingClientRect().bottom') as number;
    let maxStep = 0; let moveStart = -1; let moveEnd = -1;
    for (let i = 1; i < trace.length; i++) {
      const step = Math.abs(trace[i]![1] - trace[i - 1]![1]);
      maxStep = Math.max(maxStep, step);
      if (step > 0.5) { if (moveStart < 0) moveStart = trace[i - 1]![0]; moveEnd = trace[i]![0]; }
    }
    return { centered: Math.round(centered), gapAtEnd: Math.round(gapAtEnd), maxStep: Math.round(maxStep), moveMs: moveStart < 0 ? 0 : Math.round(moveEnd - moveStart), frames: trace.length };
  };
  const motion = await runOnce(false);
  await rp.screenshot(panel, join(out, "after-glide.png"));
  const reduced = await runOnce(true);
  const glidePass = motion.centered > 150 && motion.maxStep <= 60 && motion.moveMs >= 250 && motion.gapAtEnd < 40;
  const reducedPass = reduced.centered > 150 && reduced.gapAtEnd < 40 && reduced.moveMs < 100;
  result = { motion, reduced, glidePass, reducedPass, pass: glidePass && reducedPass };
  console.log(`${glidePass ? "PASS" : "FAIL"} 发出第一句：输入框滑到底边 ${JSON.stringify(motion)}`);
  console.log(`${reducedPass ? "PASS" : "FAIL"} 减少动态效果：直接到位 ${JSON.stringify(reduced)}`);
  if (!result.pass) process.exitCode = 1;
} catch (error) { result = { pass: false, error: String(error) }; console.error(error); process.exitCode = 1; }
finally {
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  if (rp) { await rp.close(); await rp.remove(); }
  await model.close();
  console.log(`证据：${out}`);
}
