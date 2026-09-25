/**
 * 小伙伴 M 显示开关：真侧栏里用鼠标点「更多 → 显示小伙伴 M」，看 M 是否真的消失、面板重开后是否保持、再点是否回来。
 *
 *   npx tsx scripts/acceptance/real-path/companion-toggle.mts --headless
 *
 * 只装扩展，不需要模型。可见与否由测试自己读页面上 M 元素的实际渲染尺寸判断，不读产品的开关状态。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";

requireHeadless();

const startedAt = new Date().toISOString();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.replace(/[:.]/g, "-")}-companion-toggle`);

await mkdir(artifacts, { recursive: true });

/** M 在页面上实际占了多大：0 表示用户看不见。 */
const COMPANION_AREA = `(() => { const el = document.getElementById("pix-companion"); if (!el) return -1; const r = el.getBoundingClientRect(); return Math.round(r.width * r.height); })()`;

const rp = await launchRealPath({ withoutNativeHost: true });

const steps: Array<{ step: string; area: number; expectVisible: boolean; pass: boolean; screenshot: string }> = [];

try {
  const panelTarget = await rp.openSidePanel();
  let panel = await rp.attach(panelTarget);

  const record = async (step: string, expectVisible: boolean) => {
    const area = Number(await rp.evaluate(panel, COMPANION_AREA));
    const screenshot = `${steps.length + 1}-${step}.png`;
    await rp.screenshot(panel, join(artifacts, screenshot));
    steps.push({ step, area, expectVisible, pass: expectVisible ? area > 0 : area === 0, screenshot });
  };

  const toggle = async () => {
    await rp.click(panel, "#header-more");
    await sleep(300);
    await rp.click(panel, "#companion-toggle");
    await sleep(300);
  };

  await until(async () => Number(await rp.evaluate(panel, COMPANION_AREA)) >= 0, 10_000, "侧栏里出现小伙伴 M");
  await sleep(500);
  await record("default", true);

  await toggle();
  await record("after-off", false);

  // 关掉再打开侧栏：用户下次打开时应仍是关的。
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(1500);
  panel = await rp.attach(panelTarget);
  await until(async () => Number(await rp.evaluate(panel, COMPANION_AREA)) >= 0, 10_000, "重开后侧栏加载完成");
  await sleep(500);
  await record("after-reload", false);

  await toggle();
  await record("after-on", true);
} finally {
  await rp.close();
}

const pass = steps.length === 4 && steps.every((s) => s.pass);

await writeFile(join(artifacts, "result.json"), JSON.stringify({ startedAt, pass, steps }, null, 2));

for (const s of steps) console.log(`${s.step}\t${s.pass ? "pass" : "FAIL"}\tarea=${s.area}\texpectVisible=${s.expectVisible}`);

console.log(`${pass ? "PASS" : "FAIL"} · ${artifacts}`);

process.exitCode = pass ? 0 : 1;
