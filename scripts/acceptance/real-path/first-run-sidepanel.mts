/**
 * #233 / #236：全新配置、没连模型时的侧栏。只装扩展，脚本模型，无头。
 *
 * 1. 不输入：空侧栏显示「先连一个模型」和按钮（R1）；发送键是禁用样子，打一个字后恢复（P1）。
 * 2. 发「这页讲了什么？」：卡片写「连好以后，这句话会自动发出。」
 * 3. 点卡片按钮打开设置页、不连模型就关掉：什么都不发。
 * 4. 在输入框打一段新草稿，再从设置页连好脚本模型：原话自动发一次，只有一个用户气泡，草稿不动（R3）。
 * 5. 新会话：起点引导照常出现，没有连模型入口（R2）；运行中发送键是停止键，不是禁用样子。
 * 6. 圈出来问的按键：本机系统写法；模拟 Linux 后写 Ctrl+Shift+S（P3）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const QUESTION = "这页讲了什么？";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-first-run-sidepanel`);
await mkdir(out, { recursive: true });

/** 带工具表的主任务请求里，用户消息的原文：看重发问的是哪一页。 */
const askedTexts: string[] = [];
const model = await startScriptedModel([
  { match: QUESTION, steps: [{ text: "这是一个空白页，没有正文。" }] },
  { match: "再问一句", steps: [{ text: "好的。", delayMs: 4000 }] },
], undefined, (payload) => {
  if (!payload.tools?.length) return;
  const users = (payload.messages ?? []).filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((part) => part.text ?? "").join(""));
  if (users.some((text) => text.includes(QUESTION))) askedTexts.push(users.join("\n"));
});

// 用户在读一页真实网页时打开侧栏；设置页开在新标签页，关掉它不能把窗口一起关掉。
const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<title>宫崎骏</title><h1>宫崎骏</h1><p>日本动画导演。</p>"); });
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();
const results: Array<[string, boolean, unknown?]> = [];
const check = (name: string, pass: boolean, detail?: unknown) => { results.push([name, pass, detail]); };
let error: string | null = null;

/** 用户看得到的东西：起点引导、发送键、消息流。 */
const view = (panel: string) => rp.evaluate(panel, `(() => {
  const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
  const send = document.querySelector("#send-btn");
  if (!send) return { starterShown: false, users: [], cards: [], text: "" };
  const probe = document.createElement("div");
  probe.style.background = "var(--content-subtle)";
  document.body.append(probe);
  const greyBg = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return {
    starterShown: shown(document.querySelector("#starter")),
    title: document.querySelector("#starter-title")?.textContent,
    connectShown: shown(document.querySelector("#starter-connect")),
    connectText: document.querySelector("#starter-connect")?.textContent,
    suggestionsShown: shown(document.querySelector("#starter-actions")),
    sendAriaDisabled: send.getAttribute("aria-disabled"),
    sendStopping: send.classList.contains("stopping"),
    sendBg: getComputedStyle(send).backgroundColor,
    greyBg,
    users: [...document.querySelectorAll(".msg.user")].map((b) => b.textContent.trim()),
    cards: [...document.querySelectorAll(".receipt-decision")].map((c) => c.textContent.trim()),
    input: document.querySelector("#input").value,
    text: document.querySelector("#messages").innerText,
  };
})()`) as Promise<{ starterShown: boolean; title: string; connectShown: boolean; connectText: string; suggestionsShown: boolean; sendAriaDisabled: string | null; sendStopping: boolean; sendBg: string; greyBg: string; users: string[]; cards: string[]; input: string; text: string }>;

const backspace = async (panel: string) => {
  const key = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, panel);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, panel);
};

/** 主任务请求（带工具表）里命中这句话的次数。 */
const asked = (match: string) => model.requests.filter((r) => r.rule === match && r.tools).length;

try {
  const tab = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "网页标签");
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, await rp.attach(tab.targetId));
  const panel = await rp.attach(await rp.openSidePanel());
  const opened = Date.now();
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  // 1. 不输入，看空侧栏。
  const empty = await until(async () => { const v = await view(panel); return v.starterShown && v.connectShown ? v : undefined; }, 20_000, "空侧栏出现连模型入口").catch(() => null);
  const shownAfterMs = Date.now() - opened;
  await rp.screenshot(panel, join(out, "01-empty-no-model.png"));
  const first = empty ?? await view(panel);
  check("R1 没连模型、没输入时，2 秒内显示「先连接模型」和「连接模型」按钮，建议收起", !!empty && shownAfterMs <= 2000 && first.title === "先连接模型" && first.connectText === "连接模型" && !first.suggestionsShown, { shownAfterMs, title: first.title, connect: first.connectText, suggestions: first.suggestionsShown });

  await rp.click(panel, "#starter-connect");
  const starterSettings = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "入口打开设置页").catch(() => null);
  check("R1 点「连接模型」打开模型设置页", !!starterSettings);
  if (starterSettings) await rp.cdp.send("Target.closeTarget", { targetId: starterSettings.targetId });

  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled === false') || undefined, 30_000, "会话就绪");
  const idle = await view(panel);
  check("P1 空输入框：发送键 aria-disabled=true，底色是禁用灰", idle.sendAriaDisabled === "true" && idle.sendBg === idle.greyBg, { aria: idle.sendAriaDisabled, bg: idle.sendBg, grey: idle.greyBg });

  await rp.click(panel, "#input");
  await rp.typeText(panel, "x");
  await sleep(300);
  const typed = await view(panel);
  await rp.screenshot(panel, join(out, "02-one-char.png"));
  check("P1 打一个字：发送键不再是禁用样子", typed.sendAriaDisabled === null && typed.sendBg !== typed.greyBg, { aria: typed.sendAriaDisabled, bg: typed.sendBg });
  await backspace(panel);
  await sleep(300);
  check("P1 删掉这个字：发送键回到禁用样子", (await view(panel)).sendAriaDisabled === "true");

  // 2. 没连模型发话。
  await rp.typeText(panel, QUESTION);
  await rp.pressEnter(panel);
  const carded = await until(async () => { const v = await view(panel); return v.cards.length ? v : undefined; }, 30_000, "没连模型卡片");
  await sleep(300);
  await rp.screenshot(panel, join(out, "03-needs-model-card.png"));
  check("卡片写「连好以后，这句话会自动发出。」", carded.cards[0]?.includes("连好以后，这句话会自动发出。") === true, carded.cards);

  // 3. 打开设置页、不连模型就关掉。
  await rp.click(panel, ".receipt-decision button");
  const settings = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "设置页打开");
  await sleep(1500);
  await rp.cdp.send("Target.closeTarget", { targetId: settings.targetId });
  await sleep(4000);
  const untouched = await view(panel);
  check("反例：设置页没连模型就关掉，什么都不发", asked(QUESTION) === 0 && untouched.users.length === 1 && untouched.cards[0]?.includes("这句话会自动发出") === true, { requests: asked(QUESTION), users: untouched.users, cards: untouched.cards });

  // 4. 打一段新草稿，再连好模型。
  await rp.click(panel, "#input");
  await rp.typeText(panel, "草稿别动");
  const config = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "fixture", credential: { type: "api_key", key: "local-fixture" } }, { baseUrl: model.baseUrl });
  const answered = await until(async () => { const v = await view(panel); return v.text.includes("这是一个空白页，没有正文。") ? v : undefined; }, 45_000, "自动重发后的回答").catch(() => null);
  await sleep(3000);
  const after = await view(panel);
  await rp.screenshot(panel, join(out, "04-resent.png"));
  check("R3 连好模型后原话自动发出，模型只收到一次", !!answered && asked(QUESTION) === 1, { requests: asked(QUESTION), save: config.saveStatus });
  check("R3 会话里只有一个用户气泡", after.users.length === 1 && after.users[0]?.startsWith(QUESTION) === true, after.users);
  check("R3 重发问的是原来那页，不是重发时开着的设置页", askedTexts.length === 1 && askedTexts[0]!.includes("宫崎骏") && !askedTexts[0]!.includes("模型与语音"), askedTexts.map((t) => t.slice(0, 400)));
  check("R4 连好后未连接卡变成「已连上」，不再写还没连接", after.text.includes("已连上") && !after.text.includes("还没有连接模型") && !after.cards.some((c) => /已用 .+ 重新发送/.test(c)), after.cards);
  check("连模型期间打的草稿原样留着", after.input === "草稿别动", after.input);
  await rp.cdp.send("Target.closeTarget", { targetId: config.settingsTargetId }).catch(() => {});

  // 5. 新会话：起点引导照常。
  await rp.evaluate(panel, `(() => { const i = document.querySelector("#input"); i.value = ""; i.dispatchEvent(new Event("input")); return true; })()`);
  await rp.click(panel, "#conversation-new");
  const fresh = await until(async () => { const v = await view(panel); return v.starterShown && v.users.length === 0 ? v : undefined; }, 20_000, "新会话起点引导").catch(() => null);
  await rp.screenshot(panel, join(out, "05-new-conversation-connected.png"));
  check("R2 已连模型：起点引导照常，没有连模型入口", !!fresh && fresh.title === "说说你想完成什么" && !fresh.connectShown && fresh.suggestionsShown, fresh && { title: fresh.title, connect: fresh.connectShown, suggestions: fresh.suggestionsShown });

  await rp.click(panel, "#input");
  await rp.typeText(panel, "再问一句");
  await rp.pressEnter(panel);
  const running = await until(async () => { const v = await view(panel); return v.sendStopping ? v : undefined; }, 15_000, "运行中").catch(() => null);
  check("P1 运行中：发送键是停止键，不是禁用样子", !!running && running.sendAriaDisabled === null && running.input === "", running && { aria: running.sendAriaDisabled, stopping: running.sendStopping });

  // 6. 圈出来问的按键写法。
  const localKey = await rp.evaluate(panel, 'document.querySelector("#region-key").textContent');
  check("P3 本机按键写法", localKey === (process.platform === "darwin" ? "⌘⇧S" : "Ctrl+Shift+S"), localKey);
  const ua = String(await rp.evaluate(panel, "navigator.userAgent"));
  await rp.cdp.send("Emulation.setUserAgentOverride", { userAgent: ua.replace(/\(Macintosh;[^)]*\)/, "(X11; Linux x86_64)"), platform: "Linux x86_64" }, panel);
  await rp.cdp.send("Page.reload", {}, panel);
  const linuxKey = await until(async () => { const k = await rp.evaluate(panel, 'navigator.platform + "|" + (document.querySelector("#region-key")?.textContent ?? "")'); return String(k).startsWith("Linux") && String(k).split("|")[1] ? String(k) : undefined; }, 10_000, "模拟 Linux 后的按键").catch((e) => String(e));
  check("P3 Linux 写 Ctrl+Shift+S", linuxKey === "Linux x86_64|Ctrl+Shift+S", linuxKey);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error || results.some(([, pass]) => !pass) ? "FAIL" : "PASS", results, requests: model.requests, askedTexts, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

for (const [name, pass, detail] of results) console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` ${JSON.stringify(detail)}`}`);

if (error) console.log(`ERROR ${error}`);
console.log(`证据：${out}`);

if (error || results.some(([, pass]) => !pass)) process.exitCode = 1;
