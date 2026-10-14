/**
 * 回答卡片流式时先占位、内容原地填入。
 *   npx tsx scripts/acceptance/real-path/card-placeholder.mts --headless
 *
 * 隔离的无窗口 Chrome，只装扩展；模型是本机脚本模型，按时间写出一段含卡片的回答（标签写到一半时停一下）。
 * 侧栏里每一帧（requestAnimationFrame）记下每个组件位置上是空位还是内容、空位透明度、高度、节点是不是原来那个。
 * 判据（只判用户看得见的）：
 * 1. 写得慢的组件：开头放出后有空位；过了一小会儿（--d-micro）空位里浮出占位条。
 * 2. 写完：空位原地变成内容，高度差 ≤ 8px，位置不跳；先前已显示的组件还是同一个节点。
 * 3. 150ms 内写完的组件：占位条从没浮出来。
 * 4. 卡片没写完时没有按钮，写完后有。
 * 5. 减少动态效果：内容没有淡入动画，占位条也不渐显。
 * 另：回答在卡片写到一半时就结束了（被截断），最终稿里不留空位（审查发现的回归；按停止时产品整条撤掉半截回答，不走这里）。
 * 产物：out/acceptance/real-path/<时间>-card-placeholder/result.json 与截图。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule, type TextStep } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-card-placeholder`);

await mkdir(artifacts, { recursive: true });

// 卡片标记一到就放：京东那格由模型分两截写，后半截隔 60ms 到，它在 150ms 内写完。
// 表格最后一行和「最低到手」写到一半时，侧栏各要等约 1.5 秒才等到后半截。
const ROWS = Array.from({ length: 18 }, (_, i) => `<tr cells="店铺${i + 1}|${1500 + i * 10}|${(i % 3) + 1}天" />`).join("\n");

const PIECES: NonNullable<TextStep["pieces"]> = [
  { text: "三家到手价放在下面的卡片里。\n" },
  { text: `<card title="耳机三家到手价" sub="算上运费和券">\n<stat label="京东" value="16`, delayMs: 800 },
  { text: `99" unit="¥" note="次日达" />\n<callout tone="info">${"天猫店铺券满1500减50，要先领券再下单。".repeat(3)}</callout>\n<table cols="店铺|到手价|到货">\n${ROWS}\n<tr cells="拼多多|`, delayMs: 60 },
  { text: `1529|3天" />\n</table>\n<stat label="最低到手" value="=`, delayMs: 5000 },
  { text: `1529+0" unit="¥" tag="最低" />\n`, delayMs: 2300 },
  { text: `<button action="say" primary>就买拼多多的</button>\n`, delayMs: 700 },
  { text: `</card>\n拼多多最便宜，但是第三方店铺。`, delayMs: 700 },
];

const step = (): TextStep => ({ text: PIECES.map((p) => p.text).join(""), pieces: PIECES });

const rules: Rule[] = [
  { match: "写到一半截断", steps: [{ text: "", pieces: [{ text: `先看两家。\n<card title="截断的卡片">\n<stat label="京东" value="1699" unit="¥" />\n<stat label="天猫" ` }] }] },
  { match: "减少动态时比一下", steps: [step()] },
  { match: "比一下三家", steps: [step()] },
];

/** 每帧记录最后一张卡片里每个组件位置的状态；写完的组件节点打上记号，最后看它还在不在。 */
const WATCH = `(() => {
  const S = window.__cp = { comps: {}, both: 0, btnAt: null, frames: 0 };
  const loop = () => {
    const now = performance.now();
    const answers = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".gen-card"));
    const card = answers.at(-1)?.querySelector(".gen-card");
    if (card && answers.length === window.__cpWant) {
      S.frames++;
      const top = card.getBoundingClientRect().top;
      for (const el of card.querySelectorAll("[data-gc-key]")) {
        const ph = el.classList.contains("gc-ph");
        if (!ph && !el.hasAttribute("data-gc-sig")) continue;
        const key = el.dataset.gcKey;
        const c = (S.comps[key] ??= { maxOpacity: 0 });
        const r = el.getBoundingClientRect();
        if (ph) {
          c.phAt ??= now; c.phH = r.height; c.phTop = r.top - top;
          const op = Number(getComputedStyle(el).opacity);
          c.maxOpacity = Math.max(c.maxOpacity, op);
          if (op > 0) c.barAt ??= now;
          c.phAnims = Math.max(c.phAnims ?? 0, el.getAnimations().filter((a) => a.effect.getTiming().duration > 0).length);
        } else if (c.doneAt === undefined) {
          c.doneAt = now; c.doneH = r.height; c.doneTop = r.top - top; c.text = el.textContent;
          c.fadeAnims = el.getAnimations().filter((a) => a.effect.getTiming().duration > 0).length;
          el.__mark = key;
        }
      }
      const btn = card.querySelector(".gc-btn");
      if (btn && card.querySelector(".gc-ph")) S.both++;
      if (btn) S.btnAt ??= now;
      S.lastPhAt = card.querySelector(".gc-ph") ? now : S.lastPhAt;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return true;
})()`;

/** 回答写完后：写完过的组件现在的节点是不是当初那个。 */
const FINAL = `(() => {
  const answer = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".gen-card")).at(-1);
  const card = answer.querySelector(".gen-card");
  const S = window.__cp;
  const replaced = Object.keys(S.comps).filter((k) => S.comps[k].doneAt !== undefined && card.querySelector('[data-gc-key="' + k + '"][data-gc-sig]')?.__mark !== k);
  return { ...S, replaced, buttons: [...card.querySelectorAll(".gc-btn")].map((b) => b.textContent), placeholdersLeft: card.querySelectorAll(".gc-ph").length };
})()`;

type Comp = { phAt?: number; barAt?: number; doneAt?: number; phH?: number; doneH?: number; phTop?: number; doneTop?: number; maxOpacity: number; phAnims?: number; fadeAnims?: number; text?: string };

type Final = { comps: Record<string, Comp>; both: number; btnAt: number | null; lastPhAt?: number; frames: number; replaced: string[]; buttons: string[]; placeholdersLeft: number };

const model = await startScriptedModel(rules);

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.evaluate(panel, WATCH);

  const ask = async (text: string, n: number): Promise<Final> => {
    await rp.evaluate(panel, `window.__cpWant = ${n}; window.__cp.comps = {}; window.__cp.both = 0; window.__cp.btnAt = null; true`);
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".gen-card")); return a.length >= ${n} && !!a.at(-1).querySelector(".answer-actions") && !a.at(-1).dataset.revealing; })()`) || undefined, 60_000, `第 ${n} 张卡片写完`);
    await sleep(600);

    // SAFETY: FINAL 返回的字段与 Final 一一对应。
    return await rp.evaluate(panel, FINAL) as Final;
  };

  const failures: string[] = [];

  const judge = (label: string, f: Final, reduced: boolean) => {
    const ok = (pass: boolean, item: string) => { console.log(`${pass ? "PASS" : "FAIL"} ${item.slice(0, 300)}`); if (!pass) failures.push(item); };
    const fast = f.comps["b0.0"];
    const slow = { row: f.comps["b2.18"], stat: f.comps["b3.0"] };
    ok(fast?.doneAt !== undefined, `${label} 京东那格写完了 ${JSON.stringify(fast)}`);
    // 3：150ms 内写完的组件，占位条从没浮出来（前提：它真的在 150ms 内写完）。
    // 减少动态时不逐字放出，整段一次到位，京东那格没有空位这一步。
    if (!reduced) ok(fast!.phAt !== undefined && fast!.doneAt! - fast!.phAt < 150, `${label} 3 前提：京东那格出现过空位且 150ms 内写完 ${JSON.stringify(fast)}`);
    ok(fast!.maxOpacity === 0, `${label} 3 写得快的组件没出现占位条 ${JSON.stringify(fast)}`);

    for (const [name, c] of Object.entries(slow)) {
      ok(c?.phAt !== undefined, `${label} 1 ${name} 写到一半时有空位 ${JSON.stringify(c)}`);
      ok(c!.barAt !== undefined && c!.barAt - c!.phAt! >= 100 && c!.barAt - c!.phAt! <= 400, `${label} 1 ${name} 约 150ms 后浮出占位条 ${JSON.stringify(c)}`);
      ok(c!.doneAt !== undefined && c!.doneAt - c!.phAt! > 1000, `${label} 1 ${name} 写完前空位一直在 ${JSON.stringify(c)}`);
      ok(Math.abs(c!.phH! - c!.doneH!) <= 8, `${label} 2 ${name} 空位与内容高度差 ≤ 8px ${JSON.stringify(c)}`);
      ok(Math.abs(c!.phTop! - c!.doneTop!) <= 2, `${label} 2 ${name} 内容出现在空位原处 ${JSON.stringify(c)}`);

      if (reduced) ok(c!.phAnims === 0, `${label} 5 ${name} 占位条不渐显 ${JSON.stringify(c)}`);
      else ok(c!.fadeAnims! > 0, `${label} ${name} 写完的内容淡入 ${JSON.stringify(c)}`);

      if (reduced) ok(c!.fadeAnims === 0, `${label} 5 ${name} 内容没有淡入动画 ${JSON.stringify(c)}`);
    }

    ok(JSON.stringify(f.replaced) === JSON.stringify([]), `${label} 2 已显示的组件节点没被替换：被换掉的 ${JSON.stringify(f.replaced)}`);
    ok(Object.values(f.comps).filter((c) => c.doneAt !== undefined).length >= 20, `${label} 2 检查的组件数够 ${Object.keys(f.comps).length}`);
    // 4：卡片没写完时没有按钮（有空位的帧里一次也没出现按钮，最后一个组件写完后还要等到卡片收尾），写完后有。
    ok(f.both === 0, `${label} 4 卡片没写完时没有按钮`);
    ok(f.btnAt !== null && f.btnAt - slow.stat!.doneAt! > 1000, `${label} 4 按钮等卡片写完才出现 ${f.btnAt} vs ${slow.stat!.doneAt}`);
    ok(JSON.stringify(f.buttons) === JSON.stringify(["就买拼多多的"]), `${label} 4 写完后有按钮`);
    ok(f.placeholdersLeft === 0, `${label} 写完后不留空位`);
  };

  const normal = await ask("比一下三家", 1);
  evidence.normal = normal;
  await rp.screenshot(panel, join(artifacts, "normal.png"));
  judge("常规", normal, false);

  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  const reduced = await ask("减少动态时比一下", 2);
  evidence.reduced = reduced;
  await rp.screenshot(panel, join(artifacts, "reduced.png"));
  judge("减少动态", reduced, true);

  // 回答在卡片写到一半时结束：最终稿里不留空位，已写完的格子还在。
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] }, panel);
  await rp.click(panel, "#input");
  await rp.typeText(panel, "写到一半截断");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .msg.assistant")].filter((m) => m.querySelector(".gen-card")); return a.length >= 3 && !!a.at(-1).querySelector(".answer-actions") && !a.at(-1).dataset.revealing; })()`) || undefined, 60_000, "截断的回答写完");
  await sleep(600);
  // SAFETY: 表达式返回下面这个形状的对象。
  const cut = await rp.evaluate(panel, `(() => { const card = [...document.querySelectorAll("#messages .gen-card")].at(-1); return { title: card?.querySelector(".gc-title")?.textContent, placeholders: card?.querySelectorAll(".gc-ph").length, stats: [...(card?.querySelectorAll(".gc-stat") ?? [])].map((s) => s.textContent) }; })()`) as { title?: string; placeholders: number; stats: string[] };
  evidence.truncated = cut;
  await rp.screenshot(panel, join(artifacts, "truncated.png"));
  const cutOk = cut.title === "截断的卡片" && cut.placeholders === 0 && cut.stats.length === 1;
  console.log(`${cutOk ? "PASS" : "FAIL"} 截断的最终稿不留空位 ${JSON.stringify(cut)}`);
  if (!cutOk) failures.push(`截断的最终稿不留空位 ${JSON.stringify(cut)}`);
  assert.deepEqual(failures, [], failures.join("\n"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
