/**
 * #49 回答出处 设计核对探针（只核对，不改产品）。
 *
 *   npx tsx scripts/probes/design-check/49/answer-sources.mts --headless [--inject-sources]
 *
 * --ports：每页一个 127.0.0.1 端口（见下方 PORTS_MODE 注释）；默认用 .test 主机名，标签更像真实网站。
 * --skip-plain：跳过第 3 轮（不读网页的问题）。
 * --inject-sources：真实回答没有出处时，把同一条交付补上 sources（= 服务器日志里本轮真的打开过的页）再送进侧栏一次，
 * 用来看出处 UI 和点击后的下游行为。这一段结果记为 S*，不算真实路径验收（A*）。
 *
 * 只装扩展的隔离无头 Chrome、真侧栏、真模型 openai-codex/gpt-6-luna（Pi 登录令牌，剩余不足 3 小时就停，不刷新）。
 * 本机四个页面（hub.test 列表页 + 三个评测页，各在自己的主机名下），服务器日志作为「真的打开过哪些页」的独立证据。
 * 三轮模型调用：调研问答、带 chip 追问、不需要网页的问题（核对「无出处不画」）。
 * 产物：out/design-check/49/ 下截图与 result.json。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "../../../acceptance/real-path/harness.mts";
import { loadModelPlan, modelStorageItems } from "../../../acceptance/real-path/inproc-config.mts";

requireHeadless();

const out = join(REPO, "out/design-check/49", process.argv.includes("--ports") ? "ports" : "");

await mkdir(out, { recursive: true });

// 令牌剩余不足 3 小时 loadModelPlan 会抛错，此时什么都不启动。
const plan = await loadModelPlan("openai-codex/gpt-6-luna");

// ── 本机页面：每页数字只出现一次，便于原页定位段落 ──

const REVIEWS = {
  "a-review.test": { name: "清扫者 A1", price: "1899 元", battery: "150 分钟", noise: "58 分贝", warranty: "18 个月" },
  "b-review.test": { name: "净界 B7", price: "2499 元", battery: "210 分钟", noise: "63 分贝", warranty: "24 个月" },
  "c-review.test": { name: "微尘 C3", price: "1299 元", battery: "95 分钟", noise: "66 分贝", warranty: "12 个月" },
} as const;

const HOSTS = ["hub.test", ...Object.keys(REVIEWS)];

/**
 * --ports：每页一个 127.0.0.1 端口，不用 host-resolver 映射的 .test 主机名。
 * 小实验 pinpoint-identity.mts 显示：本隔离 Chrome 里扩展内容脚本不注入 host-resolver 映射的 .test 页面，段落定位因此必然失败；
 * 用 127.0.0.1 才能核对「尝试高亮」。代价是出处标签只剩 127.0.0.1:端口。
 */
const PORTS_MODE = process.argv.includes("--ports");

const hits: Array<{ ms: number; host: string; path: string; ua: string }> = [];

const T0 = Date.now();

const aliases = new Map<string, string>();

/** 页面名（hub.test / a-review.test …）→ 浏览器里的 host（带端口时含端口）。 */
const alias = (name: string) => aliases.get(name) ?? name;

/** URL 或 host → 页面名；不认识就原样返回。 */
const nameOf = (urlOrHost: string) => {
  let host = urlOrHost;

  try { host = new URL(urlOrHost).host; } catch { /* 本来就是 host */ }

  return [...aliases].find(([, h]) => h === host)?.[0] ?? host;
};

const page = (host: string): string => {
  if (host === "hub.test") {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>扫地机器人评测合集</title></head><body style="font:16px sans-serif;padding:32px;max-width:720px">
<h1>扫地机器人评测合集</h1><p>本站收录了三款热门扫地机器人的独立评测，点进各自页面查看详细参数。</p>
<ul>${Object.entries(REVIEWS).map(([h, r]) => `<li><a href="http://${alias(h)}/">${r.name} 评测</a></li>`).join("")}</ul></body></html>`;
  }

  // SAFETY: host 已由调用方限定在 REVIEWS 的键里。
  const r = REVIEWS[host as keyof typeof REVIEWS];

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${r.name} 评测</title></head><body style="font:16px/1.7 sans-serif;padding:32px;max-width:720px">
<h1>${r.name} 深度评测</h1>
<p>开箱：${r.name} 外观简洁，配件齐全，安装大约需要五分钟。</p>
<p>价格：本次评测机型的官方售价为 ${r.price}，近期没有降价活动。</p>
<p>续航：满电状态下标准模式实测可以连续清扫 ${r.battery}，足够覆盖三居室。</p>
<p>噪音：标准模式下距离一米测得约 ${r.noise}。</p>
<p>售后：整机保修期为 ${r.warranty}，电池单独计算。</p>
<p>总结：适合预算明确、在意日常维护的家庭。</p></body></html>`;
};

const serve = (fixed: string | null) => createServer((req, res) => {
  const host = fixed ?? String(req.headers.host ?? "").split(":")[0]!;
  hits.push({ ms: Date.now() - T0, host, path: req.url ?? "/", ua: String(req.headers["user-agent"] ?? "").slice(0, 40) });

  if (!HOSTS.includes(host) || req.url !== "/") { res.writeHead(404).end();

    return; }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(host));
});

const servers = PORTS_MODE ? HOSTS.map((h) => ({ name: h, server: serve(h) })) : [{ name: null, server: serve(null) }];

for (const { name, server } of servers) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  if (name) aliases.set(name, `127.0.0.1:${siteAddress(server).port}`);
}

const port = siteAddress(servers[0]!.server).port;

const rp = await launchRealPath({ chromeArgs: PORTS_MODE ? [] : [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(", ")}`, "--no-proxy-server"] });

// ── 结果记录 ──

type Status = "pass" | "fail" | "not-run";

const items: Array<{ id: string; criterion: string; status: Status; evidence: Json }> = [];

const record = (id: string, criterion: string, status: Status, evidence: Json) => {
  items.push({ id, criterion, status, evidence });
  console.log(`${status.toUpperCase()} ${id} ${JSON.stringify(evidence).slice(0, 400)}`);
};

const observations: Record<string, Json> = {};

let fatal: string | null = null;

let panel = "";

const PANEL = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: document.querySelectorAll("#messages .msg.user").length,
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
  };
})()`;

type PanelState = { connected: boolean; busy: boolean; userMessages: number; replies: number };

// SAFETY: PANEL 返回的字段与 PanelState 一一对应。
const read = async () => (await rp.evaluate(panel, PANEL)) as PanelState;

const shot = async (session: string, name: string) => {
  await rp.screenshot(session, join(out, `${name}.png`));

  return join(out, `${name}.png`);
};

/** 发一句话，等这一轮彻底空闲。 */
async function turn(text: string, limitMs = 300_000): Promise<number> {
  const before = await read();
  const started = Date.now();
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(async () => (await read()).userMessages > before.userMessages || undefined, 15_000, "消息发出");
  let idle = 0;

  while (Date.now() - started < limitMs && idle < 16) {
    const s = await read().catch(() => null);
    idle = s && !s.busy && s.replies > before.replies && Date.now() - started > 3000 ? idle + 1 : 0;
    await sleep(250);
  }

  if (idle < 16) throw new Error(`${Math.round(limitMs / 1000)} 秒内这一轮没有结束`);
  await sleep(2000);

  return Date.now() - started;
}

/** 最后一条用户消息之后、带出处或正文的那条回答。 */
const LAST_ANSWER = `(() => {
  const all = [...document.querySelectorAll("#messages > *")];
  const lastUser = all.map((n) => n.matches(".msg.user")).lastIndexOf(true);
  const answers = all.slice(lastUser + 1).filter((n) => n.matches(".msg.assistant") && !n.closest(".run-steps"));
  const answer = answers.find((n) => n.querySelector(".answer-sources")) ?? answers.at(-1);
  if (!answer) return null;
  document.querySelectorAll("[data-probe-answer]").forEach((n) => n.removeAttribute("data-probe-answer"));
  answer.setAttribute("data-probe-answer", String(Date.now()));
  const head = answer.querySelector(".answer-sources");
  return {
    text: answer.innerText,
    summary: head?.querySelector("summary")?.textContent ?? null,
    headIsFirst: head ? answer.firstElementChild === head : null,
    open: head?.open ?? null,
    listed: [...(head?.querySelectorAll("button.answer-source") ?? [])].map((b) => ({ url: b.title, label: b.innerText })),
    links: [...answer.querySelectorAll("a[href]")].map((a) => ({ href: a.href, text: a.textContent, marked: a.nextElementSibling?.classList.contains("source-mark") ?? false })),
    marks: [...answer.querySelectorAll(".source-mark")].map((m) => ({ n: m.textContent, title: m.title })),
    deliveryFacts: !!answer.querySelector(".delivery-facts") || !!answer.parentElement?.querySelector(".delivery-facts"),
    answersAfterUser: answers.length,
  };
})()`;

type AnswerView = { text: string; summary: string | null; headIsFirst: boolean | null; open: boolean | null; listed: Array<{ url: string; label: string }>; links: Array<{ href: string; text: string; marked: boolean }>; marks: Array<{ n: string; title: string }>; deliveryFacts: boolean; answersAfterUser: number } | null;

// SAFETY: LAST_ANSWER 返回 null 或与 AnswerView 一一对应的对象。
const lastAnswer = async () => (await rp.evaluate(panel, LAST_ANSWER)) as AnswerView;

const CHIP = `(() => { const c = document.querySelector("#ask-cite"); return c ? { hidden: c.hidden, visible: !c.hidden && c.getClientRects().length > 0, host: document.querySelector("#ask-cite-host")?.textContent ?? "", text: document.querySelector("#ask-cite-text")?.textContent ?? "", feed: c.classList.contains("feed-token"), hasClose: !!document.querySelector("#ask-cite-close") } : null; })()`;

const activeTab = async () => rp.evaluate(panel, `chrome.windows.getCurrent().then((w) => chrome.tabs.query({ active: true, windowId: w.id })).then(([t]) => t ? { id: t.id, url: t.url, title: t.title } : null)`);

const allTabs = async () => rp.evaluate(panel, `chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url, active: t.active, index: t.index })))`);

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "工作页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://${alias("hub.test")}/` }, work);
  await until(async () => (await rp.evaluate(work, `location.host === ${JSON.stringify(alias("hub.test"))} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, "打开 hub.test");
  panel = await rp.attach(await rp.openSidePanel());
  // 记下侧栏收到的交付消息（只看 kind 与事实链有无 sources，不改行为）：注入后重载侧栏，让它的端口经过记录器。
  await rp.cdp.send("Page.enable", {}, panel);
  await rp.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__deliveries = [];
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (...args) => {
      const port = connect(...args);
      const add = port.onMessage.addListener.bind(port.onMessage);
      port.onMessage.addListener = (fn) => { (window.__panelHandlers ??= []).push(fn); return add(fn); };
      add((msg) => {
        const text = JSON.stringify(msg);
        if (!text.includes('"user_delivery')) return;
        const find = (o) => { if (!o || typeof o !== "object") return null; if (o.kind === "user_delivery" && o.delivery) return { type: "delivery", d: o.delivery }; if (o.kind === "user_delivery_stream" && o.stream) return { type: "stream", d: o.stream }; for (const v of Object.values(o)) { const f = find(v); if (f) return f; } return null; };
        const f = find(msg);
        if (!f) return;
        if (f.type === "delivery") (window.__rawDeliveries ??= []).push(msg);
        window.__deliveries.push({ at: Date.now(), type: f.type, kind: f.d.kind, phase: f.d.phase ?? null, status: f.d.status ?? null, hasFacts: !!f.d.facts, sources: f.d.facts?.sources ?? null, outcome: f.d.facts?.outcome ?? null, text: String(f.d.text ?? "").slice(0, 80) });
      });
      return port;
    };
  })();` }, panel);
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn") !== null && Array.isArray(window.__deliveries)`)) || undefined, 60_000, "侧栏渲染");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await until(async () => (await read()).connected || undefined, 90_000, "侧栏连上 agent", 500);
  await sleep(1500);

  // 侧栏里记下出处点击引发的段落定位请求与回复（只包一层 sendMessage 做记录，不改行为）。
  observations.pinpointWrap = await rp.evaluate(panel, `(() => {
    window.__pinpoint = [];
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    try {
      chrome.runtime.sendMessage = (msg, ...rest) => {
        const p = orig(msg, ...rest);
        if (msg && msg.type === "PINPOINT_DOM_TARGET") {
          const entry = { at: Date.now(), action: msg.action, query: msg.query ?? null, url: msg.url ?? msg.source?.url ?? null };
          window.__pinpoint.push(entry);
          Promise.resolve(p).then((r) => { entry.reply = r ? { ok: r.ok, error: r.error ?? null, sourceText: r.source?.text?.slice(0, 120) ?? null } : null; }, (e) => { entry.reply = { thrown: String(e) }; });
        }
        return p;
      };
      return chrome.runtime.sendMessage !== orig ? "wrapped" : "not-writable";
    } catch (e) { return "wrap-failed: " + e; }
  })()`);

  // ── 第 1 轮：多页调研 ──
  const hitsBefore = hits.length;
  const ask1 = "这页列了三款扫地机器人。请分别点进它们的评测页看看，比较价格和续航，告诉我哪款最值得买，每条结论后附上出处链接。";
  const ms1 = await turn(ask1);
  const run1Hits = hits.slice(hitsBefore).filter((h) => h.path === "/");
  const pagesFetched = [...new Set(run1Hits.map((h) => h.host))];
  const a1 = await lastAnswer();
  observations.run1 = { ms: ms1, serverHits: run1Hits, answer: a1, deliveries: await rp.evaluate(panel, `window.__deliveries`) };

  // 回答默认折叠的样子
  await rp.evaluate(panel, `document.querySelector("[data-probe-answer] .answer-sources")?.scrollIntoView({ block: "start" }); true`);
  await sleep(300);
  const shotCollapsed = await shot(panel, "01-answer-collapsed");
  await rp.evaluate(panel, `(() => { const d = document.querySelector("[data-probe-answer] .answer-sources"); if (d) d.open = true; d?.scrollIntoView({ block: "start" }); return true; })()`);
  await sleep(300);
  const shotOpen = await shot(panel, "02-sources-open");

  const n = Number(a1?.summary?.match(/(\d+)/)?.[1] ?? NaN);
  const listedHosts = (a1?.listed ?? []).map((l) => nameOf(l.url));
  const reviewHostsListed = listedHosts.filter((h) => h in REVIEWS);
  const unread = listedHosts.filter((h) => h !== "hub.test" && !pagesFetched.includes(h));
  // hub.test 在开跑前已经打开，模型读它不一定再请求服务器；它出现在清单里不算「未读」，单列。
  record("A1", "多页调研类回答顶部有「读了 N 个网站」，N 与本 run 实际打开/读过的页一致（抽检）",
    a1?.summary && a1.headIsFirst && Number.isFinite(n) && n === listedHosts.length && unread.length === 0 && reviewHostsListed.length === pagesFetched.filter((h) => h in REVIEWS).length && n >= 2 ? "pass" : "fail",
    { summary: a1?.summary ?? null, headIsFirst: a1?.headIsFirst ?? null, listedHosts, serverFetchedHostsThisRun: pagesFetched, listedButNeverFetched: unread, shots: [shotCollapsed, shotOpen] });

  /** 点出处 → 页面与高亮 → chip（移除再挂回）→ 带 chip 追问。tag 区分真实路径(A)与注入出处(S)。 */
  const clickFlow = async (a1: AnswerView, tag: string, pre: string) => {
  // ── 点出处 ──
  const marks = a1?.marks ?? [];
  const tabsBefore = await allTabs();
  const activeBefore = await activeTab();
  const clickSelector = marks.length ? "[data-probe-answer] .source-mark" : "[data-probe-answer] button.answer-source";
  const clickedTitle = String(await rp.evaluate(panel, `(() => { const el = document.querySelector(${JSON.stringify(clickSelector)}); el?.scrollIntoView({ block: "center" }); return el?.title ?? ""; })()`));
  const expectedUrl = marks.length ? (a1?.links.find((l) => l.marked)?.href ?? "") : clickedTitle;
  const expectedHost = expectedUrl ? nameOf(expectedUrl) : "";
  await sleep(300);
  await rp.evaluate(panel, `window.__pinpoint.length = 0; true`);
  await rp.click(panel, clickSelector);

  // 高亮只保留 1.2 秒：一出现目标页就高频轮询 .bys-sonar-active。
  let highlight: Json = null;
  let pageShot: string | null = null;
  const clickAt = Date.now();
  let pageTarget: string | null = null;

  while (Date.now() - clickAt < 12_000) {
    const target = (await rp.targets()).find((t) => t.type === "page" && expectedHost && t.url.includes(alias(expectedHost)) && !t.url.startsWith("chrome-extension://"));

    if (target) {
      if (!pageTarget) pageTarget = await rp.attach(target.targetId);
      const found = await rp.evaluate(pageTarget, `(() => { const el = document.querySelector(".bys-sonar-active"); return el ? { tag: el.tagName, text: el.textContent.slice(0, 120), scrollY: Math.round(scrollY) } : null; })()`).catch(() => null);

      if (found) { highlight = found; pageShot = await shot(pageTarget, `${pre}03-page-tab-highlight`); break; }
    }

    await sleep(80);
  }

  await sleep(1500);
  const pinpoint = await rp.evaluate(panel, `window.__pinpoint`);
  const activeAfter = await activeTab();
  const tabsAfter = await allTabs();

  if (pageTarget && !pageShot) pageShot = await shot(pageTarget, `${pre}03-page-tab-no-highlight`);
  const toast = await rp.evaluate(panel, `document.querySelector(".source-toast")?.textContent ?? null`);
  const chip1 = await rp.evaluate(panel, CHIP);
  const shotPanelAfter = await shot(panel, `${pre}04-sidepanel-after-click`);
  // SAFETY: activeTab 返回 { url } 或 null。
  const activeUrl = String((activeAfter as { url?: string } | null)?.url ?? "");
  const pinpointList = Array.isArray(pinpoint) ? pinpoint : [];
  // SAFETY: __pinpoint 的条目带 action 字段。
  const attempted = pinpointList.some((p) => (p as { action?: string }).action === "resolve" || (p as { action?: string }).action === "reveal");
  observations[`${tag}-click`] = { clickSelector, clickedTitle, expectedUrl, activeBefore, activeAfter, tabsBefore, tabsAfter, pinpoint, highlight, toast, chip: chip1 };
  record(`${tag}2`, "至少一处主张可点出处：点击后主标签打开该 url，并尝试高亮对应段落",
    activeUrl && expectedHost && activeUrl.includes(alias(expectedHost)) && marks.length > 0 && attempted ? "pass" : "fail",
    { inlineMarks: marks.length, clicked: marks.length ? "inline .source-mark" : "list button (no inline marks; list buttons never attempt highlight)", activeUrlAfter: activeUrl, expectedUrl, newTabOpened: Array.isArray(tabsAfter) && Array.isArray(tabsBefore) && tabsAfter.length > tabsBefore.length, pinpointCalls: pinpoint, highlightSeen: highlight, toast, shots: [pageShot, shotPanelAfter] });

  // ── chip：可移除，再点一次挂回去，然后带着 chip 追问 ──
  // SAFETY: CHIP 返回 null 或固定字段对象。
  const c1 = chip1 as { visible: boolean; host: string; text: string } | null;
  let removed: Json = null;

  if (c1?.visible) {
    await rp.click(panel, "#ask-cite-close");
    await sleep(400);
    removed = await rp.evaluate(panel, CHIP);
    await rp.evaluate(panel, `document.querySelector(${JSON.stringify(clickSelector)})?.scrollIntoView({ block: "center" }); true`);
    await rp.click(panel, clickSelector);
    await until(async () => (await rp.evaluate(panel, `!document.querySelector("#ask-cite").hidden`)) || undefined, 15_000, "再点出处后 chip 回来").catch(() => null);
    await sleep(1200);
  }

  const chip2 = await rp.evaluate(panel, CHIP);
  await rp.evaluate(panel, `document.querySelector("#composer, #input")?.scrollIntoView({ block: "end" }); true`);
  const shotChip = await shot(panel, `${pre}05-chip-in-composer`);
  // SAFETY: 同上。
  const r = REVIEWS[expectedHost as keyof typeof REVIEWS];
  const hitsBefore2 = hits.length;
  const ms2 = c1?.visible ? await turn("这一页说的保修期是多久？") : null;
  const a2 = c1?.visible ? await lastAnswer() : null;
  const userBubble = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].at(-1)?.innerText ?? null`);
  const shotFollow = await shot(panel, `${pre}06-follow-up-answer`);
  const knows = !!r && !!a2 && a2.text.includes(r.warranty.replace(" ", "")) || (!!r && !!a2 && a2.text.includes(r.warranty));
  observations[`${tag}-followUp`] = { ms: ms2, userBubble, answer: a2, serverHits: hits.slice(hitsBefore2), chipAfterSend: await rp.evaluate(panel, CHIP) };
  // SAFETY: CHIP 返回 null 或固定字段对象。
  const removedHidden = (removed as { hidden?: boolean } | null)?.hidden === true;
  // SAFETY: chip2 来自 CHIP，null 或带 visible 字段的对象。
  record(`${tag}3`, "打开出处后输入框旁出现可移除的页面 chip；带着 chip 追问时助手仍知道该页",
    c1?.visible && removedHidden && (chip2 as { visible?: boolean } | null)?.visible && knows ? "pass" : "fail",
    { chipAfterFirstClick: chip1, afterClickingX: removed, chipBeforeFollowUp: chip2, expectedWarranty: r?.warranty ?? null, followUpAnswer: a2?.text.slice(0, 300) ?? null, shots: [shotChip, shotFollow] });

  };

  if (!a1?.summary) {
    record("A2", "至少一处主张可点出处：点击后主标签打开该 url，并尝试高亮对应段落", "fail", { blockedBy: "回答没有出处区（无「读了 N 个网站」，无角标），没有可点的出处", answerLinks: a1?.links ?? [] });
    record("A3", "打开出处后输入框旁出现可移除的页面 chip；带着 chip 追问时助手仍知道该页", "fail", { blockedBy: "没有出处可点，chip 无从出现" });

    if (process.argv.includes("--inject-sources")) {
      // 注入（非真实路径）：把这条真实交付原样再送进侧栏一次，只换 id 并补上事实链 sources = 服务器日志里本轮真的打开过的页面（形状同 noteRunSource，只有 url）。
      // 原来那条回答隐藏，界面上只剩一条；用来看出处 UI 长什么样、点了之后的下游行为。
      const injected = await rp.evaluate(panel, `(() => {
        const raw = [...(window.__rawDeliveries ?? [])].reverse().find((m) => JSON.stringify(m).includes('"finding"'));
        if (!raw || !window.__panelHandlers?.length) return { ok: false, raw: !!raw, handlers: window.__panelHandlers?.length ?? 0 };
        const clone = structuredClone(raw);
        const find = (o) => { if (!o || typeof o !== "object") return null; if (o.kind === "user_delivery" && o.delivery) return o.delivery; for (const v of Object.values(o)) { const f = find(v); if (f) return f; } return null; };
        const d = find(clone);
        const original = d.id;
        d.id = original + "-probe49";
        d.facts = { outcome: "complete", delivered: [], remaining: [], sources: ${JSON.stringify(pagesFetched.map((h) => ({ url: `http://${alias(h)}/` })))} };
        document.querySelectorAll("[data-probe-answer]").forEach((n) => n.removeAttribute("data-probe-answer"));
        const old = document.querySelector('[data-delivery-id="' + CSS.escape(original) + '"]');
        if (old) old.style.display = "none";
        // 历史批次按 seq 去重，原样重放会被丢掉：改用单条 server 信封送达。
        const envelope = { kind: "server", conversationId: d.conversationId, msg: { type: "agent_event", conversationId: d.conversationId, runId: d.runId, event: { kind: "user_delivery", delivery: d } } };
        for (const fn of window.__panelHandlers) fn(envelope);
        return { ok: true, original, hidOriginal: !!old };
      })()`);

      await sleep(4000);
      const s1 = await lastAnswer();
      observations.injected = { injected, answer: s1 };
      await rp.evaluate(panel, `document.querySelector("[data-probe-answer]")?.scrollIntoView({ block: "start" }); true`);
      await sleep(300);
      const c = await shot(panel, "S01-answer-collapsed");
      await rp.evaluate(panel, `(() => { const d = document.querySelector("[data-probe-answer] .answer-sources"); if (d) d.open = true; return true; })()`);
      await sleep(300);
      const o = await shot(panel, "S02-sources-open");
      record("S1", "（注入出处）出处区外观：顶部「读了 N 个网站」+ 清单 + 角标", s1?.summary ? "pass" : "fail", { summary: s1?.summary ?? null, listed: s1?.listed ?? [], marks: s1?.marks ?? [], links: s1?.links ?? [], shots: [c, o] });
      await rp.evaluate(panel, `(() => { const d = document.querySelector("[data-probe-answer] .answer-sources"); if (d) d.open = false; return true; })()`);

      if (s1?.summary) await clickFlow(s1, "S", "S");
    }
  } else {
    await clickFlow(a1, "A", "");
  }

  // ── 第 3 轮：不需要网页的问题，不应出现出处 ──
  if (!process.argv.includes("--skip-plain")) {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`)) || undefined, 15_000, "新会话");
  await sleep(800);
  const ms3 = await turn("不用看任何网页，直接告诉我：一年有几个月？");
  const a3 = await lastAnswer();
  const shotNoSource = await shot(panel, "07-no-source-answer");
  observations.run3 = { ms: ms3, answer: a3, deliveries: await rp.evaluate(panel, `window.__deliveries`) };
  record("A4a", "无出处可核时不显示假链接（不读网页的回答不出现「读了 N 个网站」和角标）",
    a3 && a3.summary === null && a3.marks.length === 0 ? "pass" : "fail",
    { summary: a3?.summary ?? null, marks: a3?.marks.length ?? null, text: a3?.text.slice(0, 120) ?? null, shot: shotNoSource });
  // SAFETY: __deliveries 条目字段见注入脚本。
  const noFacts = ((observations.run1 as { deliveries?: Array<{ type: string; hasFacts: boolean }> } | undefined)?.deliveries ?? []).filter((d) => d.type === "delivery" && !d.hasFacts).length;
  record("A4b", "旧交付记录缺 facts 字段则不渲染", noFacts > 0 && !a1?.summary ? "pass" : "not-run",
    { note: "没有构造历史旧记录；用第 1 轮真实送达的、不带 facts 的交付代替：同一渲染入口，确认不画出处区", liveDeliveriesWithoutFacts: noFacts, renderedSummary: a1?.summary ?? null });
  }

} catch (error) {
  fatal = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  console.error(fatal);

  if (panel) await shot(panel, "99-fatal").catch(() => null);
} finally {
  if (panel) observations.allDeliveries = await rp.evaluate(panel, `window.__deliveries ?? null`).catch(() => null);
  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(rp.dirs.downloads, "diag")).catch((e) => ({ traces: `export failed: ${e}` }));
  await writeFile(join(out, "traces.jsonl"), diag.traces);
  await writeFile(join(out, "result.json"), JSON.stringify({ issue: 49, model: `${plan.providerId}/${plan.modelId}`, at: new Date().toISOString(), browser: rp.browser, items, observations, allServerHits: hits, fatal }, null, 2));
  await rp.close();
  await rp.remove();

  for (const { server } of servers) { server.closeAllConnections(); server.close(); }
}

console.log(join(out, "result.json"));

if (fatal) process.exitCode = 1;
