/**
 * 2026-09-26 实拍发现的 10 个界面问题：按用户路径逐条复现并在同一步截图，改前改后各跑一次对照。
 *
 *   npx tsx scripts/acceptance/real-path/ux-fixes.mts --headless --phase=before|after [--only=main,voice-nokey,...]
 *   npx tsx scripts/acceptance/real-path/ux-fixes.mts --headless --phase=after --only=real-confirm --real-model=stepfun/step-3.7-flash
 *
 * 每组一个隔离的无窗口 Chrome，只装扩展（demo 组另注册伴随进程）。模型是本机脚本模型（scripted-model.mts），
 * 像用户一样在设置页选「自定义地址」填写；real-confirm 组用本机已配置的真实模型，只看「等确认时这一轮会不会结束」。
 * 语音组的 key 从本机 ~/.sideagent/stepfun-api.key 读出，在设置页「实时语音」里填写，不打印、不落盘。
 *
 * 产物：out/acceptance/ux-fixes/<phase>/ 下每步一张侧栏或页面截图，summary.json 记下每步侧栏文字、页面浮层文字和判据。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc, type Json, type JsonRecord } from "./harness.mts";
import { configureViaSettings, loadModelPlan } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const phase = process.argv.find((a) => a.startsWith("--phase="))?.slice(8) ?? "after";

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");

const realModel = process.argv.find((a) => a.startsWith("--real-model="))?.slice(13);

const artifacts = join(REPO, "out/acceptance/ux-fixes", phase);

await mkdir(artifacts, { recursive: true });

const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px/1.8 -apple-system,'PingFang SC',sans-serif;margin:32px 40px">${body}</body></html>`;

const COMPOSE_TYPO = "各位好：我们明天下午三点在会议是开会，讨论新版本的上线计画，请大家准时参加，不要迟道。";

const COMPOSE_FIXED = "各位好：我们明天下午三点在会议室开会，讨论新版本的上线计划，请大家准时参加，不要迟到。";

// 页面内容取自 everyday-baseline.mts 的真实路径练习页。
const PAGES = new Map<string, string>(Object.entries({
  "/article": page("远程办公的代价", `<article><h1>远程办公的代价</h1>
<p>过去三年，我们团队全员远程。本文的核心观点是：远程办公明显提高了资深成员的专注时间，但严重削弱了新人的成长速度。</p>
<p id="numbers">资深工程师每周不被打断的整块时间从 9 小时增加到 21 小时；新人第一次独立交付功能的时间却从 6 周拖长到 14 周。</p>
<p>原因在于新人失去了旁听和随手提问的机会。我们的对策是每周两天集中办公，专门留给带新人。</p></article>`),
  "/quota": page("套餐用量", `<main><h1>套餐用量</h1><section><h2>当前套餐：Go</h2>
<div class="row"><span>本月请求数</span> <strong>1,204</strong></div>
<div class="row" id="five-hour"><span>五小时用量</span> <strong>32%</strong></div>
<div class="row"><span>剩余额度</span> <strong id="balance">$12.40</strong></div></section></main>`),
  "/note": page("System One 与草稿", `<main><h1>System One</h1><p>Jev currently accepts text input only.</p>
<h2>我的草稿</h2><form method="post" action="/save"><textarea id="draft" name="draft" rows="4" cols="60" aria-label="草稿">今天的周报</textarea>
<button type="submit" id="save">保存</button></form></main>`),
  "/companies": page("三家候选供应商", `<main><h1>三家候选供应商</h1><p>详细资料在各自页面。</p>
<ul><li><a href="/company/lumen">Lumen 光子</a></li><li><a href="/company/harbor">Harbor 港湾</a></li><li><a href="/company/kite">Kite 风筝</a></li></ul></main>`),
  "/compose": page("写通知", `<main><h1>写通知</h1><form method="post" action="/save"><textarea id="draft" name="draft" rows="4" cols="60" aria-label="通知草稿">${COMPOSE_TYPO}</textarea>
<button type="submit" id="save">发送</button></form></main>`),
}));

let saves = 0;

const site = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "POST" && path === "/save") {
    saves += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("已保存", "<p>已保存</p>"));

    return;
  }

  const html = PAGES.get(path);
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const RULES: Rule[] = [
  { match: "报错演示", steps: [{ status: 503, body: JSON.stringify({ message: "upstream overloaded (scripted)" }) }] },
  { match: "提交到服务器", steps: [
    { tool: { name: "fetch", args: { url: "https://report.example.com/api/weekly", method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "draft=%E4%BB%8A%E5%A4%A9%E7%9A%84%E5%91%A8%E6%8A%A5" } } },
    { text: "你没有允许，这次提交没有发出。" },
  ] },
  { match: "我指给你", steps: [
    { tool: { name: "ask_user_to_point", args: { message: "请在页面上点一下你说的那一项" } } },
    { text: "你点的是「剩余额度 $12.40」。" },
  ] },
  { match: "改错字", steps: [
    { tool: { name: "fill", args: { target: "#draft", value: COMPOSE_FIXED } } },
    { tool: { name: "click", args: { target: "#save", label: "发送" } } },
    { text: "改了 3 处错字（会议是→会议室、计画→计划、迟道→迟到）。「发送」等你在页面上确认后才会发出。" },
  ] },
  { match: "开头改成", steps: [
    { tool: { name: "fill", args: { target: "#draft", value: "各位同事好：明天下午三点开会。" } } },
    { text: "草稿开头已经改好。" },
  ] },
  { match: "很长的任务", steps: [{ text: "三家资料已经汇总。", delayMs: 60_000 }] },
  { match: "这两个数字", steps: [{ text: "说明远程让资深的人更专注，却让新人成长慢了一倍多：专注时间多了 12 小时，新人独立交付却晚了 8 周。" }] },
];

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    running: q("#status-pill")?.classList.contains("running") ?? false,
    stopping: q("#send-btn")?.classList.contains("stopping") ?? false,
    streaming: !!q(".msg.assistant.streaming, .msg.assistant[data-revealing]"),
    userMessages: document.querySelectorAll(".msg.user").length,
    text: document.querySelector("#app").innerText,
  };
})()`;

type PanelState = { connected: boolean; running: boolean; stopping: boolean; streaming: boolean; userMessages: number; text: string };

/** 用户面前不该出现的内部文字：工具名、元素编号、宿主占位、原始错误 JSON、把拒绝说成失败。 */
const LEAKS: Array<[string, RegExp]> = [
  ["工具名", /\b(fetch|ask_user_to_point|send_user_message|task_goals|record_task_results|page_operation|browser_run|artifacts)\b/],
  ["元素编号", /@\d{2,}/],
  ["宿主占位", /目标未记录|新任务|待发送材料|^材料$/m],
  ["原始错误", /\{"message"|\b50\d:|upstream overloaded/],
  ["账本口吻", /任务状态：仅交付部分结果|未声明全部完成/],
];

const leaksIn = (text: string) => LEAKS.flatMap(([name, re]) => (re.test(text) ? [name] : []));

type Capture = { step: string; file: string; panelText?: string; overlayText?: string[]; leaks?: string[]; note?: JsonRecord };

const captures: Capture[] = [];

const checks: Array<{ item: string; pass: boolean; detail: Json }> = [];

const check = (item: string, pass: boolean, detail: Json) => {
  checks.push({ item, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${item} ${JSON.stringify(detail)}`);
};

type RealPath = Awaited<ReturnType<typeof launchRealPath>>;

type DomNode = { nodeId: number; nodeType: number; nodeName: string; nodeValue?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

/** 一次浏览器会话里的用户动作。 */
async function session(rp: RealPath, startPath: string) {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("DOM.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}${startPath}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);
  // SAFETY: PANEL_STATE 返回的字段与 PanelState 一一对应。
  const readPanel = async () => (await rp.evaluate(panel, PANEL_STATE)) as PanelState;

  const navigate = async (path: string) => {
    await rp.cdp.send("Page.navigate", { url: `${origin}${path}` }, work);
    await until(async () => (await rp.evaluate(work, `location.pathname === ${JSON.stringify(path)} && document.readyState === "complete"`)) || undefined, 10_000, `打开 ${path}`);
    await sleep(800);
  };

  /** 页面上扩展浮层（封闭 shadow root）里的文字：用 CDP 穿透读取。 */
  const overlayText = async (): Promise<string[]> => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const { root } = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)) as { root: DomNode };
    const out: string[] = [];

    const walk = (node: DomNode, inShadow: boolean) => {
      if (inShadow && node.nodeType === 3 && node.nodeValue?.trim() && !/^[\s{}:;.#@-]/.test(node.nodeValue.trim())) out.push(node.nodeValue.trim());

      if (node.nodeName === "STYLE") return;

      for (const child of node.children ?? []) walk(child, inShadow);

      for (const shadow of node.shadowRoots ?? []) walk(shadow, true);
    };

    walk(root, false);

    return out;
  };

  /** 浮层里某段文字所在元素的外框（视口坐标）。 */
  const overlayBox = async (text: string, tag?: string) => {
    // SAFETY: 同上。
    const { root } = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)) as { root: DomNode };
    let found: number | null = null;

    const walk = (node: DomNode, inShadow: boolean, parent: DomNode | null) => {
      if (found) return;

      if (inShadow && node.nodeType === 3 && node.nodeValue?.trim() === text && parent && (!tag || parent.nodeName === tag)) found = parent.nodeId;

      for (const child of node.children ?? []) walk(child, inShadow, node);

      for (const shadow of node.shadowRoots ?? []) walk(shadow, true, node);
    };

    walk(root, false, null);

    if (!found) return null;
    // SAFETY: DOM.getBoxModel 返回 { model: { border: Quad } }。
    const { model } = (await rp.cdp.send("DOM.getBoxModel", { nodeId: found }, work)) as { model: { border: number[] } };
    const xs = [0, 2, 4, 6].map((i) => model.border[i]!);
    const ys = [1, 3, 5, 7].map((i) => model.border[i]!);

    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };

  const clickAt = async (target: string, x: number, y: number) => {
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, target);
    await sleep(120);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, target);
    await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, target);
  };

  const shotPanel = async (step: string, note?: JsonRecord) => {
    const file = `${step}.png`;
    await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
    await sleep(300);
    await rp.screenshot(panel, join(artifacts, file));
    const text = (await readPanel()).text;
    captures.push({ step, file, panelText: text, leaks: leaksIn(text), note });

    return text;
  };

  const shotPage = async (step: string, note?: JsonRecord) => {
    const file = `${step}.png`;
    await rp.screenshot(work, join(artifacts, file));
    const overlay = await overlayText();
    captures.push({ step, file, overlayText: overlay, leaks: leaksIn(overlay.join("\n")), note });

    return overlay;
  };

  const send = async (text: string) => {
    const before = (await readPanel()).userMessages;
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    const at = Date.now();

    // 侧栏刚起来时偶尔吞掉第一下回车（输入框里字还在）：像用户一样再点一次发送键。
    const sent = await until(async () => (await readPanel()).userMessages > before || undefined, 5_000, "消息发出").catch(() => false);

    if (!sent && String(await rp.evaluate(panel, `document.querySelector("#input").value`)).includes(text)) await rp.click(panel, "#send-btn");

    return at;
  };

  const waitIdle = async (limitMs = 120_000) => {
    const started = Date.now();
    let idle = 0;

    while (Date.now() - started < limitMs) {
      const s = await readPanel().catch(() => null);
      const busy = !s || s.running || s.stopping || s.streaming;
      idle = !busy && Date.now() - started > 2500 ? idle + 1 : 0;

      if (idle >= 6) return Date.now() - started;
      await sleep(250);
    }

    throw new Error(`${limitMs / 1000} 秒内这一轮没有结束`);
  };

  const newConversation = async () => {
    const before = await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length`);
    await rp.click(panel, "#conversation-new");
    await until(async () => (await rp.evaluate(panel, `document.querySelectorAll(".msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`)) || undefined, 10_000, `新会话（之前 ${before} 条）`);
    await sleep(600);
  };

  const openMenu = async () => {
    for (let i = 0; i < 3 && !(await rp.evaluate(panel, `document.querySelector("#header-menu").matches(":popover-open")`)); i += 1) {
      await rp.click(panel, "#header-more");
      await sleep(400);
    }
  };

  return { work, panel, readPanel, navigate, overlayText, overlayBox, clickAt, shotPanel, shotPage, send, waitIdle, newConversation, openMenu };
}

type Session = Awaited<ReturnType<typeof session>>;

/** 像用户一样在设置页选「自定义地址」，填本机脚本模型。 */
async function configureScripted(rp: RealPath, s: Session, model: { baseUrl: string; requests: unknown[] }) {
  const baseUrl = model.baseUrl;
  await s.openMenu();
  await rp.click(s.panel, "#model-settings-open");
  const target = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "设置页打开");
  const settings = await rp.attach(target.targetId);
  await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页渲染服务商");
  await rp.evaluate(settings, `document.querySelector("#provider-more").open = true; true`);
  await rp.click(settings, `.provider-option[data-provider="custom"]`);
  await until(async () => (await rp.evaluate(settings, `!document.querySelector("#provider-form").hidden`)) || undefined, 5_000, "服务商表单展开");
  const focus = (sel: string) => rp.evaluate(settings, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: "center" }); el.focus(); el.select?.(); return true; })()`);
  await focus("#base-url");
  await rp.typeText(settings, baseUrl);
  await focus("#api-key");
  await rp.typeText(settings, "local-demo-no-secret");
  await focus("#model-id");
  await rp.typeText(settings, "demo-model");
  await rp.evaluate(settings, `document.querySelector("#model-test").scrollIntoView({ block: "center" }); true`);
  await rp.click(settings, "#model-test");

  const test = await until(async () => {
    // SAFETY: 这段页面脚本返回 [data-tone, textContent] 两个字符串。
    const [tone, t] = await rp.evaluate(settings, `[document.querySelector("#model-status").dataset.tone, document.querySelector("#model-status").textContent]`) as [string, string];

    return tone === "ok" || tone === "err" ? t : undefined; }, 30_000, "测试连接").catch(async (e) => {
    throw new Error(`${e.message}；设置页显示：${await rp.evaluate(settings, `[document.querySelector("#model-status").textContent, document.querySelector("#base-url").value, document.querySelector("#model-id").value, document.querySelector(".provider-option[aria-checked=true], .provider-option.selected")?.dataset.provider]`).then(JSON.stringify)}；模型请求 ${JSON.stringify(model.requests)}`);
  });

  if (!test.startsWith("连接正常")) throw new Error(`测试连接没通过：${test}`);
  await rp.evaluate(settings, `document.querySelector("#model-save").scrollIntoView({ block: "center" }); true`);
  await rp.click(settings, "#model-save");
  await until(async () => String(await rp.evaluate(settings, `document.querySelector("#model-status").textContent`)).startsWith("已保存") || undefined, 10_000, "保存");

  return { test, settingsTargetId: target.targetId, settings };
}

/** 设置页「实时语音」里填 key 并保存。key 只经输入框进入扩展存储。 */
async function saveVoiceKey(rp: RealPath, settings: string, fake?: string) {
  const key = fake ?? (await readFile(join(homedir(), ".sideagent/stepfun-api.key"), "utf8")).trim();
  await rp.evaluate(settings, `document.querySelector("#voice-key").scrollIntoView({ block: "center" }); true`);
  await rp.click(settings, "#voice-key");
  await rp.typeText(settings, key);
  await rp.click(settings, "#voice-save");
  await sleep(800);

  return String(await rp.evaluate(settings, `document.querySelector("#voice-status").textContent`));
}

// ── 主组：只装扩展 + 脚本模型 ─────────────────────────────────

async function mainGroup() {
  const model = await startScriptedModel(RULES);
  const rp = await launchRealPath({ withoutNativeHost: true });

  try {
    const s = await session(rp, "/article");
    await until(async () => (await s.readPanel()).connected || undefined, 60_000, "侧栏就绪", 500);
    // 侧栏刚打开时在建默认会话（「＋」转圈），这时按回车不会发出去；等它建好，像用户看到能发了再发。
    // 只装扩展、还没配模型时建默认会话要 10 秒上下（发送键这时是灰的，本轮未改）。
    const ready = `!document.querySelector("#send-btn").disabled && document.querySelector("#conversation-new")?.getAttribute("aria-label") === "新会话"`;
    await sleep(3000);
    await until(async () => (await rp.evaluate(s.panel, ready)) || undefined, 60_000, "默认会话建好");
    await sleep(1500);

    // 6a：还没配模型就发消息。
    await s.send("这篇文章的核心观点是什么？");
    await until(async () => /还没有配置模型/.test((await s.readPanel()).text) || undefined, 30_000, "未配模型的提示").catch(async (error) => {
      await s.shotPanel("06a-model-none-timeout");
      throw error;
    });
    await sleep(1500);
    const none = await s.shotPanel("06a-model-none");
    check("6a 未配模型不显示内部占位", !/目标未记录|新任务|^材料$/m.test(none), leaksIn(none));

    // 配模型。
    const cfg = await configureScripted(rp, s, model);
    await rp.cdp.send("Target.closeTarget", { targetId: cfg.settingsTargetId });
    await rp.cdp.send("Page.bringToFront", {}, s.work);
    await s.newConversation();

    // 6b：附上截屏。
    await rp.click(s.panel, "#attach-btn");
    await sleep(400);
    await rp.click(s.panel, "#menu-action-screenshot");
    await until(async () => (await rp.evaluate(s.panel, `!document.querySelector("#attachments-strip").hidden`)) || undefined, 10_000, "截屏附上");
    await sleep(800);
    const attach = await s.shotPanel("06b-attach-added");
    check("6b 附上截图不显示内部占位", !/目标未记录|新任务|待发送材料/.test(attach), leaksIn(attach));
    await rp.evaluate(s.panel, `document.querySelector("#attachments-strip button")?.click(); true`);
    await s.newConversation();

    // 1：模型持续 503。
    const inproc = await watchInproc(rp, rp.extensionId);
    const sentAt = await s.send("这页讲了什么？（报错演示）");
    const sentMs = inproc.now();

    const errorMs = await until(async () => { const st = await s.readPanel();

      return !st.running && /出错|失败|没有回应|不可用|稍后|忙/.test(st.text.split("这页讲了什么？（报错演示）").pop() ?? "") ? Date.now() - sentAt : undefined; }, 90_000, "出错提示", 200).catch(() => null);

    await s.waitIdle().catch(() => {});
    const err = await s.shotPanel("01-chat-error", { errorShownMs: errorMs });
    const attempts = model.requests.filter((r) => r.rule === "报错演示").map((r) => r.atMs);
    check("1 模型出错时用平常话、及时出现", errorMs !== null && errorMs <= 10_000 && !/\{"message"|任务状态：仅交付部分结果/.test(err), { errorShownMs: errorMs, attemptsMs: attempts.map((a) => a - attempts[0]!), sentMs });
    await s.newConversation();

    // 2+3：请求授权，拒绝。
    await s.navigate("/note");
    await s.send("把「今天的周报」提交到服务器。");
    await until(async () => (await rp.evaluate(s.panel, `!document.querySelector("#consent-requests").hidden && !!document.querySelector(".consent-reject")`)) || undefined, 30_000, "授权卡");
    await rp.evaluate(s.panel, `document.querySelector("#consent-requests details")?.setAttribute("open", ""); true`);
    await sleep(600);
    const card = await s.shotPanel("02-consent-card");
    check("2 授权进行中不露工具名", !/\bfetch\b/.test(card), leaksIn(card));
    check("3 授权卡发送内容可读", !/%E4%BB/.test(card) && /今天的周报/.test(card), card.match(/发送内容[\s\S]{0,60}/)?.[0] ?? "");
    await rp.click(s.panel, ".consent-reject");
    await s.waitIdle();
    const denied = await s.shotPanel("03-consent-denied");
    check("3 拒绝后不说失败、不给继续", !/执行失败|仍有步骤执行失败|没做成|继续/.test(denied.split("把「今天的周报」提交到服务器。").pop() ?? ""), leaksIn(denied));
    await s.newConversation();

    // 2：请用户指一下。
    await s.navigate("/quota");
    await s.send("剩余额度那一项，我指给你。");
    await until(async () => (await s.overlayText()).some((t) => t.includes("点一下")) || undefined, 30_000, "页面上的选择提示");
    await sleep(800);
    const pointing = await s.shotPanel("02-point-running");
    await s.shotPage("02-point-page");
    check("2 选择过程行不露工具名", !/ask_user_to_point/.test(pointing), pointing.match(/正在[^\n]*/g) ?? []);
    // SAFETY: 页面脚本返回元素中心点 { x, y }。
    const balance = await rp.evaluate(s.work, `(() => { const r = document.querySelector("#balance").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number };
    await s.clickAt(s.work, balance.x, balance.y);
    await s.waitIdle();
    await s.shotPanel("02-point-done");
    await s.newConversation();

    // 4：发送键被拦下后这一轮结束；5：留着待确认时另开会话操作同一页。
    await s.navigate("/compose");
    await s.send("帮我改错字，然后点发送。");
    await s.waitIdle();
    await sleep(1500);
    const afterRun = await s.shotPage("04-confirm-after-run");
    await s.shotPanel("04-confirm-panel");
    // 按钮要在「发送」键旁边看得见，才算留给了用户（停在角落的隐藏名牌不算）。
    // SAFETY: 页面脚本返回元素中心点 { x, y }。
    const save = await rp.evaluate(s.work, `(() => { const r = document.querySelector("#save").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as { x: number; y: number };
    const box = await s.overlayBox("发送", "BUTTON").catch(() => null);
    const confirmShown = !!box && box.w > 0 && Math.hypot(box.x + box.w / 2 - save.x, box.y + box.h / 2 - save.y) < 300;
    const savesBefore = saves;
    let confirmed = false;

    if (confirmShown) {
      if (box) {
        await s.clickAt(s.work, box.x + box.w / 2, box.y + box.h / 2);
        await until(async () => saves > savesBefore || undefined, 10_000, "表单提交").catch(() => {});
        confirmed = saves > savesBefore;
      }
    }

    check("4 这一轮结束后页面上仍能确认并发出", confirmShown && confirmed, { overlay: afterRun, confirmBox: box, save, confirmed });

    // 5：重新走一遍，留着待确认不点，再新开会话操作同一页。
    await s.navigate("/compose");
    await s.newConversation();
    await s.send("帮我改错字，然后点发送。");
    await s.waitIdle();
    await s.newConversation();
    await s.send("把草稿开头改成「各位同事好」。");
    await s.waitIdle();
    const busy = await s.shotPanel("05-tab-busy");
    const draft = await rp.evaluate(s.work, `document.querySelector("#draft")?.value ?? null`);
    await s.shotPage("05-tab-busy-page");
    check("5 新会话能在留着待确认的页面上操作", String(draft).startsWith("各位同事好") && !/执行失败|页面没有变化/.test(busy), { draft, leaks: leaksIn(busy) });
    await s.newConversation();

    // 9a：接管时小伙伴 M 与「详情」。
    await s.navigate("/companies");
    await s.send("这是一个很长的任务：把三家供应商的资料汇总成表。");
    await until(async () => (await rp.evaluate(s.panel, `!document.querySelector("#takeover-btn").hidden`)) || undefined, 20_000, "接管按钮");
    await sleep(1500);
    await rp.click(s.panel, "#takeover-btn");
    await until(async () => /页面归你|已暂停/.test((await s.readPanel()).text) || undefined, 15_000, "接管生效");
    await sleep(1200);
    await s.shotPanel("09a-takeover-panel");
    const covered = await rp.evaluate(s.panel, COVERED_BUTTONS);
    check("9a 小伙伴 M 不挡按钮", Array.isArray(covered) && covered.length === 0, covered);
    await rp.click(s.panel, "#send-btn").catch(() => {});
    await sleep(1500);
    await s.newConversation();

    // 10：只装扩展时的「更多」菜单与技能与记忆。
    await s.openMenu();
    await sleep(400);
    const menu = await s.shotPanel("10a-more-menu");
    // SAFETY: 页面脚本返回按钮文字数组。
    const entries = await rp.evaluate(s.panel, `[...document.querySelectorAll("#header-menu button")].filter((b) => !b.hidden && b.getClientRects().length).map((b) => b.innerText.trim())`) as string[];

    if (entries.includes("技能与记忆")) {
      await rp.click(s.panel, "#memory-open");
      await sleep(1500);
      await rp.evaluate(s.panel, `document.querySelector("#seg-memory")?.click(); true`);
      await sleep(1500);
      await s.shotPanel("10b-memory");
      await rp.evaluate(s.panel, `document.querySelector("#memory-close")?.click(); true`);
    }

    if (entries.includes("示范给 AI")) {
      await s.openMenu();
      await rp.click(s.panel, "#record-toggle");
      await s.navigate("/note");
      await rp.click(s.work, "#draft");
      await rp.typeText(s.work, "；本周完成：设置页改版");
      await sleep(600);
      await rp.click(s.panel, "#demo-stop");
      await sleep(800);
      await rp.click(s.panel, "#demo-intent");
      await rp.typeText(s.panel, "把本周完成事项写进草稿");
      await rp.click(s.panel, "#demo-compile");
      await sleep(3000);
      await rp.evaluate(s.panel, `document.querySelector("#demo-strip").scrollIntoView({ block: "end" }); true`);
      await s.shotPanel("10c-demo-compile");
    }

    check("10 只装扩展时不提供只会失败的技能与记忆入口", !entries.includes("技能与记忆") && !entries.includes("示范给 AI"), { entries, menu: menu.length });
    await rp.evaluate(s.panel, `document.querySelector("#header-menu").hidePopover?.(); true`).catch(() => {});

    // 8：选中追问。
    await s.navigate("/article");
    await rp.evaluate(s.work, `(() => { const p = document.querySelector("#numbers"); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()`);
    await rp.evaluate(s.panel, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => chrome.tabs.sendMessage(t.id, { type: "ask-hotkey" })).then(() => true)`);
    await sleep(1200);
    // SAFETY: 页面脚本返回选区与标题的上下沿。
    const selection = await rp.evaluate(s.work, `(() => { const r = document.querySelector("#numbers").getBoundingClientRect(); const h = document.querySelector("h1").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h1Bottom: h.bottom }; })()`) as { top: number; bottom: number; h1Bottom: number };
    const cardOpen = await cardBox(rp, s.work);
    await s.shotPage("08a-ask-open", { card: cardOpen, selection });
    await rp.typeText(s.work, "这两个数字说明什么？");
    await rp.pressEnter(s.work);
    await until(async () => (await s.overlayText()).some((t) => t.includes("成长慢了")) || undefined, 30_000, "追问回答");
    await sleep(1000);
    const cardAnswer = await cardBox(rp, s.work);
    await s.shotPage("08b-ask-answer", { card: cardAnswer, selection });
    const sameSide = !!cardOpen && !!cardAnswer && (cardOpen.y >= selection.bottom) === (cardAnswer.y >= selection.bottom);
    const coversHeading = !!cardOpen && cardOpen.y < selection.h1Bottom;
    check("8 追问卡片不跳位、不盖标题", sameSide && !coversHeading, { cardOpen, cardAnswer, selection });
  } finally {
    await rp.close();
    await model.close();
    await rp.remove();
  }
}

/** 追问卡片（封闭 shadow root 里的 section.surface）的外框。 */
async function cardBox(rp: RealPath, work: string) {
  // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
  const { root } = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)) as { root: DomNode };
  let found: number | null = null;

  const walk = (node: DomNode) => {
    if (found) return;
    const attrs = node.attributes ?? [];
    const cls = attrs[attrs.indexOf("class") + 1];

    if (node.nodeName === "SECTION" && attrs.includes("class") && /\bsurface\b/.test(cls ?? "")) found = node.nodeId;

    for (const child of node.children ?? []) walk(child);

    for (const shadow of node.shadowRoots ?? []) walk(shadow);
  };

  walk(root);

  if (!found) return null;
  // SAFETY: DOM.getBoxModel 返回 { model: { border: Quad } }。
  const { model } = (await rp.cdp.send("DOM.getBoxModel", { nodeId: found }, work)) as { model: { border: number[] } };

  return { y: model.border[1]!, bottom: model.border[5]! };
}

/** 侧栏里被小伙伴 M 盖住的可见按钮。 */
const COVERED_BUTTONS = `(() => {
  const host = document.querySelector("#pix-companion");
  if (!host) return [];
  const r = host.getBoundingClientRect();
  if (!r.width) return [];
  const hits = [];
  for (const b of document.querySelectorAll("button, summary, a")) {
    if (host.contains(b) || !b.getClientRects().length || b.closest("[hidden]") || b.closest("#header-menu")) continue;
    const t = b.getBoundingClientRect();
    const ix = Math.min(r.right, t.right) - Math.max(r.left, t.left);
    const iy = Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top);
    if (ix > 2 && iy > 2) hits.push((b.innerText || b.getAttribute("aria-label") || b.id).trim().slice(0, 20));
  }
  return hits;
})()`;

// ── 示范组：注册伴随进程（技能存储可用），看「编译成脚本」是否被 M 挡住 ──────

async function demoGroup() {
  const rp = await launchRealPath();

  try {
    const s = await session(rp, "/note");
    await until(async () => (await s.readPanel()).connected || undefined, 90_000, "侧栏连上伴随进程", 500);
    await sleep(1500);
    await s.openMenu();
    await rp.click(s.panel, "#record-toggle");
    await sleep(800);
    await rp.click(s.work, "#draft");
    await rp.typeText(s.work, "；本周完成：设置页改版");
    await rp.click(s.work, "h1");
    await sleep(600);
    await rp.click(s.panel, "#demo-stop");
    await sleep(1000);
    await rp.evaluate(s.panel, `document.querySelector("#demo-strip").scrollIntoView({ block: "end" }); true`);
    await sleep(400);
    await s.shotPanel("09b-demo-strip");
    const covered = await rp.evaluate(s.panel, COVERED_BUTTONS);
    check("9b 示范结束后小伙伴 M 不挡「编译成脚本」", Array.isArray(covered) && covered.length === 0, covered);
  } finally {
    await rp.close();
    await rp.remove();
  }
}

// ── 语音组 ──────────────────────────────────────────────────

async function voiceGroup(kind: "nokey" | "mic" | "conn" | "ready") {
  const wav = join(REPO, "docs/evals/20260913-voice-greeting-fix-evidence/greeting-after-page.wav");
  const model = await startScriptedModel(RULES);

  const rp = await launchRealPath({
    withoutNativeHost: true,
    microphoneWav: kind === "mic" ? undefined : wav,
  });

  try {
    const s = await session(rp, "/article");
    await until(async () => (await s.readPanel()).connected || undefined, 60_000, "侧栏就绪", 500);
    const cfg = await configureScripted(rp, s, model);

    // 连不上：填一把服务端不认的 key，语音服务拒绝握手，浏览器只报一个不带原因的连接错误。
    if (kind !== "nokey") await saveVoiceKey(rp, cfg.settings, kind === "conn" ? "local-invalid-voice-key" : undefined);
    await rp.cdp.send("Target.closeTarget", { targetId: cfg.settingsTargetId });
    await rp.cdp.send("Page.bringToFront", {}, s.work);

    await sleep(1000);
    // 记下语音状态行出现过的每一句：连接失败后客户端会自动重连，最终画面不一定停在出错那一句。
    await rp.evaluate(s.panel, `(() => { window.__voiceStates = []; const el = document.querySelector(".voice-state"); new MutationObserver(() => { const t = el.textContent; if (t && window.__voiceStates.at(-1) !== t) window.__voiceStates.push(t); }).observe(el, { childList: true, characterData: true, subtree: true }); return true; })()`);
    await rp.click(s.panel, ".voice-start");

    const settled = await until(async () => {
      const st = String(await rp.evaluate(s.panel, `document.querySelector(".voice-progress")?.dataset.state ?? ""`));

      return (kind === "ready" ? st === "listening" : st === "error") ? st : undefined;
    }, 45_000, `语音进入${kind === "ready" ? "就绪" : "出错"}`, 300).catch(() => "timeout");

    await sleep(1200);

    // 麦克风授权页会在新标签页打开：关掉，回到侧栏看状态。
    for (const t of await rp.targets()) if (t.url.endsWith("/voice-permission.html")) await rp.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    const text = await s.shotPanel(`07-voice-${kind}`, { settled });
    // SAFETY: 页面脚本返回状态文字和每个可见按钮的文字与外框。
    const voice = await rp.evaluate(s.panel, `(() => { const r = document.querySelector(".voice-progress"); const vis = (el) => el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && el.textContent.trim(); const b = [...r.querySelectorAll("button")].filter(vis).map((el) => { const x = el.getBoundingClientRect(); return { text: el.textContent.trim(), l: x.left, r: x.right, t: x.top, b: x.bottom }; }); return { state: r.querySelector(".voice-state").textContent, buttons: b }; })()`) as { state: string; buttons: Array<{ text: string; l: number; r: number; t: number; b: number }> };
    const overlap = voice.buttons.some((a, i) => voice.buttons.some((b, j) => j > i && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1));

    if (kind === "nokey") check("7 没填语音 key 时指向「更多 → 模型与语音」", /更多/.test(voice.state) && /模型与语音/.test(voice.state) && !/本机/.test(voice.state), voice.state);

    if (kind === "mic") check("7 麦克风未授权时按钮不叠在一起", !overlap, voice.buttons);

    // SAFETY: __voiceStates 是上面装的观察器写入的字符串数组。
    const states = await rp.evaluate(s.panel, "window.__voiceStates") as string[];

    if (kind === "conn") check("7 连接失败的文案不重复", states.some((t) => /连不上|出错|失败/.test(t)) && !states.some((t) => /(语音服务连接出错).*\1/.test(t)), states);

    if (kind === "ready") check("7 就绪时不显示内部型号", !/Realtime/.test(text) && settled !== "timeout", voice.state);
  } finally {
    await rp.close();
    await model.close();
    await rp.remove();
  }
}

// ── 真实模型：页面上等确认时，这一轮会不会结束 ─────────────────────

async function realConfirmGroup() {
  if (!realModel) throw new Error("real-confirm 需要 --real-model=provider/id");
  const rp = await launchRealPath({ withoutNativeHost: true });

  try {
    const s = await session(rp, "/compose");
    await until(async () => (await s.readPanel()).connected || undefined, 60_000, "侧栏就绪", 500);
    const plan = await loadModelPlan(realModel);
    const run = await configureViaSettings(rp, s.panel, plan);
    await rp.cdp.send("Target.closeTarget", { targetId: run.settingsTargetId });
    await rp.cdp.send("Page.bringToFront", {}, s.work);
    await s.send("帮我改错字，然后点发送。");
    const ms = await s.waitIdle(300_000);
    await sleep(1500);
    const overlay = await s.shotPage("04-real-confirm-after-run");
    const text = await s.shotPanel("04-real-confirm-panel");
    const pending = overlay.includes("发送") && overlay.includes("取消");
    const draft = await rp.evaluate(s.work, `document.querySelector("#draft")?.value ?? null`);
    // 展开执行过程，逐步记下每一步的名字和回执，看「发送」是怎么处理的。
    await rp.evaluate(s.panel, `document.querySelector("#messages .run-steps > summary")?.click(); true`);
    await sleep(500);
    const steps = await rp.evaluate(s.panel, `(async () => { const out = []; for (const chip of document.querySelectorAll("#messages .run-steps .chip")) { chip.click(); await new Promise((r) => setTimeout(r, 150)); const detail = chip.closest(".run-body")?.querySelector(".chip-detail, .tool-detail"); out.push({ label: chip.innerText.trim(), detail: detail?.innerText.trim().slice(0, 400) ?? null }); chip.click(); } return out; })()`);
    await s.shotPanel("04-real-confirm-steps");
    const exported = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
    await writeFile(join(artifacts, "real-confirm-traces.jsonl"), exported.traces);
    check("4 真实模型：等确认时这一轮已结束（记录，不作判据）", true, { turnMs: ms, pendingConfirmVisible: pending, overlay, draft, saves, steps, answer: text.slice(-400) });
  } finally {
    await rp.close();
    await rp.remove();
  }
}

const GROUPS = new Map<string, () => Promise<void>>(Object.entries({
  main: mainGroup,
  demo: demoGroup,
  "voice-nokey": () => voiceGroup("nokey"),
  "voice-mic": () => voiceGroup("mic"),
  "voice-conn": () => voiceGroup("conn"),
  "voice-ready": () => voiceGroup("ready"),
  "real-confirm": realConfirmGroup,
}));

const selected = only ?? [...GROUPS.keys()].filter((g) => g !== "real-confirm");

const errors: Record<string, string> = {};

for (const name of selected) {
  const run = GROUPS.get(name);

  if (!run) throw new Error(`没有这一组：${name}`);
  console.log(`== ${name}`);

  try {
    await run();
  } catch (error) {
    errors[name] = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`组 ${name} 出错：${errors[name]}`);
  }
}

site.close();

const summaryFile = join(artifacts, `summary-${selected.join("+")}.json`);

await writeFile(summaryFile, JSON.stringify({ phase, at: new Date().toISOString(), groups: selected, checks, errors, captures }, null, 2));

console.log(summaryFile);
