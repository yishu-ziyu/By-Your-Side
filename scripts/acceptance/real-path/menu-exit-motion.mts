/**
 * 侧栏「+」附件菜单和检查器浮层：关闭时收回，不一下子消失；开了“减少动效”只淡入淡出，不位移不缩放。
 * 只装扩展的隔离无头 Chrome、真侧栏、真实鼠标点击；每帧读菜单的实际透明度、display 和 transform。不需要模型。
 *
 *   npx tsx scripts/acceptance/real-path/menu-exit-motion.mts --headless [--run=final] [--record]
 *
 * --record 另录一段放慢 10 倍的开关过程（out/acceptance/menu-exit-motion/<run>/close.mp4），只给人看，不参与判定。
 * 检查器浮层的入口 #page-pill 目前没有代码会显示它，用例先把它显示出来再点；这一段不代表用户现在能走到。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, recordScreen, requireHeadless, REPO, until, sleep, type Json } from "./harness.mts";

requireHeadless();

const run = process.argv.find(arg => arg.startsWith("--run="))?.slice(6) ?? "candidate";

if (!/^[a-z0-9-]+$/.test(run)) throw Error("invalid run");

const out = join(REPO, "out/acceptance/menu-exit-motion", run);

await mkdir(out, { recursive: true });

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

type Frame = { t: number; hidden: boolean; display: string; opacity: number; transform: string };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#attach-btn") && document.readyState==="complete"'), 30000, "panel");
  await sleep(800);
  await rp.evaluate(panel, 'document.querySelector("#page-pill").hidden = false');

  const isOpen = (selector: string) => rp.evaluate(panel, `!document.querySelector(${JSON.stringify(selector)}).hidden`) as Promise<boolean>;

  /** 每帧记一次菜单的样子，同时用真实鼠标点 trigger；记 ms 毫秒。 */
  const clickAndWatch = async (menu: string, trigger: string, ms = 500): Promise<Frame[]> => {
    const watch = rp.evaluate(panel, `new Promise(done => {
      const el = document.querySelector(${JSON.stringify(menu)}); const frames = []; const t0 = performance.now();
      const tick = () => { const cs = getComputedStyle(el);
        frames.push({ t: Math.round(performance.now() - t0), hidden: el.hidden, display: cs.display, opacity: +(+cs.opacity).toFixed(3), transform: cs.transform });
        if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else done(frames); };
      tick(); })`) as Promise<Frame[]>;
    await sleep(40);
    await rp.click(panel, trigger);

    return watch;
  };

  const summary = (frames: Frame[]) => ({ frames: frames.length, mid: frames.filter(f => f.display !== "none" && f.opacity > 0 && f.opacity < 1).length,
    moved: frames.filter(f => f.display !== "none" && f.transform !== "none").length, last: frames.at(-1) ?? null } as Json);

  /** 关闭途中：已标记关闭，但还看得见、半透明。 */
  const closing = (frames: Frame[]) => frames.some(f => f.hidden && f.display !== "none" && f.opacity > 0 && f.opacity < 1);
  const gone = (frames: Frame[]) => { const last = frames.at(-1); return !!last && last.hidden && last.display === "none"; };
  const fading = (frames: Frame[]) => frames.some(f => f.display !== "none" && f.opacity > 0 && f.opacity < 1);
  const still = (frames: Frame[]) => frames.every(f => f.display === "none" || f.transform === "none");

  const menus = [
    { name: "「+」附件菜单", menu: "#attach-menu", open: "#attach-btn", close: "#attach-btn" },
    { name: "检查器浮层", menu: "#morph-sheet", open: "#page-pill", close: "#close-morph-sheet" },
  ];

  for (const m of menus) {
    const opening = await clickAndWatch(m.menu, m.open);
    check(`${m.name}：点开后打开，入场有位移`, await isOpen(m.menu) && fading(opening) && !still(opening), summary(opening));
    await sleep(200);
    const closed = await clickAndWatch(m.menu, m.close);
    check(`${m.name}：关闭途中采到半透明的一帧，最后收起`, closing(closed) && gone(closed), summary(closed));
  }

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  await sleep(200);

  for (const m of menus) {
    const opening = await clickAndWatch(m.menu, m.open);
    check(`减少动效 · ${m.name}：仍淡入，没有位移和缩放`, await isOpen(m.menu) && fading(opening) && still(opening), summary(opening));
    await sleep(200);
    const closed = await clickAndWatch(m.menu, m.close);
    check(`减少动效 · ${m.name}：仍淡出，没有位移和缩放`, closing(closed) && still(closed) && gone(closed), summary(closed));
  }

  // 入场动画换成只淡入后，原来靠关键帧终点显示的元素不能停在透明。接管横幅由脚本直接显示，只看它的样子。
  await rp.evaluate(panel, 'document.querySelector("#handoff-banner").hidden = false');
  await sleep(600);
  const banner = Number(await rp.evaluate(panel, 'getComputedStyle(document.querySelector("#handoff-banner")).opacity'));
  check("减少动效 · 接管横幅出现后看得见", banner === 1, banner);
  await rp.evaluate(panel, 'document.querySelector("#handoff-banner").hidden = true');

  if (process.argv.includes("--record")) {
    // 放慢 10 倍，人眼才看得清 140ms 的收回；只用于录屏。
    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, panel);
    await rp.cdp.send("Animation.enable", {}, panel);
    await rp.cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 }, panel);
    const stop = await recordScreen(rp.cdp, panel, join(out, "close.mp4"));

    for (const m of menus) {
      await rp.click(panel, m.open); await sleep(3500);
      await rp.click(panel, m.close); await sleep(2500);
    }

    console.log("录屏", await stop());
  }
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, notCovered: ["真人观感", "检查器浮层的真实入口（#page-pill 目前不显示）"] }, null, 2));
  await rp.close(); await rp.remove();
}

if (checks.some(c => !c.pass)) process.exitCode = 1;
