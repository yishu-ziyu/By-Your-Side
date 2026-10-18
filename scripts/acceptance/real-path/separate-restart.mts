/**
 * 另开一件做到一半，扩展后台重启：卡片不能一直写「正在做」。
 * 只装扩展、隔离构建、本机脚本模型、本机练习页；重启用关掉 offscreen 文档模拟，只证明程序这一层。
 *   npx tsx scripts/acceptance/real-path/separate-restart.mts --headless
 * 判据：
 *   a) 能安全接着做：重启后另开那件自动接着做完，卡片换成「已完成 + 回答」；主任务也交出回答；卡片只有一张。
 *   b) 不能自动接着做（重启前那页换了网址，不是原页面）：卡片写「停下了」并有「继续」；回到原页点继续后做完，卡片换成「已完成 + 回答」，
 *      当前会话里不多出一句用户没打的话。
 * 失败方式：另开一件的记录只在内存里，重启后 a) 的卡片停在「正在做，不打断当前任务」。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-separate-restart`);

await mkdir(artifacts, { recursive: true });

const A = "把这页的论文标题整理成清单";
const B = "顺便帮我查一下明天北京的天气";
const A2 = "把这页的作者整理成名单";
const B2 = "另外帮我查一下后天上海的天气";

const slow = (n: number) => Array.from({ length: n }, () => ({ tool: { name: "snapshot", args: {} }, delayMs: 2_000 }));

const model = await startScriptedModel([
  // 判断「补充还是另一件」：两句都是另一件。
  { match: `"message":"${B}"`, steps: [{ text: JSON.stringify({ kind: "separate" }) }] },
  { match: `"message":"${B2}"`, steps: [{ text: JSON.stringify({ kind: "separate" }) }] },
  { match: B2, steps: [...slow(4), { text: "后天上海多云，15–22 度。" }] },
  { match: B, steps: [...slow(4), { text: "明天北京晴，12–21 度。" }] },
  { match: A2, steps: [...slow(8), { text: "作者名单：张三。" }] },
  { match: A, steps: [...slow(10), { text: "论文清单：1. 甲 2. 乙 3. 丙" }] },
]);

const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>论文</title><h1>论文列表</h1><p>甲 乙 丙 张三</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

const STATE = `(() => {
  const m = document.querySelector("#messages");
  return {
    cards: [...m.querySelectorAll(".separate-ask")].map(e => ({ tag: e.querySelector(".separate-ask-tag")?.textContent ?? "", state: e.querySelector(".separate-ask-state")?.textContent ?? "", answer: e.querySelector(".separate-ask-answer")?.textContent?.trim() ?? "", buttons: [...e.querySelectorAll(".separate-ask-actions button")].map(b => b.textContent) })),
    answers: [...m.querySelectorAll(".msg.assistant[data-delivery-id]")].map(e => e.innerText.trim().split("\\n")[0]),
    running: !!document.querySelector("#status-pill.running"),
    bubbles: [...m.querySelectorAll(".msg.user")].map(e => e.innerText.trim().split("\\n")[0]),
  };
})()`;

type Card = { tag: string; state: string; answer: string; buttons: string[] };

type State = { cards: Card[]; answers: string[]; running: boolean; bubbles: string[] };

let panel: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  const papers = `http://127.0.0.1:${siteAddress(site).port}/papers`;
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: papers }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel!, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  const send = async (text: string) => { await rp.click(panel!, "#input"); await rp.typeText(panel!, text); await rp.pressEnter(panel!); };
  const state = async () => await rp.evaluate(panel!, STATE) as State;
  const card = (s: State, tag: string) => s.cards.find(c => c.tag === tag);
  const restartAgent = async () => {
    const inproc = (await rp.targets()).find((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`);
    assert.ok(inproc, "找不到 offscreen 文档");
    await rp.cdp.send("Target.closeTarget", { targetId: inproc.targetId });
    await until(async () => (await rp.targets()).some((t) => t.url === inproc.url && t.targetId !== inproc.targetId) || undefined, 30_000, "扩展内 agent 重新起来");
  };
  const settle = async (done: (s: State) => boolean, ms: number) => {
    const start = Date.now();
    let last = await state();
    while (!done(last) && Date.now() - start < ms) { await sleep(1_000); last = await state(); }
    return last;
  };

  // a) 能安全接着做。
  await send(A);
  await until(async () => (await state()).running || undefined, 15_000, "A 开始");
  await sleep(2_500);
  await send(B);
  await until(async () => card(await state(), B) ? true : undefined, 15_000, "B 另开");
  await sleep(3_000);
  evidence.aBefore = await state();
  assert.equal(card(evidence.aBefore as State, B)?.state, "正在做，不打断当前任务", "重启前 B 应在做");
  await restartAgent();
  const a = await settle(s => !!card(s, B)?.answer && s.answers.some(t => t.startsWith("论文清单")) && !s.running, 90_000);
  evidence.aAfter = a;
  await rp.screenshot(panel, join(artifacts, "a-after-restart.png"));
  assert.equal(a.cards.filter(c => c.tag === B).length, 1, "B 只有一张卡");
  assert.equal(card(a, B)?.state, "已完成", `a) 重启后 B 的卡片应换成已完成，实际：${card(a, B)?.state}`);
  assert.match(card(a, B)!.answer, /明天北京晴/);
  assert.ok(a.answers.some(t => t.startsWith("论文清单")), "a) 主任务交出回答");

  // b) 不能自动接着做：重启前这页换了网址，宿主核对页面不符就不续做。
  await send(A2);
  await until(async () => (await state()).running || undefined, 15_000, "A2 开始");
  await sleep(2_500);
  await send(B2);
  await until(async () => card(await state(), B2) ? true : undefined, 15_000, "B2 另开");
  await sleep(3_000);
  await rp.cdp.send("Page.navigate", { url: `${papers}?moved=1` }, work);
  await restartAgent();
  const stopped = await settle(s => /停下了/.test(card(s, B2)?.state ?? "") && !s.running, 60_000);
  evidence.bStopped = stopped;
  await rp.screenshot(panel, join(artifacts, "b-stopped.png"));
  assert.match(card(stopped, B2)?.state ?? "", /停下了/, `b) B2 不能自动接着做时卡片应写停下了，实际：${card(stopped, B2)?.state}`);
  assert.ok(card(stopped, B2)!.buttons.includes("继续"), "b) 停下的卡片有「继续」");
  await rp.cdp.send("Page.navigate", { url: papers }, work);
  await sleep(1_500);
  await rp.evaluate(panel, `[...document.querySelectorAll(".separate-ask")].find(e => e.querySelector(".separate-ask-tag")?.textContent === ${JSON.stringify(B2)})?.querySelectorAll(".separate-ask-actions button").forEach(b => { if (b.textContent === "继续") b.click(); })`);
  const resumed = await settle(s => !!card(s, B2)?.answer, 60_000);
  evidence.bResumed = resumed;
  await rp.screenshot(panel, join(artifacts, "b-resumed.png"));
  assert.equal(card(resumed, B2)?.state, "已完成", `b) 点继续后 B2 应做完，实际：${card(resumed, B2)?.state}`);
  assert.match(card(resumed, B2)!.answer, /后天上海多云/);
  assert.deepEqual(resumed.bubbles, stopped.bubbles, `b) 点继续不应在当前会话多出用户气泡：${resumed.bubbles.join(" / ")}`);
  console.log("PASS separate-restart");
} catch (e) { error = String((e as Error)?.stack ?? e); console.error(e); process.exitCode = 1; }
finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ error, evidence }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
  console.log("artifacts", artifacts);
}
