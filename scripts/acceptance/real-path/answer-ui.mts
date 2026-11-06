import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-ui`);

await mkdir(artifacts, { recursive: true });

const hits: string[] = [];
const site = createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<title>page</title>"); });

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const FLIGHT = `杭州回深圳最合适的是 7 月 18 日的 JD5290。
<ui title="杭州到深圳的航班">
root = Col([title, Row([IconButton("minus", @Set($people, @Clamp($people - 1, 1, 9)), "减少"), Text("人数 " + $people, "md"), IconButton("plus", @Set($people, @Clamp($people + 1, 1, 9)), "增加")], 3), total, chart, map, live])
$people = 2
title = Title("杭州到深圳的航班", "lg")
total = Text("合计 " + ($people * 680) + " 元", "md", null, "semibold")
chart = Chart("bar", [{key: "JD5290", value: 680}, {key: "GJ8627", value: 540}], "key", ["value"])
map = Map([MapMarker("杭州萧山机场", 30.2295, 120.4344), MapMarker("深圳宝安机场", 22.6393, 113.8107)], true)
live = Button("查 JD5290 实时状态", @ToAssistant("查 JD5290 实时状态"))
</ui>`;

const model = await startScriptedModel([
  { match: "查 JD5290 实时状态", steps: [{ text: "已查：JD5290 准点。" }] },
  { match: "航班", steps: [{ text: FLIGHT, chunkDelayMs: 10 }] },
]);

const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;
let panel = "";

try {
  panel = await rp.attach(await rp.openSidePanel());

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.disabled===false') || undefined, 60_000, "侧栏就绪");
  const userCount = () => rp.evaluate(panel, `document.querySelectorAll("#messages .msg.user").length`) as Promise<number>;
  const sessions = new Map<string, string>();
  const inFrame = async <T,>(expression: string): Promise<T> => {
    const frame = (await rp.targets()).findLast(t => t.type === "iframe" && t.url.includes("answer-ui.html"));

    if (!frame) throw new Error("没有界面框架");
    const session = sessions.get(frame.targetId) ?? await rp.attach(frame.targetId);

    sessions.set(frame.targetId, session);

    return await rp.evaluate(session, expression) as T;
  };
  const frameText = () => inFrame<string>("document.body.innerText").catch((e: unknown) => { evidence.frameError = String(e); return ""; });
  const clickButton = async (selector: string) => {
    const inside = await inFrame<{ x: number; y: number }>(`(() => { const r = ${selector}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const box = await rp.evaluate(panel, `(() => {
      const f = [...document.querySelectorAll("iframe.gc-app-iframe")].at(-1);
      let scroller = f.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      if (scroller) scroller.scrollTop += f.getBoundingClientRect().y + ${inside.y} - 220;
      const r = f.getBoundingClientRect();
      return { x: r.x, y: r.y };
    })()`) as { x: number; y: number };

    await sleep(250);

    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: box.x + inside.x, y: box.y + inside.y, button: "left", clickCount: 1 }, panel);
  };
  const byText = (text: string) => `[...document.querySelectorAll("button")].find(b => (b.textContent + (b.getAttribute("aria-label") ?? "")).includes(${JSON.stringify(text)}))`;

  await rp.click(panel, "#input");
  await rp.typeText(panel, "航班");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector("iframe.gc-app-iframe")`) || undefined, 60_000, "回答里出现界面");
  await until(async () => (await frameText()).includes("合计 1360 元") || undefined, 20_000, "界面画出来");
  const leaked = await rp.evaluate(panel, `document.querySelector("#messages").innerText`) as string;

  assert.ok(!/<\/?ui|@ToAssistant|MapMarker/.test(leaked), `程序文字不露出：${leaked.slice(0, 200)}`);
  evidence.chart = await inFrame<number>(`document.querySelectorAll("svg").length`);
  const tiles = await until(async () => { const n = await inFrame<number>(`document.querySelectorAll(".leaflet-tile[src^='data:']").length`); return n > 0 ? n : undefined; }, 20_000, "底图由侧栏代取").catch(() => 0);

  evidence.tiles = tiles;
  evidence.tileNote = await inFrame<string>(`document.querySelector(".iui-map-error")?.textContent ?? ""`);
  evidence.pins = await inFrame<number>(`document.querySelectorAll(".iui-map-pin").length`);
  assert.equal(evidence.pins, 2, "两个地点都在地图上");
  await sleep(600);
  await rp.screenshot(panel, join(artifacts, "1-rendered.png"));

  const users = await userCount();

  await clickButton(byText("增加"));
  await until(async () => (await frameText()).includes("合计 2040 元") || undefined, 5_000, "改人数后合计就地变化");
  assert.equal(await userCount(), users, "本地操作不发消息给助手");
  await rp.screenshot(panel, join(artifacts, "2-local.png"));

  // WHY: 真实点击的激活状态约 5 秒后才过期，等过这段才是「用户没有点」。
  await sleep(6_000);
  await inFrame(`(${byText("查 JD5290")}.click(), true)`);
  await sleep(1_000);
  assert.equal(await userCount(), users, "不是用户点击时不能替用户发消息");

  const blocked = await inFrame<string>(`fetch(${JSON.stringify(`${origin}/leak`)}).then(() => "reached", (e) => "blocked")`);

  assert.equal(blocked, "blocked", "沙箱不能联网");
  const refused = await inFrame<string>(`new Promise((resolve) => { addEventListener("message", (e) => { if (e.data && e.data.miniAppReply === 99999) resolve(e.data.ok ? "fetched" : e.data.error); }); parent.postMessage({ miniApp: "net", id: 99999, op: "image", arg: ${JSON.stringify(`${origin}/leak.png`)} }, "*"); })`);

  evidence.refused = refused;
  assert.ok(refused !== "fetched", "侧栏不替界面取别的网站");
  assert.deepEqual(hits, [], `数据没有到别的网站：${hits.join(", ")}`);

  await clickButton(byText("查 JD5290"));
  assert.equal(await userCount(), users, "界面只能提出动作，不能自己提交消息");
  await until(() => rp.evaluate(panel, 'document.querySelector(".gc-app-bar")?.innerText.includes("查 JD5290")'), 5_000, "宿主展示发送内容");
  await rp.click(panel, ".gc-app-bar button");
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].some(m => m.textContent.includes("查 JD5290 实时状态"))`) || undefined, 10_000, "点击后交回助手");
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#messages").innerText`) as string).includes("JD5290 准点") || undefined, 30_000, "助手接着答");
  await rp.screenshot(panel, join(artifacts, "3-handed-back.png"));

  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => (await frameText()).includes("合计 2040 元") || undefined, 30_000, "重开侧栏后状态还在");
  await sleep(500);
  await rp.screenshot(panel, join(artifacts, "4-restored.png"));
} catch (caught) {
  evidence.iframeTargets = (await rp.targets()).filter(t => t.type === "iframe").map(t => t.url);
  evidence.stuck = await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.slice(0, 700)`).catch((e: unknown) => String(e));
  await rp.screenshot(panel, join(artifacts, "failed.png")).catch(() => undefined);
  error = caught instanceof Error ? caught.message : String(caught);
}

await writeFile(join(artifacts, "evidence.json"), JSON.stringify({ error, evidence }, null, 2));
console.log(JSON.stringify({ artifacts, error, evidence }, null, 2));
await rp.close();
await model.close();
site.close();
process.exit(error ? 1 : 0);
