import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
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

const TITLES: Record<string, string> = { "/a": "订单确认邮件", "/b": "入住须知邮件", "/c": "退房提醒短信" };

const site = createServer((q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>${TITLES[q.url ?? ""] ?? "空页"}</title><article><p>${body}</p></article><div style="height:3000px"></div>`));

await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const offer = (path: string, sentence: string, prompt: string) => ({ offer: true, actionLabel: "申请", sentence, party: "全季酒店 北京国贸店", evidence: [{ text: "退房时间 12:00", url: origin + path }], prompt });

const DONE = "正在给全季酒店前台发邮件申请明天晚退房到 14:00。\n\n你明天 10:40 的会在国贸三期，走路 8 分钟，退房不用赶。\n\n他们不同意我会再争取一次，结果出来告诉你。";

const REFUSED = "酒店没同意晚退房，最晚 12:00。\n\n前台说明天满房，延到 15:00 排不开。\n\n要我找附近能寄存行李的地方吗？";

const model = await startScriptedModel([
  { match: `"lastReply":"正在给全季`, steps: [{ text: JSON.stringify({ status: "done" }) }] },
  { match: `"lastReply":"酒店没同意`, steps: [{ text: JSON.stringify({ status: "done" }) }] },
  { match: "申请明天晚退房到 14:00", steps: [{ tool: { name: "tabs", args: { action: "open", url: `${origin}/sent` } } }, { text: DONE, delayMs: 2_500 }] },
  { match: "申请延迟到 15:00", steps: [{ tool: { name: "tabs", args: { action: "close", tabId: 987654 } } }, { text: REFUSED, delayMs: 1_500 }] },
  { match: "退房提醒短信", steps: [{ text: JSON.stringify(offer("/c", "延迟退房到 15:00", "给全季酒店北京国贸店前台发邮件，申请延迟到 15:00 退房。")) }] },
  { match: "入住须知邮件", steps: [{ text: JSON.stringify(offer("/b", "晚退房到 14:00", "给全季酒店北京国贸店前台发邮件，申请明天晚退房到 14:00。")) }] },
  { match: "订单确认邮件", steps: [{ text: JSON.stringify(offer("/a", "晚退房到 14:00", "只是看看，不该发出。")) }] },
]);

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

const TURN = `(() => {
  const turns = [...document.querySelectorAll("#messages .msg.user.card-turn")];
  const header = document.querySelector("#conversation-switcher")?.textContent?.trim();
  const turn = turns.at(-1);
  const after = [];
  for (let n = turn?.nextElementSibling; n && !n.matches(".msg.user"); n = n.nextElementSibling) if (!n.matches(".ai-task-card")) after.push(n.matches("details.run-steps") ? "steps" : n.matches(".msg.assistant") ? "answer" : n.className);
  const run = turn && [...document.querySelectorAll("#messages details.run-steps")].filter(r => turn.compareDocumentPosition(r) & 4).at(0);
  const chips = run ? [...run.querySelectorAll(".chip:not(.prep):not(.note)")] : [];
  return {
    header, turns: turns.length, bubbles: document.querySelectorAll("#messages .msg.user:not(.card-turn)").length, live: !!document.querySelector("#messages .pc"),
    verb: turn?.querySelector(".pc-verb.done")?.textContent, obj: turn?.querySelector(".pc-obj")?.textContent,
    after, runDone: !!run?.classList.contains("done"), title: run?.querySelector("summary")?.textContent?.trim(),
    chips: chips.map(c => ({ label: c.querySelector(".chip-label")?.textContent, error: c.classList.contains("error"), dur: c.querySelector(".dur")?.textContent })),
    answer: [...document.querySelectorAll("#messages .msg.assistant")].at(-1)?.textContent ?? "",
    running: document.querySelector("#send-btn")?.classList.contains("stopping"),
  };
})()`;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { sideagent_nudge: true, inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, "document.querySelector('#app')?.classList.contains('starter-ready')") || undefined, 60_000, "侧栏草稿恢复完");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 2, mobile: false }, panel);
  const stopRecording = await recordScreen(rp.cdp, panel, join(out, "panel.mp4"));

  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  const read = async (path: string) => {
    await rp.evaluate(panel, "chrome.storage.session.get('nudgeState').then(r => chrome.storage.session.set({ nudgeState: { ...r.nudgeState, lastShownAt: 0 } })).then(() => true)");
    await rp.cdp.send("Page.navigate", { url: origin + path }, work);
    await rp.cdp.send("Page.bringToFront", {}, work);
    await sleep(2000);
    await rp.evaluate(work, "window.scrollBy(0, 400), true");
  };
  await read("/a");

  const card = await until(async () => await rp.evaluate(panel, CARD), 60_000, "侧栏出卡", 500).catch(() => null);
  const corner = await rp.evaluate(work, "!!document.querySelector('[data-sideagent-overlay=\"nudge\"]')");
  check("R1 卡出在侧栏：动词「申请」是按钮，句子带对象和图标，出处一行，页角没卡", !!card && card.verb === "申请" && String(card.obj).includes("晚退房到 14:00") && String(card.obj).includes("全季酒店 北京国贸店") && card.icon && String(card.src).startsWith("来自：订单确认邮件 · ") && card.lastInThread && corner === false, { card, corner });
  await rp.screenshot(panel, join(out, "1-initial.png"));

  const box = await rp.evaluate(panel, "(() => { const r = document.querySelector('#messages .pc').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 8 }; })()");
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, panel);
  await sleep(300);
  const hovered = await rp.evaluate(panel, CARD);
  check("R3 悬停出 ×", hovered?.xOpacity === "1", hovered);
  await rp.screenshot(panel, join(out, "2-hover.png"));

  await rp.click(panel, "#messages .pc-obj");
  await sleep(800);
  const asked = await rp.evaluate(panel, STATE);
  check("R3 点句子：输入框出现「关于「申请晚退房到 14:00」：」，没有发出，卡还在", asked.input === "关于「申请晚退房到 14:00」：" && asked.users === 0 && asked.focused === "input" && !!(await rp.evaluate(panel, CARD)), asked);
  await rp.screenshot(panel, join(out, "3-ask.png"));

  await rp.click(panel, "#messages .pc-x");
  const gone = await until(async () => (await rp.evaluate(panel, "!document.querySelector('#messages .pc')")) || undefined, 3_000, "卡收起").catch(() => false);
  const stored = await rp.evaluate(panel, "chrome.storage.session.get('sideagent_nudge_panel').then(r => r.sideagent_nudge_panel ?? null)");
  check("R3 点 × 收起，存储里的卡也删了，没有发出", gone === true && stored === null && (await rp.evaluate(panel, STATE)).users === 0, { gone, stored });
  await rp.screenshot(panel, join(out, "4-dismissed.png"));

  await read("/b");
  await until(async () => await rp.evaluate(panel, CARD), 60_000, "第二张卡", 500);
  await rp.click(panel, "#input");
  await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, "document.querySelectorAll('#messages .msg.assistant').length > 0 && !document.querySelector('#send-btn').classList.contains('stopping')")) || undefined, 20_000, "先聊一句");
  const order = await rp.evaluate(panel, "[...document.querySelectorAll('#messages > *')].map(n => n.matches('.pc') ? 'card' : n.matches('.msg.user') ? 'user' : n.matches('.msg.assistant') ? 'answer' : '').filter(Boolean).join(',')");
  await sleep(600);
  await rp.click(panel, "#messages .pc .pc-verb");
  await sleep(60);
  const shell = await rp.evaluate(panel, "({ fading: !!document.querySelector('#messages .pc.fading'), turn: !!document.querySelector('#messages .card-turn') })");
  const running = await until(async () => { const t = await rp.evaluate(panel, TURN); return t.turns === 1 && t.chips.length > 0 ? t : undefined; }, 10_000, "这一轮开始").catch(() => null);
  await rp.screenshot(panel, join(out, "5-running.png"));
  const last = await rp.evaluate(panel, "[...document.querySelectorAll('#messages .msg.user')].at(-1)?.classList.contains('card-turn')");
  check("R2 按下不再问：卡淡成壳，变成这一轮开头排在最后（中间聊过一句），步骤 chip 接在下面", order === "card,user,answer" && (shell.fading || shell.turn) && !!running && running.bubbles === 1 && !running.live && last === true && running.verb === "申请" && String(running.obj).includes("晚退房到 14:00") && running.after[0] === "steps", { order, shell, running, last });
  const done = await until(async () => { const t = await rp.evaluate(panel, TURN); return t.runDone && !t.running && t.answer.includes("告诉你") ? t : undefined; }, 30_000, "这一轮做完").catch(() => null);
  await sleep(1500);
  await rp.screenshot(panel, join(out, "6-done.png"));
  check("R2 做完：步骤留着且完成，三句话接在步骤下面", !!done && done.after.slice(0, 2).join(",") === "steps,answer" && done.chips.every(c => !c.error) && done.answer.includes("国贸三期") && done.bubbles === 1, done);

  await read("/c");
  await until(async () => await rp.evaluate(panel, CARD), 60_000, "第三张卡", 500);
  await sleep(600);
  await rp.click(panel, "#messages .pc .pc-verb");
  const failed = await until(async () => { const t = await rp.evaluate(panel, TURN); return t.turns === 2 && t.runDone && !t.running && t.answer.includes("寄存") ? t : undefined; }, 30_000, "第三轮做完").catch(() => null);
  await sleep(1500);
  await rp.screenshot(panel, join(out, "7-refused.png"));
  check("R4 没成：同一位置说清原因和下一步，失败的步骤标成失败", !!failed && failed.after.slice(0, 2).join(",") === "steps,answer" && failed.chips.some(c => c.error) && failed.answer.startsWith("酒店没同意"), failed);
  console.log("video", await stopRecording());

  await rp.cdp.send("Page.reload", {}, panel);
  const replayed = await until(async () => { const t = await rp.evaluate(panel, TURN); return t.turns === 2 ? t : undefined; }, 20_000, "回放").catch(() => null);
  check("重开侧栏：两轮仍是卡，没有长指令气泡", !!replayed && replayed.bubbles === 1 && replayed.verb === "申请", replayed);
  await rp.screenshot(panel, join(out, "8-replayed.png"));

  await rm(join(out, "downloads"), { recursive: true, force: true });
  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "downloads"));
  const verdicts = traces.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(line => line.type === "nudge_verdict").map(line => line.data);
  check("诊断记录：三页各一行判断，写明出的卡", verdicts.length === 3 && verdicts.every(v => v.verdict === "offer" && v.actionLabel === "申请" && String(v.url).startsWith(origin)), verdicts);
} finally {
  console.log(failures.length ? `FAILED ${failures.length}` : "ALL PASS");

  if (failures.length) process.exitCode = 1;
  await rp.close().catch(() => undefined);
  await model.close();
  site.closeAllConnections();
  site.close();
}
