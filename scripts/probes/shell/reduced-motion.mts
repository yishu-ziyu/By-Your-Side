/**
 * 减少动效探针（docs/evals/20261006-sidepanel-picks.md R5）：真侧栏里读计算样式，
 * 比较「正常」与「减少动效」下记忆灰字淡入、记忆小条、过程展开的动效时长。
 *
 *   npx tsx scripts/probes/shell/reduced-motion.mts --headless
 */
import { launchRealPath, requireHeadless, until } from "../../acceptance/real-path/harness.mts";

requireHeadless();

const READ = `(() => {
  const m = document.createElement("div"); m.className = "msg assistant markdown";
  m.innerHTML = '<p>甲<button class="memory-used-toggle"></button></p><div class="memory-used-line" data-open="true"></div><details class="run-steps" open><summary>x</summary><div class="run-reveal"></div></details>';
  document.querySelector("#messages").append(m);
  const s = (el, pseudo) => getComputedStyle(el, pseudo);
  const r = { cite: s(m.querySelector(".memory-used-toggle")).animationName, memory: s(m.querySelector(".memory-used-line")).transitionDuration, run: s(m.querySelector("details"), "::details-content").transitionDuration };
  m.remove(); return r;
})()`;

const rp = await launchRealPath();

let failed = false;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, "!!document.querySelector('#messages')") || undefined, 30_000, "侧栏就绪");
  const normal = await rp.evaluate(panel, READ);
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  const reduced = await rp.evaluate(panel, READ);
  const moving = normal.cite === "citePop" && normal.memory !== "0s" && normal.run !== "0s";
  const still = reduced.cite === "none" && /^0s(, 0s)*$/.test(reduced.memory) && /^0s(, 0s)*$/.test(reduced.run);
  console.log(`${moving ? "PASS" : "FAIL"} 正常：灰字淡入、记忆小条和过程展开都有动效 ${JSON.stringify(normal)}`);
  console.log(`${still ? "PASS" : "FAIL"} 减少动效：三处都直接出现 ${JSON.stringify(reduced)}`);
  failed = !moving || !still;
} finally {
  console.log(failed ? "FAILED" : "ALL PASS");
  await rp.close().catch(() => undefined);
}
