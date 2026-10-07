/**
 * 主动卡「动词即按钮」验收（docs/evals/20261007-proactive-card-verb.md R1、R3）：只装扩展的无头 Chrome、真侧栏开着。
 * 真页面停留并滚动，脚本模型给出建议；卡出在侧栏对话流里而不是页角。
 * 截三种状态：初始、悬停出 ×、点句子进输入框；再点 × 收起。
 *
 *   npx tsx scripts/acceptance/real-path/proactive-card.mts --headless
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/proactive-card");

await mkdir(out, { recursive: true });

const failures: string[] = [];

const check = (name: string, ok: boolean, evidence: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(evidence)}`);

  if (!ok) failures.push(name);
};

const body = "您的订单已确认。全季酒店 北京国贸店，入住 10 月 8 日，退房时间 12:00。如需延迟退房请联系前台。".repeat(10);

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>订单确认邮件</title><article><p>${body}</p></article><div style="height:3000px"></div>`));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const pageUrl = `http://127.0.0.1:${siteAddress(site).port}/`;

const offer = { offer: true, actionLabel: "申请", sentence: "晚退房到 14:00", party: "全季酒店 北京国贸店", evidence: [{ text: "退房时间 12:00", url: pageUrl }], prompt: "给全季酒店北京国贸店前台发邮件，申请明天晚退房到 14:00。" };

// 建议判断收到的是页面 JSON（含标题）；其余请求不该出现：发出去了就会多一条用户消息。
const model = await startScriptedModel([{ match: "订单确认邮件", steps: [{ text: JSON.stringify(offer) }] }, { match: "", steps: [{ text: "不该发出。" }] }]);

const rp = await launchRealPath();

const CARD = `(() => {
  const card = document.querySelector("#messages .pc");
  if (!card) return null;
  const x = card.querySelector(".pc-x");
  return {
    verb: card.querySelector(".pc-verb")?.textContent,
    obj: card.querySelector(".pc-obj")?.textContent,
    src: card.querySelector(".pc-src")?.textContent,
    icon: !!card.querySelector(".pc-obj img.pc-icon"),
    xOpacity: x ? getComputedStyle(x).opacity : null,
    lastInThread: [...document.querySelectorAll("#messages > *")].filter(n => n.id !== "resume-entry-root").at(-1) === card,
  };
})()`;

const STATE = "({ input: document.querySelector('#input').value, users: document.querySelectorAll('#messages .msg.user').length, focused: document.activeElement?.id })";

try {
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { sideagent_nudge: true, inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector('#app')?.classList.contains('starter-ready')") || undefined, 60_000, "侧栏草稿恢复完");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: false }, panel);

  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, work);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await sleep(2000);
  await rp.evaluate(work, "window.scrollBy(0, 400), true");

  // R1：停留够久后卡出在侧栏对话流最新处，一句话、动词是按钮、出处一行；页角不出卡。
  const card = await until(async () => await rp.evaluate(panel, CARD), 60_000, "侧栏出卡", 500).catch(() => null);
  const corner = await rp.evaluate(work, "!!document.querySelector('[data-sideagent-overlay=\"nudge\"]')");
  check("R1 卡出在侧栏：动词「申请」是按钮，句子带对象和图标，出处一行，页角没卡", !!card && card.verb === "申请" && String(card.obj).includes("晚退房到 14:00") && String(card.obj).includes("全季酒店 北京国贸店") && card.icon && String(card.src).startsWith("来自：订单确认邮件 · ") && card.lastInThread && corner === false, { card, corner });
  await rp.screenshot(panel, join(out, "1-initial.png"));

  // R3：悬停出 ×。
  const box = await rp.evaluate(panel, "(() => { const r = document.querySelector('#messages .pc').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 8 }; })()");
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, panel);
  await sleep(300);
  const hovered = await rp.evaluate(panel, CARD);
  check("R3 悬停出 ×", hovered?.xOpacity === "1", hovered);
  await rp.screenshot(panel, join(out, "2-hover.png"));

  // R3：点句子其余部分，这件事进输入框当草稿，不发出。
  await rp.click(panel, "#messages .pc-obj");
  await sleep(800);
  const asked = await rp.evaluate(panel, STATE);
  check("R3 点句子：输入框出现「关于「申请晚退房到 14:00」：」，没有发出，卡还在", asked.input === "关于「申请晚退房到 14:00」：" && asked.users === 0 && asked.focused === "input" && !!(await rp.evaluate(panel, CARD)), asked);
  await rp.screenshot(panel, join(out, "3-ask.png"));

  // R3：点 × 收起，后台记下这张卡已收。
  await rp.click(panel, "#messages .pc-x");
  const gone = await until(async () => (await rp.evaluate(panel, "!document.querySelector('#messages .pc')")) || undefined, 3_000, "卡收起").catch(() => false);
  const stored = await rp.evaluate(panel, "chrome.storage.session.get('sideagent_nudge_panel').then(r => r.sideagent_nudge_panel ?? null)");
  check("R3 点 × 收起，存储里的卡也删了，没有发出", gone === true && stored === null && (await rp.evaluate(panel, STATE)).users === 0, { gone, stored });
  await rp.screenshot(panel, join(out, "4-dismissed.png"));
} finally {
  console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");
  await rp.close().catch(() => undefined);
  await model.close();
  site.closeAllConnections();
  site.close();
}
