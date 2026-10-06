/**
 * 输入框改版探针（docs/evals/20261006-composer-quiet.md）：只装扩展的无头 Chrome、真侧栏、本机脚本模型。
 * 空闲、点开 ＋、运行中、运行中打字、点「接管」五个时刻：读按钮、颜色、菜单，并截图。
 *
 *   npx tsx scripts/probes/shell/composer-quiet.mts --headless
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";
import { startScriptedModel } from "../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/probes/shell");

await mkdir(out, { recursive: true });

const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<!doctype html><meta charset=\"utf-8\"><title>订票</title><button id=\"b\">查询车票</button>"));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const slow = { name: "click", args: { target: "#b", label: "查询车票" } };

const model = await startScriptedModel([
  { match: "慢任务甲", steps: [{ tool: { name: "snapshot", args: {} }, delayMs: 3000 }, { tool: slow, delayMs: 8000 }, { tool: slow, delayMs: 8000 }, { text: "点好了。" }] },
]);

const failures: string[] = [];

/** evidence 是已序列化的 JSON 文本：探针只打印，不再解析。 */
const check = (name: string, ok: boolean, evidence: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${evidence}`);

  if (!ok) failures.push(name);
};

/** 输入框一行工具：看得见的按钮（id 或类名 + 文字）与颜色。 */
const BAR = `(() => {
  const shown = (e) => e && !e.hidden && e.getClientRects().length > 0;
  const bar = document.querySelector("#composer-bar");
  const items = [...bar.children].filter(shown).map((e) => (e.id || e.className.split(" ")[0]) + (e.textContent.trim() ? ":" + e.textContent.trim() : ""));
  const rgb = (c) => (c.match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
  const send = document.querySelector("#send-btn");
  const composer = document.querySelector("#composer");
  return { items, sendBg: rgb(getComputedStyle(send).backgroundColor), stopping: send.classList.contains("stopping"), border: getComputedStyle(composer).borderTopColor, ribbon: shown(document.querySelector("#steer-ribbon")), voiceCanvas: !!document.querySelector(".voice-start canvas"), placeholder: document.querySelector("#input").placeholder, dot: shown(document.querySelector("#page-pill .tab-live-dot")) };
})()`;

/** 黑或近黑（深色模式下是近白，探针跑浅色）。 */
const dark = (rgb: number[]) => rgb.length === 3 && rgb.every((v) => v < 60);

const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector(\"#send-btn\")?.disabled===false") || undefined, 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await sleep(800);

  // 一、空闲
  const idle = await rp.evaluate(panel, BAR);
  check("空闲：一行只有 ＋、话筒、发送；没有 ···、没有语音光球胶囊、没有绿点", JSON.stringify(idle.items) === JSON.stringify(["attach-btn:+", "composer-spacer", "voice-start", "send-btn"]) && !idle.voiceCanvas && !idle.dot, JSON.stringify(idle));
  await rp.screenshot(panel, join(out, "composer-idle.png"));

  // 二、点开 ＋
  await rp.click(panel, "#attach-btn");
  await sleep(300);
  const menu = await rp.evaluate(panel, "[...document.querySelectorAll(\"#attach-menu > *\")].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()).filter(Boolean)");
  check("＋ 菜单：添加图片的三项 + 边注三项 + 语音诊断", menu.includes("上传本地图片") && menu.includes("原文摘录") && menu.includes("语音诊断"), JSON.stringify(menu));
  await rp.screenshot(panel, join(out, "composer-plus.png"));
  await rp.click(panel, "#attach-menu [data-marginalia=\"source\"]");
  await sleep(200);
  const mode = await rp.evaluate(panel, "({ mode: document.querySelector(\"#marginalia-mode\").value, menuHidden: document.querySelector(\"#attach-menu\").hidden, plusPressed: document.querySelector(\"#attach-btn\").classList.contains(\"active\") })");
  check("＋ 菜单：点「原文摘录」后边注切到原文、菜单收起、＋ 不再停在按下状态", mode.mode === "source" && mode.menuHidden && !mode.plusPressed, JSON.stringify(mode));
  await rp.click(panel, "#attach-btn");
  await rp.click(panel, "#attach-menu [data-marginalia=\"off\"]");

  // 三、运行中
  await rp.click(panel, "#input");
  await rp.typeText(panel, "慢任务甲：点查询车票");
  await rp.pressEnter(panel);

  const running = await until(async () => {
    const bar = await rp.evaluate(panel, BAR);

    return bar.stopping && bar.items.some((i: string) => i.startsWith("takeover-btn")) ? bar : undefined;
  }, 30_000, "运行中");

  check("运行中：停止键是黑色圆，不是红棕色；框不换琥珀色、没有「改方向」提示区", running.stopping && dark(running.sendBg) && !running.ribbon && !/rgb\(2[0-9]{2}, 1[0-9]{2}, /.test(running.border), JSON.stringify(running));
  check("运行中：按钮叫「接管」，占位是「补充或改方向…」，还没打字时没有发送键", running.items.includes("takeover-btn:接管") && running.placeholder === "补充或改方向…" && !running.items.includes("steer-send-btn"), JSON.stringify(running));
  await rp.screenshot(panel, join(out, "composer-running.png"));

  // 四、运行中打字
  await rp.click(panel, "#input");
  await rp.typeText(panel, "只看按钮那一类");
  await sleep(200);
  const typing = await rp.evaluate(panel, BAR);
  const order = typing.items.indexOf("steer-send-btn") >= 0 && typing.items.indexOf("steer-send-btn") < typing.items.indexOf("send-btn");
  check("运行中打字：停止键还在，左边多一个发送键", typing.stopping && order, JSON.stringify(typing));
  await rp.screenshot(panel, join(out, "composer-typing.png"));
  const users = await rp.evaluate(panel, "document.querySelectorAll(\"#messages .msg.user\").length");
  await rp.click(panel, "#steer-send-btn");

  const sent = await until(async () => {
    const r = await rp.evaluate(panel, `({ users: document.querySelectorAll("#messages .msg.user").length, input: document.querySelector("#input").value, steer: !document.querySelector("#steer-send-btn").hidden, stopping: document.querySelector("#send-btn").classList.contains("stopping") })`);

    return r.users > users ? r : undefined;
  }, 10_000, "插话发出").catch(() => null);

  check("点发送键：插话发出、输入框清空、发送键收起、停止键还在", !!sent && sent.input === "" && !sent.steer && sent.stopping, JSON.stringify(sent));

  // 五、接管 → 交还
  await rp.click(panel, "#takeover-btn");

  const held = await until(async () => {
    const t = await rp.evaluate(panel, "document.querySelector(\"#takeover-btn\").textContent");

    return t === "交还" ? t : undefined;
  }, 5_000, "接管后变成交还").catch(() => null);

  check("点「接管」后同一位置变成「交还」", held === "交还", JSON.stringify(held));
  await rp.screenshot(panel, join(out, "composer-held.png"));
} finally {
  console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");
  await rp.close().catch(() => undefined);
  await model.close();
  site.closeAllConnections();
  site.close();
}
