import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-edge-tab-card`);
await mkdir(out, { recursive: true });
const html = `<!doctype html><meta charset="utf-8"><title>报名表</title><body style="font:15px system-ui;padding:40px"><h2>活动报名</h2>${[1, 2, 3, 4, 5].map(i => `<p><label>第 ${i} 项 <input id="f${i}"></label></p>`).join("")}${"<p>说明文字。</p>".repeat(40)}</body>`;
const site = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(html));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const GOAL = "帮我把报名表五项都填上";
const STEER = "第五项填周六下午";
const fill = (i: number, delayMs = 0) => ({ tool: { name: "fill", args: { target: `#f${i}`, value: `值${i}` } }, delayMs });
const payloads: string[] = [];
const model = await startScriptedModel([{ match: "报名表五项", steps: [fill(1), fill(2, 1500), fill(3, 9000), fill(4, 15000), fill(5), { text: "五项都填好了。" }] }], undefined, p => { payloads.push(JSON.stringify(p.messages)); });
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const MID_Y = 84;
type Rect = { x: number; y: number; width: number; height: number };
type Tab = { shown: boolean; tone: string | null; a: string; rect: Rect | null; button: Rect | null; offset: number | null; task: boolean; card: { rect: Rect; input: Rect; goal: string; steps: number; placeholder: string } | null };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const isolated = new Map<string, Set<number>>();
  rp.cdp.onEvent("Runtime.executionContextCreated", (m: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (m.sessionId && m.params.context.auxData?.type === "isolated" && m.params.context.origin.startsWith("chrome-extension://")) { const set = isolated.get(m.sessionId) ?? new Set(); set.add(m.params.context.id); isolated.set(m.sessionId, set); }
  });
  rp.cdp.onEvent("Runtime.executionContextsCleared", (m: { sessionId?: string }) => { if (m.sessionId) isolated.get(m.sessionId)?.clear(); });
  const tab = async (session = work): Promise<Tab | null> => {
    for (const id of [...(isolated.get(session) ?? [])]) {
      // SAFETY: CDP Runtime.evaluate 回 { result: { value } }，value 是 edgeTab() 的可序列化读数。
      const res = await rp.cdp.send("Runtime.evaluate", { expression: "globalThis.__sideagent?.edgeTab?.() ?? undefined", contextId: id, returnByValue: true }, session).catch(() => null) as { result?: { value?: Tab } } | null;
      if (res?.result?.value !== undefined) return res.result.value;
    }
    return null;
  };
  const load = async (session: string) => {
    await rp.cdp.send("Runtime.enable", {}, session);
    await rp.cdp.send("Page.navigate", { url: origin }, session);
    await until(async () => await rp.evaluate(session, "document.readyState === 'complete'") || null, 15_000, "页面载入");
    await sleep(1500);
  };
  await load(work);
  const width = await rp.evaluate(work, "document.documentElement.clientWidth") as number;
  const height = await rp.evaluate(work, "innerHeight") as number;
  const x = width - 5;
  const atEdge = (session: string, y: number) => rp.evaluate(session, `document.elementFromPoint(${x}, ${y})?.getAttribute("data-sideagent-overlay") ?? ""`);
  const mouse = (session: string, type: string, mx: number, my: number, held = false) => rp.cdp.send("Input.dispatchMouseEvent", { type, x: mx, y: my, button: type === "mouseMoved" && !held ? "none" : "left", buttons: held || type === "mousePressed" ? 1 : 0, clickCount: 1 }, session);
  const drag = async (session: string, from: number, to: number) => {
    await mouse(session, "mouseMoved", x, from); await sleep(400);
    await mouse(session, "mousePressed", x, from);
    for (let y = from; Math.abs(to - y) > 1; y += Math.sign(to - y) * Math.min(30, Math.abs(to - y))) { await mouse(session, "mouseMoved", x, y, true); await sleep(16); }
    await mouse(session, "mouseMoved", x, to, true);
    await mouse(session, "mouseReleased", x, to);
    await sleep(600);
  };
  const shot = async (session: string, name: string, y = 0, h = height) => {
    // SAFETY: Page.captureScreenshot 回 { data: base64 }。
    const r = await rp.cdp.send("Page.captureScreenshot", { format: "png", clip: { x: width - 340, y, width: 340, height: h, scale: 2 } }, session) as { data: string };
    await writeFile(join(out, name), Buffer.from(r.data, "base64"));
  };

  check("a0 默认停在原位", await atEdge(work, MID_Y) === "edge-tab", await atEdge(work, MID_Y));
  await drag(work, MID_Y, MID_Y + 300);
  const translated = await rp.evaluate(work, "!!document.querySelector('[data-bys-translation]')");
  await mouse(work, "mouseMoved", width - 400, 300);
  const rested = await until(async () => { const t = await tab(); return t && !t.shown ? t : null; }, 3000, "收回窄条").then(() => true, () => false);
  await shot(work, "a-dragged.png");
  check("a 拖下 300px：停在新位置、不算点、移开收回", await atEdge(work, MID_Y + 300) === "edge-tab" && await atEdge(work, MID_Y) !== "edge-tab" && translated === false && rested, { at: await atEdge(work, MID_Y + 300), translated, rested });

  // SAFETY: Target.createTarget 回 { targetId }。
  const otherId = (await rp.cdp.send("Target.createTarget", { url: "about:blank" }) as { targetId: string }).targetId;
  const other = await rp.attach(otherId);
  await load(other);
  check("b 新开一页停在拖过的高度", await atEdge(other, MID_Y + 300) === "edge-tab", await atEdge(other, MID_Y + 300));
  await drag(other, MID_Y + 300, height - 1);
  const bottom = height - 8 - 20;
  check("c 拖到窗口底不出界", await atEdge(other, bottom) === "edge-tab", { height, bottom, at: await atEdge(other, bottom) });
  await sleep(500);
  check("b2 第一页跟着同步", await atEdge(work, bottom) === "edge-tab", await atEdge(work, bottom));
  await rp.cdp.send("Target.closeTarget", { targetId: otherId });

  await rp.cdp.send("Page.bringToFront", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`) || undefined, 30_000, "侧栏可发送");
  await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "test-key" } }, { asCustom: true, baseUrl: model.baseUrl });
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input"); await rp.typeText(panel, GOAL); await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(work, `document.querySelector("#f2").value === "值2"`) || undefined, 30_000, "前两项已填");
  await rp.cdp.send("Target.closeTarget", { targetId: (await rp.targets()).find(t => t.url.includes("sidepanel"))!.targetId });
  await until(async () => { const t = await tab(); return t?.shown && t.tone === "work" && t.task ? t : null; }, 10_000, "胶囊在做");
  await sleep(800);
  const working = (await tab())!;
  await shot(work, "d0-collapsed.png");
  await mouse(work, "mouseMoved", working.button!.x - 30, working.button!.y + working.button!.height / 2);
  await until(async () => (await tab())?.card || null, 3000, "进度卡展开").catch(() => null);
  await sleep(600);
  const opened = await tab();
  await shot(work, "d-card.png");
  const c = opened?.card;
  const stayed = Math.abs((opened?.button?.y ?? -99) - (working.button?.y ?? 99)) < 2;
  check("d 悬停展开成进度卡：目标、做过的步骤；在窗口里，停止键没挪", Boolean(c && c.goal.includes("报名表") && c.steps >= 2 && c.rect.y >= 0 && c.rect.y + c.rect.height <= height) && stayed, { card: c ?? null, before: working.button, after: opened?.button ?? null });

  if (c) {
    await mouse(work, "mouseMoved", c.input.x + 40, c.input.y + c.input.height / 2);
    await mouse(work, "mousePressed", c.input.x + 40, c.input.y + c.input.height / 2);
    await mouse(work, "mouseReleased", c.input.x + 40, c.input.y + c.input.height / 2);
    await rp.cdp.send("Input.insertText", { text: STEER }, work);
    await mouse(work, "mouseMoved", width - 600, 300);
    await sleep(900);
    const kept = Boolean((await tab())?.card);
    await shot(work, "e-typed.png");
    const before = payloads.length;
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, work);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, work);
    await sleep(500);
    const placeholder = (await tab())?.card?.placeholder ?? "";
    await shot(work, "e-sent.png");
    const delivered = await until(async () => payloads.slice(before).some(p => p.includes(STEER)) || null, 30_000, "模型收到补的一句").then(() => true, () => false);
    const leaked = await rp.evaluate(work, `[1,2,3,4,5].some(i => document.querySelector("#f"+i).value.includes("周六"))`);
    check("e 补一句：打字时不收起、卡上说已交给助手、模型收到、没漏进网页", kept && placeholder.includes("已交给助手") && delivered && leaked === false, { kept, placeholder, delivered, leaked });

    await rp.evaluate(work, "document.activeElement?.blur?.(); true");
    await mouse(work, "mouseMoved", width - 600, 320);
    const closed = await until(async () => { const t = await tab(); return t && !t.card ? true : null; }, 4000, "收起").then(() => true, () => false);

    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] }, work);
    const again = await until(async () => { const t = await tab(); return t?.rect && t.rect.height < 41 && t.button ? t : null; }, 3000, "缩回一行").catch(() => null);
    const beforeDark = again ? { tone: again.tone, task: again.task, button: again.button } : null;
    if (again?.button) await mouse(work, "mouseMoved", again.button.x - 30, again.button.y + again.button.height / 2);
    const darkCard = await until(async () => (await tab())?.card || null, 3000, "深色下展开").catch(() => null);
    await sleep(400);
    await shot(work, "f-dark-reduced.png");
    check("f 发完移开收回；深色加减少动态效果照样展开", closed && Boolean(darkCard?.goal), { closed, beforeDark, darkCard: darkCard ?? null });
  }
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, dependency: "real isolated extension, real side panel; local form page; scripted model" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
