/**
 * 语音光球可选（docs/evals/20261007-voice-orb-styles.md R1、R2、R4）：只装扩展、隔离构建，不需要模型。
 *   npx tsx scripts/acceptance/real-path/orb-style.mts --headless
 * R1 新装默认暮色：欢迎页光球是暮色视频，并在播放；画面以产品蓝为主（蓝 > 红）。
 * R2 设置页点「晨光」后，已打开的侧栏光球立即换成晨光（红 > 蓝）；点「粒子」换回粒子球。
 * R4 减少动态：重开侧栏后视频光球不播放。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-orb-style`);

await mkdir(artifacts, { recursive: true });

/** 欢迎页光球当前的样子、是否在播、画面的平均颜色（只算不透明像素）。 */
const READ_ORB = `(() => { const c = document.querySelector("#starter-orb"); if (!c || !c.width) return { style: null, playing: null, r: 0, g: 0, b: 0, opaque: 0 }; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return { style: c.dataset.orbStyle ?? null, playing: c.dataset.orbPlaying ?? null, r: Math.round(r / Math.max(n, 1)), g: Math.round(g / Math.max(n, 1)), b: Math.round(b / Math.max(n, 1)), opaque: n }; })()`;

/** READ_ORB 的结果。 */
interface OrbRead { style: string | null; playing: string | null; r: number; g: number; b: number; opaque: number }

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, OrbRead> = {};

try {
  let panel = await rp.attach(await rp.openSidePanel());
  // 欢迎页要配好模型才出现；这里只写一个本机地址，不会发出模型请求。
  const items = { inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: "http://127.0.0.1:9/v1" }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  // SAFETY: READ_ORB 返回的对象字段与 OrbRead 一一对应。
  const read = async () => (await rp.evaluate(panel, READ_ORB)) as OrbRead;

  evidence.defaultDusk = await until(async () => {
    const o = await read();

    return o.style === "dusk" && o.playing === "true" && o.opaque > 100 ? o : undefined;
  }, 20_000, "R1: dusk orb playing");
  await rp.screenshot(panel, join(artifacts, "1-default-dusk.png"));
  assert.ok(evidence.defaultDusk.b > evidence.defaultDusk.r, `R1: dusk is mostly product blue ${JSON.stringify(evidence.defaultDusk)}`);

  await rp.evaluate(panel, `chrome.runtime.openOptionsPage().then(() => true)`);
  const settings = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith("/settings.html")), 10_000, "settings")).targetId);
  await until(async () => await rp.evaluate(settings, 'document.querySelectorAll(".orb-option").length === 3') || undefined, 10_000, "orb options");
  assert.equal(await rp.evaluate(settings, 'document.querySelector(".orb-option[aria-checked=true]")?.dataset.orbStyle'), "dusk", "R1: settings shows dusk selected");

  // 选项列表点一次就重画，点之前把要点的那一项滚进视野。
  const pick = async (style: string) => {
    await rp.evaluate(settings, `document.querySelector('.orb-option[data-orb-style="${style}"]').scrollIntoView({ block: "center" })`);
    await rp.click(settings, `.orb-option[data-orb-style="${style}"]`);
  };

  await pick("dawn");
  await sleep(600);
  await rp.screenshot(settings, join(artifacts, "2-settings.png"));
  evidence.dawn = await until(async () => {
    const o = await read();

    return o.style === "dawn" && o.playing === "true" && o.opaque > 100 ? o : undefined;
  }, 10_000, "R2: panel switched to dawn");
  assert.ok(evidence.dawn.r > evidence.dawn.b + 20, `R2: dawn is warm ${JSON.stringify(evidence.dawn)}`);
  await sleep(500);
  await rp.screenshot(panel, join(artifacts, "3-dawn.png"));

  await pick("particles");
  evidence.particles = await until(async () => {
    const o = await read();

    return o.style === "particles" ? o : undefined;
  }, 10_000, "R2: panel switched to particles");
  await pick("dusk");
  await until(async () => (await read()).style === "dusk" || undefined, 10_000, "back to dusk");

  // R4：减少动态。重开侧栏页面后视频光球只画第一帧。
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  await rp.evaluate(panel, "location.reload(), true").catch(() => true);
  await sleep(1_500);
  panel = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.includes("/sidepanel.html")), 10_000, "panel again")).targetId);
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  await rp.evaluate(panel, "location.reload(), true").catch(() => true);
  evidence.reduced = await until(async () => {
    const o = await read().catch(() => null);

    return o && o.style === "dusk" && o.opaque > 100 ? o : undefined;
  }, 15_000, "R4: dusk orb drawn");
  await sleep(800);
  evidence.reducedLater = await read();
  assert.equal(evidence.reducedLater.playing, "false", "R4: video orb is not playing under reduced motion");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
