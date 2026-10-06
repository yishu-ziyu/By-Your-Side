/**
 * #53「继续上次的事」设计核对探针（只核对，不改产品）。
 *
 *   npx tsx scripts/probes/design-check/53/open-threads.mts --headless=new
 *
 * 只装扩展的隔离无头 Chrome（harness.launchRealPath，构建到临时目录，不碰 extension/dist）、真侧栏、
 * 真模型 openai-codex/gpt-6-luna（借 Pi 里的 ChatGPT 登录令牌，剩余不足 3 小时就停，不刷新令牌）。
 *
 * 数据来源：
 * - 两条真实的过往任务：在本机表单页上真发任务，看到页面被填了一个字段后点「停止」（任务记为停下、做过写操作）。
 * - 两条阅读记录：按产品自己的存储格式写进 chrome.storage.session（退路，用来覆盖「打开上次页面」和 3 张上限）。
 *
 * 产物：out/design-check/53/ 下截图与 result.json。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, siteAddress, sleep, until, watchInproc, type Json } from "../../../acceptance/real-path/harness.mts";
import { loadModelPlan, modelStorageItems } from "../../../acceptance/real-path/inproc-config.mts";

if (!process.argv.some((a) => a === "--headless" || a === "--headless=new")) {
  console.error("这个探针只在无窗口模式下运行，请加 --headless=new。");
  process.exit(2);
}

const OUT = join(REPO, "out/design-check/53");

await mkdir(OUT, { recursive: true });

// ── 本机网站：两张多页表单（给真任务填）、两篇文章（给阅读记录） ──

const FORM = (title: string, fields: string[]) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body>
<h1>${title}</h1><p>共 3 页，这是第 1 页。填完点「下一页」。</p>
<form onsubmit="return false">${fields.map((f, i) => `<p><label>${f} <input name="f${i}" aria-label="${f}"></label></p>`).join("")}
<button type="button" onclick="location.search='?p=2'">下一页</button></form></body></html>`;

const site = createServer((req, res) => {
  const host = String(req.headers.host ?? "").split(":")[0]!;

  const html = host === "signup.test" ? FORM("读书会报名表", ["姓名", "邮箱", "电话", "城市", "感兴趣的书", "备注"])
    : host === "trip.test" ? FORM("周末行程登记", ["出发日期", "返回日期", "出发城市", "目的地", "人数", "预算"])
      : `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${host} 的文章</title></head><body><h1>${host} 的文章</h1><p>这是一篇关于城市骑行的长文。第一段讲路线，第二段讲装备。</p></body></html>`;

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const port = siteAddress(site).port;

const HOSTS = ["signup.test", "trip.test", "read-a.test", "read-b.test"];

const plan = await loadModelPlan("openai-codex/gpt-6-luna"); // 令牌剩余 < 3 小时会在这里抛错，不刷新。

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(", ")}`, "--no-proxy-server"] });

type Item = { id: string; item: string; status: "pass" | "fail" | "not-run"; evidence: Json };

const items: Item[] = [];

const notes: Record<string, Json> = {};

const record = (id: string, item: string, pass: boolean | null, evidence: Json) => {
  items.push({ id, item, status: pass === null ? "not-run" : pass ? "pass" : "fail", evidence });
  console.log(`${pass === null ? "NOT-RUN" : pass ? "PASS" : "FAIL"} [${id}] ${item} ${JSON.stringify(evidence).slice(0, 400)}`);
};

let panel = "", work = "", workTargetId = "", ext = "";

let fatal: string | null = null;

let inproc: Awaited<ReturnType<typeof watchInproc>> | null = null;

const modelRequests = () => (inproc?.requestsBetween(0) ?? []).filter((r) => /chatgpt\.com|openai\.com/.test(r.url) && r.method === "POST").length;

const PANEL = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    stopping: q("#send-btn")?.classList.contains("stopping") ?? false,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: document.querySelectorAll("#messages .msg.user").length,
  };
})()`;

type PanelState = { connected: boolean; ready: boolean; stopping: boolean; busy: boolean; userMessages: number };

// SAFETY: PANEL 返回的字段与 PanelState 一一对应。
const readPanel = async () => (await rp.evaluate(panel, PANEL)) as PanelState;

type CardView = { id: string; title: string; where: string; primary: string[]; close: number; buttons: number; rect: { w: number; h: number } };

type ThreadsView = { visible: boolean; head: string; cards: CardView[]; starterVisible: boolean };

// SAFETY: 页面脚本返回的字段与 ThreadsView 一一对应。
const readThreads = async (): Promise<ThreadsView> => (await rp.evaluate(panel, `(() => {
  const box = document.querySelector("#open-threads");
  const starter = document.querySelector("#starter");
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
  return {
    visible: shown(box) && shown(starter),
    starterVisible: shown(starter),
    head: box?.querySelector(".open-threads-head")?.textContent ?? "",
    cards: [...(box?.querySelectorAll(".open-thread") ?? [])].map((c) => ({
      id: c.dataset.threadId, title: c.querySelector(".open-thread-title")?.textContent ?? "", where: c.querySelector(".open-thread-where")?.textContent ?? "",
      primary: [...c.querySelectorAll(".open-thread-go")].map((b) => b.textContent), close: c.querySelectorAll(".open-thread-close").length,
      buttons: c.querySelectorAll("button").length, rect: { w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) },
    })),
  };
})()`)) as ThreadsView;

const shot = async (name: string) => {
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(400);
  await rp.screenshot(panel, join(OUT, `${name}.png`));
};

const clickMarked = async (session: string, js: string) => {
  const ok = await rp.evaluate(session, `(() => { const el = (${js}); if (!el) return false; el.setAttribute("data-probe-click", "1"); el.scrollIntoView({ block: "center" }); return true; })()`);

  if (!ok) throw new Error(`找不到要点的元素：${js}`);
  await rp.click(session, "[data-probe-click]");
  await rp.evaluate(session, `document.querySelector("[data-probe-click]")?.removeAttribute("data-probe-click"); true`);
};

async function navigate(url: string) {
  await rp.cdp.send("Page.navigate", { url }, work);
  await until(async () => (await rp.evaluate(work, `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, `打开 ${url}`);
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await sleep(800);
}

async function newConversation() {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`)) || undefined, 15_000, "新会话");
  await sleep(1500);
}

const formValues = async () => String(await rp.evaluate(work, `JSON.stringify([...document.querySelectorAll("input")].map((i) => i.value))`));

/** 真发一个任务；看到页面上有字段被填（做过写操作）就点停止。返回停下时的读数。 */
async function runAndStop(url: string, ask: string) {
  await navigate(url);
  const before = await readPanel();
  await rp.click(panel, "#input");
  await rp.typeText(panel, ask);
  await rp.pressEnter(panel);
  await until(async () => (await readPanel()).userMessages > before.userMessages || undefined, 10_000, "消息发出");
  const started = Date.now();
  let wrote = false;

  while (Date.now() - started < 150_000) {
    wrote = await rp.evaluate(work, `[...document.querySelectorAll("input")].some((i) => i.value)`).catch(() => false) === true;
    const s = await readPanel();

    if (wrote || (!s.busy && Date.now() - started > 5000)) break;
    await sleep(400);
  }

  const s = await readPanel();
  let stopped = false;

  if (s.stopping) {
    await rp.click(panel, "#send-btn");
    stopped = true;
  }

  await until(async () => !(await readPanel()).busy || undefined, 60_000, "任务停下");
  await sleep(3000);

  return { wrote, stopped, values: await formValues(), seconds: Math.round((Date.now() - started) / 1000) };
}

// ── 扩展自己的存储：读过往任务（只读），写阅读记录（退路） ──

const storedTasks = async () => {
  const text = await rp.evaluate(ext, `(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === "sideagent-memory")) return null;
    const db = await new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (!db.objectStoreNames.contains("kv")) { db.close(); return null; }
    const v = await new Promise((res, rej) => { const r = db.transaction("kv").objectStore("kv").get("tasks"); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); });
    db.close(); return v;
  })()`);

  // SAFETY: 这个键里只有产品写入的 { format, tasks } JSON 文本。
  return text ? ((JSON.parse(String(text)) as { tasks?: Array<{ id: string; conversationId: string; goal: string; outcome: string; unfinished: string[] }> }).tasks ?? []) : [];
};

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  workTargetId = blank.targetId;
  work = await rp.attach(blank.targetId);
  ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html`, background: true })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
  await navigate("http://signup.test/");
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  inproc = await watchInproc(rp, rp.extensionId);
  await until(async () => { const s = await readPanel();

    return s.connected && s.ready ? s : undefined; }, 90_000, "侧栏就绪", 500);

  const defaultSetting = await rp.evaluate(ext, `chrome.storage.local.get("sideagent_open_threads").then((v) => v.sideagent_open_threads ?? null)`);
  notes.defaultStoredSetting = defaultSetting;

  // ── 1. 两条真实的、做到一半被停下的任务 ──
  await newConversation();
  const t1 = await runAndStop("http://signup.test/", "帮我把这页读书会报名表 3 页都填完：姓名 测试员甲，邮箱 tester@example.test，电话 13800000000，城市 上海，感兴趣的书 三体，备注 无。直接填，不用问我，最后不要提交。");
  await newConversation();
  const t2 = await runAndStop("http://trip.test/", "帮我把这页周末行程登记 3 页都填完：出发日期 2026-10-10，返回日期 2026-10-12，出发城市 上海，目的地 杭州，人数 2，预算 3000。直接填，不用问我，最后不要提交。");

  const tasks = await until(async () => { const t = await storedTasks();

    return t.length >= 1 ? t : undefined; }, 20_000, "过往任务写入").catch((): Awaited<ReturnType<typeof storedTasks>> => []);

  notes.realTasks = { t1, t2, stored: tasks.map((t) => ({ goal: t.goal.slice(0, 40), outcome: t.outcome, unfinished: t.unfinished })) };
  notes.modelRequestsAfterTasks = modelRequests();
  console.log("real tasks", JSON.stringify(notes.realTasks));

  // ── 2. 退路：两条没答完的阅读记录，对应两个开着的标签页 ──
  const openTab = async (url: string) => {
    const { targetId } = await rp.cdp.send("Target.createTarget", { url, background: true });
    const s = await rp.attach(targetId);
    await until(async () => (await rp.evaluate(s, `document.readyState === "complete"`).catch(() => false)) || undefined, 10_000, url);

    return { targetId, session: s };
  };

  // 设置页先开好：后台在任何标签页开始加载时会用它内存里的阅读记录覆盖存储（reading.ts dropTab），
  // 写入阅读记录之后不能再有标签页加载，否则种子会被清掉。
  const { targetId: settingsTarget } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` });
  const settings = await rp.attach(settingsTarget);
  await until(async () => (await rp.evaluate(settings, `!!document.querySelector("#open-threads")`)) || undefined, 15_000, "设置页");
  const readA = await openTab("http://read-a.test/article");
  await openTab("http://read-b.test/article");
  const now = Date.now();

  const seeded = await rp.evaluate(ext, `(async () => {
    const tabs = await chrome.tabs.query({});
    const tabOf = (u) => tabs.find((t) => t.url === u);
    const mk = (u, q, state, at, n) => { const t = tabOf(u); return { threadId: "probe-read-" + n, documentKey: "url:" + u, source: { title: (u.includes("read-a") ? "read-a.test" : "read-b.test") + " 的文章", url: u, text: "这是一篇关于城市骑行的长文。", tabId: t.id }, turns: [{ question: q, state, answer: "" }], updatedAt: at }; };
    const records = [mk("http://read-a.test/article", "第二段说的装备清单里哪几样最贵？", "error", ${now}, 1), mk("http://read-b.test/article", "这条路线适合新手吗？", "stopped", ${now - 10 * 86_400_000}, 2)];
    await chrome.storage.session.set({ readingRecords: records });
    return records.map((r) => ({ tabId: r.source.tabId, url: r.source.url, tabTitleAtSeed: tabOf(r.source.url).title ?? null }));
  })()`);

  notes.seededReadings = seeded;
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });

  await sleep(1000);
  notes.panelSeesReadings = await rp.evaluate(panel, `chrome.storage.session.get("readingRecords").then(async (v) => Promise.all((v.readingRecords ?? []).map(async (r) => { try { const t = await chrome.tabs.get(r.source.tabId); return { want: r.source.url, tabUrl: t.url, title: r.source.title }; } catch (e) { return { want: r.source.url, error: e.message }; } })))`);
  console.log("panel sees readings", JSON.stringify(notes.panelSeesReadings));
  // ── 3. 默认关：新会话没有卡 ──
  await newConversation();
  await sleep(2500);
  const off = await readThreads();
  record("A1", "默认关闭：新会话无旅程卡", defaultSetting === null && !off.visible && off.cards.length === 0, { storedSetting: defaultSetting, starterVisible: off.starterVisible, boxVisible: off.visible, cards: off.cards.length });
  await shot("01-default-off-new-conversation");

  // ── 4. 设置页里打开 ──
  await sleep(800);

  const settingView = await rp.evaluate(settings, `(() => { const box = document.querySelector("#open-threads").closest("section"); box.scrollIntoView({ block: "center" });
    const all = [...document.querySelectorAll("section.settings-card h2")].map((h) => h.textContent);
    return { checked: document.querySelector("#open-threads").checked, heading: box.querySelector("h2").textContent, label: box.querySelector("label").innerText, sub: box.querySelector(".settings-sub").textContent, sectionIndex: all.indexOf(box.querySelector("h2").textContent), sectionCount: all.length, sections: all }; })()`);

  notes.setting = settingView;
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 2, mobile: false }, settings);
  await rp.evaluate(settings, `document.querySelector("#open-threads").closest("section").scrollIntoView({ block: "center" }); true`);
  await sleep(400);
  await rp.screenshot(settings, join(OUT, "02-setting-location.png"));
  await rp.click(settings, "#open-threads");
  await sleep(1000);
  const afterToggle = await rp.evaluate(settings, `({ checked: document.querySelector("#open-threads").checked, status: document.querySelector("#open-threads-status").textContent })`);
  const storedOn = await rp.evaluate(ext, `chrome.storage.local.get("sideagent_open_threads").then((v) => v.sideagent_open_threads ?? null)`);
  notes.toggleOn = { afterToggle: afterToggle, storedOn: storedOn };

  // ── 5. 开启后：≤3 张卡，每张一个主按钮 ──
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });

  const on = await until(async () => { const v = await readThreads();

    return v.cards.length ? v : undefined; }, 20_000, "卡片出现").catch(async () => readThreads());

  await sleep(1500);
  const onView = await readThreads();
  notes.readingsAtA2 = await rp.evaluate(panel, `chrome.storage.session.get("readingRecords").then((v) => (v.readingRecords ?? []).map((r) => ({ threadId: r.threadId, tabId: r.source?.tabId, url: r.source?.url, title: r.source?.title, textType: typeof r.source?.text, turns: r.turns, updatedAt: r.updatedAt, transferred: r.transferredConversationId ?? null })))`);
  console.log("readings at A2", JSON.stringify(notes.readingsAtA2));
  const candidates = tasks.length + 2;
  record("A2", "开启且有可续记录：出现 ≤3 张卡，各有且仅有一个主操作按钮", storedOn === true && onView.visible && onView.cards.length >= 1 && onView.cards.length <= 3 && onView.cards.every((c) => c.primary.length === 1),
    { storedOn: storedOn, candidatesAtLeast: candidates, cards: onView.cards.map((c) => ({ id: c.id, title: c.title, where: c.where, primary: c.primary, close: c.close, size: `${c.rect.w}x${c.rect.h}` })), head: onView.head, firstSeenCount: on.cards.length });
  record("A2b", "候选多于 3 条时只出 3 张（2 真任务 + 2 阅读记录）", onView.cards.length === Math.min(3, candidates) && candidates > 3 ? true : candidates > 3 ? false : null, { candidates, shown: onView.cards.length });
  await shot("03-cards-in-empty-conversation");

  // ── 6. 点按钮：打开上次页面（阅读记录卡）──
  const readCard = onView.cards.find((c) => c.id.startsWith("read:"));
  const readDomBefore = String(await rp.evaluate(readA.session, `document.body.innerHTML`));
  const reqBefore = modelRequests();

  if (readCard) {
    await clickMarked(panel, `document.querySelector('.open-thread[data-thread-id="${readCard.id}"] .open-thread-go')`);
    await sleep(2000);
    const active = await rp.evaluate(ext, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t ? { url: t.url, id: t.id } : null)`);
    const readDomAfter = String(await rp.evaluate(readA.session, `document.body.innerHTML`));
    const reqAfter = modelRequests();
    const panelAfter = await readPanel();
    record("A3a", "「打开上次页面」切到记录里的标签页，不写页面、不发模型请求、不发消息", active?.url === "http://read-a.test/article" && readDomBefore === readDomAfter && reqAfter === reqBefore && panelAfter.userMessages === 0,
      { button: readCard.primary[0] ?? null, activeTab: active, pageUnchanged: readDomBefore === readDomAfter, modelRequestsDelta: reqAfter - reqBefore, userMessages: panelAfter.userMessages });
    await rp.screenshot(readA.session, join(OUT, "04a-after-open-last-page-tab.png")).catch(() => undefined);
    await shot("04a-after-open-last-page-panel");
    await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  } else record("A3a", "「打开上次页面」按钮", null, "没有出现阅读记录卡");

  // ── 7. 点按钮：回到这个任务 ──
  const taskCard = (await readThreads()).cards.find((c) => !c.id.startsWith("read:"));

  if (taskCard) {
    const valuesBefore = await formValues();
    const req0 = modelRequests();
    await clickMarked(panel, `document.querySelector('.open-thread[data-thread-id="${taskCard.id}"] .open-thread-go')`);
    await sleep(6000);

    const after = await rp.evaluate(panel, `(() => ({
      userTexts: [...document.querySelectorAll("#messages .msg.user")].map((m) => m.innerText.slice(0, 60)),
      resume: document.querySelector("#resume-entry-root")?.innerText ?? "",
      resumeButtons: [...document.querySelectorAll("#resume-entry-root button")].map((b) => b.textContent),
      busy: !!document.querySelector("#send-btn.stopping"),
    }))()`);

    const valuesAfter = await formValues();
    const delta = modelRequests() - req0;
    // SAFETY: 上面的页面脚本返回这几个字段。
    const a = after as { userTexts: string[]; resume: string; resumeButtons: string[]; busy: boolean };
    record("A3b", "「回到这个任务」切回原会话，不自动续跑、不写页面、不发模型请求", a.userTexts.length > 0 && !a.busy && delta === 0 && valuesBefore === valuesAfter,
      { card: { title: taskCard.title, where: taskCard.where, button: taskCard.primary[0] ?? null }, shownUserMessages: a.userTexts, resumeEntry: a.resume.slice(0, 200), resumeButtons: a.resumeButtons, modelRequestsDelta: delta, formUnchanged: valuesBefore === valuesAfter });
    await shot("04b-after-back-to-task");
  } else record("A3b", "「回到这个任务」按钮", null, "没有出现任务卡");

  // ── 8. × 一张卡 ──
  await newConversation();

  const beforeX = await until(async () => { const v = await readThreads();

    return v.cards.length ? v : undefined; }, 20_000, "回到新会话后卡片出现").catch(async () => readThreads());

  const target = beforeX.cards[0];

  if (target) {
    await clickMarked(panel, `document.querySelector('.open-thread[data-thread-id="${target.id}"] .open-thread-close')`);
    await sleep(1500);
    const afterX = await readThreads();
    const hidden = await rp.evaluate(ext, `chrome.storage.local.get("sideagent_open_threads_hidden").then((v) => v.sideagent_open_threads_hidden ?? null)`);
    const until7d = hidden?.[target.id];
    await shot("05-after-x");
    await newConversation();
    const again = await readThreads();
    record("A4a", "点 × 后这张卡消失，换个新会话也不回来（7 天内隐藏）", !afterX.cards.some((c) => c.id === target.id) && !again.cards.some((c) => c.id === target.id) && Number.isFinite(until7d),
      { closed: target.title, before: beforeX.cards.map((c) => c.title), afterX: afterX.cards.map((c) => c.title), afterNewConversation: again.cards.map((c) => c.title), hiddenDays: Number.isFinite(until7d) ? Math.round((until7d - Date.now()) / 86_400_000 * 10) / 10 : null });
  } else record("A4a", "点 × 后卡片消失", null, "没有卡片可点");

  // ── 9. 关掉设置 ──
  await rp.cdp.send("Target.activateTarget", { targetId: settingsTarget });
  await rp.click(settings, "#open-threads");
  await sleep(1500);
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await sleep(1000);
  const offAgain = await readThreads();
  const storedOff = await rp.evaluate(ext, `chrome.storage.local.get("sideagent_open_threads").then((v) => v.sideagent_open_threads ?? null)`);
  record("A4b", "关闭设置后卡片立即全部消失", storedOff === false && !offAgain.visible && offAgain.cards.length === 0, { storedOff: storedOff, boxVisible: offAgain.visible, cards: offAgain.cards.length });
  await shot("06-after-setting-off");
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(fatal);
  await shot("fatal").catch(() => undefined);
} finally {
  notes.modelRequestsTotal = modelRequests();
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  site.closeAllConnections();
  site.close();
}

await writeFile(join(OUT, "result.json"), JSON.stringify({
  case: "design-check #53 open-threads", finishedAt: new Date().toISOString(), model: "openai-codex/gpt-6-luna",
  dataSource: { pastTasks: "两条真实任务（真模型，填到一半点停止）", readings: "两条阅读记录写进 chrome.storage.session（退路）" },
  items, notes, fatal,
}, null, 2));

console.log(`done → ${join(OUT, "result.json")}`);

process.exit(fatal ? 1 : 0);
