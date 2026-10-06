/**
 * 模型直接写正文（不走交付工具）时，侧栏回答位置逐段出字；设置页能选到能力表登记的模型。
 * 验收文件：docs/evals/20261002-plain-text-streaming.md（标准 1–4）。
 *
 *   npx tsx scripts/acceptance/real-path/plain-text-streaming.mts --headless
 *
 * 隔离的无窗口 Chrome，只装扩展；模型是本机脚本模型（scripted-model.mts），像用户一样在设置页填「自定义地址」。
 *
 * 先列出会出错的方式（每条对应下面一个判据）：
 * F1 正文先进折叠的「执行过程」，回答位置等整轮结束才一次出现（10-02 MiniMax-M3.1 的样子）。
 * F2 回答位置出字比模型首段正文晚 0.5 s 以上，或要等模型写完才出字。
 * F3 宿主整轮结束交付同一段正文时又另起一个气泡：回答出现两次。
 * F4 正文之后模型又调工具：过渡话留在回答位置，或在回答位置和执行过程各一份。
 * F5 过渡话之后的最终回答没出现，或出现两次。
 * F6 走交付工具的回答重复或丢失。
 * F7 停止时回答位置留下半截正文、执行过程里又有一份；或正文整个丢了。
 * F8 出错时多出空白回答气泡。
 * F9 运行中插话：前一段正文和最终回答重复，或最终回答丢失。
 * F10 侧栏重开（历史回放）后回答条数或内容变了。
 * F11 设置里 MiniMax 下选不到 MiniMax-M3.1-Flash-Preview；或列表里出现目录和能力表都没有的名字（按名字猜）。
 *
 * 产物：out/acceptance/plain-text-streaming/<时间>/summary.json 与每个场景结束时的侧栏截图。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/plain-text-streaming", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Writers</title></head>
<body><h1>Writers</h1><p>观点：慢就是快。</p></body></html>`);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

// 每个场景的正文带一个独有记号，按记号数出现次数与位置。
const LONG = "【甲】这句话的意思是：做事不要急于求成，先把基础打牢，后面反而走得更快。".repeat(4);

const BRIDGE = "【乙】我先看一下当前页面。";

const AFTER_TOOL = "【丙】页面标题是 Writers，上面写着「慢就是快」。";

const DELIVERED = "【丁】这是交付工具送来的回答。";

const STOPPED = "【戊】这一段会在中途被停止。".repeat(12);

const BEFORE_INTERJECT = "【己】这一段正在写的时候用户插话了。".repeat(10);

const INTERJECT_ANSWER = "【庚】按你的补充，答案是三。";

const RULES: Rule[] = [
  { match: "逐字演示", steps: [{ text: LONG, chunkDelayMs: 150 }] },
  { match: "过渡演示", steps: [
    { text: BRIDGE, chunkDelayMs: 150, thenTool: { name: "get_active_tab", args: {} } },
    { text: AFTER_TOOL, delayMs: 2500, chunkDelayMs: 100 },
  ] },
  { match: "交付演示", steps: [{ tool: { name: "send_user_message", args: { kind: "finding", content: DELIVERED } } }, { text: "" }] },
  { match: "停止演示", steps: [{ text: STOPPED, chunkDelayMs: 250 }] },
  { match: "报错演示", steps: [{ status: 400, body: JSON.stringify({ error: { message: "scripted bad request" } }) }] },
  // 插话规则放在前面：插话后的请求里最后一条匹配的用户消息是插话本身。
  { match: "插话补充", steps: [{ text: INTERJECT_ANSWER, chunkDelayMs: 50 }] },
  { match: "插话演示", steps: [{ text: BEFORE_INTERJECT, chunkDelayMs: 250 }] },
];

const MARKS = ["【甲】", "【乙】", "【丙】", "【丁】", "【戊】", "【己】", "【庚】"];

/** 侧栏现状：回答位置（不在过程行里的助手气泡）与执行过程里各有哪些记号、各几次。 */
const PANEL = `(() => {
  const q = (s) => document.querySelector(s);
  const answers = [...document.querySelectorAll("#messages .msg.assistant")].filter((el) => !el.closest(".run-steps")).map((el) => el.innerText.trim()).filter(Boolean);
  const process = [...document.querySelectorAll("#messages .run-steps pre")].map((el) => el.textContent ?? "");
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    running: q("#status-pill")?.classList.contains("running") ?? false,
    stopping: q("#send-btn")?.classList.contains("stopping") ?? false,
    revealing: !!q(".msg.assistant.streaming, .msg.assistant[data-revealing]"),
    answers, process,
    errors: [...document.querySelectorAll("#messages .msg.error")].map((el) => el.innerText.trim()),
    emptyAnswers: [...document.querySelectorAll("#messages .msg.assistant")].filter((el) => !el.closest(".run-steps") && !el.innerText.trim() && !el.dataset.revealing).length,
    seen: window.__seen ?? {},
  };
})()`;

type Panel = { connected: boolean; ready: boolean; running: boolean; stopping: boolean; revealing: boolean; answers: string[]; process: string[]; errors: string[]; emptyAnswers: number; seen: Record<string, { answer?: number; process?: number; maxBubbles?: number }> };

/** 每个记号第一次出现在回答位置、执行过程里的本机时间。 */
const WATCH = `(() => {
  window.__seen = {};
  const marks = ${JSON.stringify(MARKS)};
  const scan = () => {
    const now = Date.now();
    const bubbles = [...document.querySelectorAll("#messages .msg.assistant")].filter((el) => !el.closest(".run-steps")).map((el) => el.textContent);
    const answer = bubbles.join("\\n");
    const process = [...document.querySelectorAll("#messages .run-steps pre")].map((el) => el.textContent).join("\\n");
    for (const m of marks) {
      const s = (window.__seen[m] ??= {});
      if (s.answer === undefined && answer.includes(m)) s.answer = now;
      if (s.process === undefined && process.includes(m)) s.process = now;
      s.maxBubbles = Math.max(s.maxBubbles ?? 0, bubbles.filter((b) => b.includes(m)).length);
    }
  };
  new MutationObserver(scan).observe(document.querySelector("#messages"), { subtree: true, childList: true, characterData: true });
  return true;
})()`;

const count = (list: string[], mark: string) => list.reduce((n, text) => n + text.split(mark).length - 1, 0);

const checks: Array<{ criterion: number; item: string; pass: boolean; detail: Json }> = [];

const check = (criterion: number, item: string, pass: boolean, detail: Json) => {
  checks.push({ criterion, item, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${criterion}] ${item} ${JSON.stringify(detail)}`);
};

const model = await startScriptedModel(RULES);

const rp = await launchRealPath({ withoutNativeHost: true });

let error: string | null = null;

const finals: Record<string, Json> = {};

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/writers` }, work);
  const panelTarget = await rp.openSidePanel();
  let panel = await rp.attach(panelTarget);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // SAFETY: PANEL 返回的字段与 Panel 一一对应。
  const read = async () => (await rp.evaluate(panel, PANEL)) as Panel;

  await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on")`)) || undefined, 60_000, "侧栏连上", 500);
  await until(async () => (await rp.evaluate(panel, `!document.querySelector("#send-btn").disabled`)) || undefined, 60_000, "默认会话建好");

  // 设置页：先看 MiniMax 下的模型列表（标准 4），再像用户一样配「自定义地址」指向脚本模型。
  await rp.click(panel, "#header-more");
  await sleep(400);
  await rp.click(panel, "#model-settings-open");
  const settingsTarget = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "设置页打开");
  const settings = await rp.attach(settingsTarget.targetId);
  await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".provider-option").length`)) > 3 || undefined, 15_000, "设置页渲染服务商");
  // MiniMax 的国际、中国合成一行：先展开这一行，再切到「中国」，点开模型下拉。
  await rp.evaluate(settings, `document.querySelector("#provider-more").open = true; document.querySelector('.provider-option[data-provider="minimax"]').scrollIntoView({ block: "center" }); true`);
  await rp.click(settings, `.provider-option[data-provider="minimax"]`);
  await rp.click(settings, `#region-row [data-region="minimax-cn"]`);
  await rp.click(settings, "#model-id");
  await sleep(300);
  // SAFETY: 页面脚本返回字符串数组。
  const offered = await rp.evaluate(settings, `[...document.querySelectorAll("#model-options .combo-opt")].map((o) => o.dataset.id)`) as string[];
  await rp.screenshot(settings, join(artifacts, "settings-minimax.png")).catch(() => {});
  // 独立参照：pi-ai 目录里 minimax-cn 的模型 + 能力表登记的那一个，不多不少。
  const pi = join(REPO, "node_modules/@earendil-works/pi-ai/dist/providers/all.js");
  // SAFETY: pi-ai 的公开入口，builtinModels 返回服务商目录。
  const { builtinModels } = await import(pi) as { builtinModels: () => { getModels(provider: string): Array<{ id: string }> } };
  const catalog = builtinModels().getModels("minimax-cn").map((m) => m.id);
  const expected = new Set([...catalog, "MiniMax-M3.1-Flash-Preview"]);
  check(4, "设置里 MiniMax 下能选到 MiniMax-M3.1-Flash-Preview", offered.includes("MiniMax-M3.1-Flash-Preview"), { offered });
  check(4, "列表只来自目录与能力表（无猜出来的名字、无遗漏）", offered.length === expected.size && offered.every((id) => expected.has(id)), { catalog, offered });

  await rp.evaluate(settings, `document.querySelector('.provider-option[data-provider="custom"]').scrollIntoView({ block: "center" }); true`);
  await rp.click(settings, `.provider-option[data-provider="custom"]`);
  const focus = (sel: string) => rp.evaluate(settings, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: "center" }); el.focus(); el.select?.(); return true; })()`);
  await focus("#base-url");
  await rp.typeText(settings, model.baseUrl);
  await focus("#api-key");
  await rp.typeText(settings, "local-demo-no-secret");
  await focus("#model-id");
  await rp.typeText(settings, "demo-model");
  await rp.evaluate(settings, `document.querySelector("#model-save").scrollIntoView({ block: "center" }); true`);
  await rp.click(settings, "#model-save");
  await until(async () => String(await rp.evaluate(settings, `document.querySelector("#model-status").textContent`)).startsWith("已保存") || undefined, 10_000, "保存模型");
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget.targetId });
  await sleep(1500);
  await rp.evaluate(panel, WATCH);

  const send = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    const at = Date.now();
    await rp.pressEnter(panel);

    return at;
  };

  /** 等这一轮结束：连续 6 次读数都不在跑、不在放字。 */
  const settle = async (label: string, limitMs = 120_000) => {
    const started = Date.now();
    let idle = 0;
    let last: Panel | null = null;

    while (Date.now() - started < limitMs) {
      last = await read().catch(() => null) ?? last;
      idle = last && !last.running && !last.stopping && !last.revealing && Date.now() - started > 2000 ? idle + 1 : 0;

      if (idle >= 6) break;
      await sleep(250);
    }

    await sleep(500);
    last = await read();
    finals[label] = { answers: last.answers, process: last.process, errors: last.errors, emptyAnswers: last.emptyAnswers };
    await rp.screenshot(panel, join(artifacts, `${label}.png`)).catch(() => {});

    return last;
  };

  const mainRequest = (rule: string, step = 0) => model.requests.find((r) => r.rule === rule && r.step === step && r.tools && r.firstTextAt !== undefined);

  // 1. 只写正文：逐段出现在回答位置，最终只一份。
  await send("这个观点是什么意思？逐字演示");
  const s1 = await settle("1-plain-text");
  const r1 = mainRequest("逐字演示");
  const seen1 = s1.seen["【甲】"] ?? {};
  const lag = r1?.firstTextAt !== undefined && seen1.answer !== undefined ? seen1.answer - r1.firstTextAt : null;
  check(1, "首段在回答位置出现的时间与模型首个正文增量相差 ≤ 0.5 s", lag !== null && Math.abs(lag) <= 500, { lagMs: lag, modelFirst: r1?.firstTextAt ?? null, modelLast: r1?.lastTextAt ?? null, panelFirst: seen1.answer ?? null });
  check(1, "模型还在写时回答位置已经有字（不是写完才一次放出）", seen1.answer !== undefined && r1?.lastTextAt !== undefined && seen1.answer < r1.lastTextAt - 1000, { panelFirst: seen1.answer ?? null, modelLast: r1?.lastTextAt ?? null });
  check(1, "整个过程中回答位置从未同时出现两个这段回答的气泡（交付时沿用流式气泡）", seen1.maxBubbles === 1, { maxBubbles: seen1.maxBubbles ?? null });
  check(1, "整轮结束后回答只有一份，内容完整", count(s1.answers, "【甲】") === 4 && s1.answers.filter((a) => a.includes("【甲】")).length === 1 && count(s1.process, "【甲】") === 0, { answers: s1.answers.filter((a) => a.includes("【甲】")).length, marks: count(s1.answers, "【甲】") });

  // 2. 正文之后又调工具：过渡话移进执行过程，最终回答只出现一次。
  await send("看看这页标题，过渡演示");
  // 工具调用之后、最终回答开始写之前（脚本模型这一步先等 2.5 s）读一次：过渡话应已在执行过程里、不在回答位置。
  await until(async () => model.requests.some((r) => r.rule === "过渡演示" && r.step === 1 && r.tools) || undefined, 30_000, "工具结果送回模型");
  const mid2 = await read();
  check(2, "调工具后、最终回答开始前，过渡话已在执行过程里，回答位置没有它", count(mid2.process, "【乙】") === 1 && count(mid2.answers, "【乙】") === 0, { process: count(mid2.process, "【乙】"), answers: count(mid2.answers, "【乙】") });
  const s2 = await settle("2-text-then-tool");
  check(2, "过渡话不留在回答位置（结束后）", count(s2.answers, "【乙】") === 0, { answers: s2.answers });
  check(2, "最终回答只出现一次", count(s2.answers, "【丙】") === 1, { answers: s2.answers });
  check(2, "最终回答在过程中也从未同时出现两份", s2.seen["【丙】"]?.maxBubbles === 1, { maxBubbles: s2.seen["【丙】"]?.maxBubbles ?? null });

  // 3a. 交付工具：与原来一样只出现一次。
  await send("交付演示");
  const s3 = await settle("3a-delivery-tool");
  check(3, "交付工具的回答只出现一次", count(s3.answers, "【丁】") === 1, { answers: s3.answers });

  // 3b. 停止：半截正文按原样留在执行过程，回答位置不留副本。
  await send("停止演示");
  await until(async () => ((await read()).seen["【戊】"]?.answer ?? (await read()).seen["【戊】"]?.process) || undefined, 30_000, "停止前已出字");
  await sleep(1500);
  await rp.click(panel, "#send-btn");
  const s4 = await settle("3b-stop");
  check(3, "停止后半截正文不在回答位置、留在执行过程里，不重复", count(s4.answers, "【戊】") === 0 && count(s4.process, "【戊】") >= 1 && s4.process.filter((p) => p.includes("【戊】")).length === 1, { answers: count(s4.answers, "【戊】"), process: s4.process.filter((p) => p.includes("【戊】")).length });

  // 3c. 出错：显示错误，不多出空白回答。
  await send("报错演示");
  const s5 = await settle("3c-error", 150_000);
  check(3, "出错时显示错误，没有空白回答气泡", s5.errors.length >= 1 && s5.emptyAnswers === 0, { errors: s5.errors, emptyAnswers: s5.emptyAnswers });

  // 3d. 插话：写到一半补一句，最终回答只出现一次，前一段不在回答位置重复。
  await send("插话演示");
  await until(async () => ((await read()).seen["【己】"]?.answer ?? (await read()).seen["【己】"]?.process) || undefined, 30_000, "插话前已出字");
  await sleep(1000);
  await send("插话补充：只要数字");
  const s6 = await settle("3d-interject");
  check(3, "插话后最终回答只出现一次", count(s6.answers, "【庚】") === 1, { answers: s6.answers });
  check(3, "插话前那段正文在回答位置不重复", s6.answers.filter((a) => a.includes("【己】")).length <= 1, { answers: s6.answers.filter((a) => a.includes("【己】")).length });

  // 3e. 历史回放：侧栏重开后回答不变。
  const before = (await read()).answers;
  // SAFETY: 页面脚本返回当前会话编号字符串。
  const conversationId = await rp.evaluate(panel, `document.querySelector('#conversation-menu [aria-checked="true"]')?.dataset.conversationId ?? ""`) as string;
  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(1000);
  panel = await rp.attach(panelTarget).catch(() => panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on")`)) || undefined, 60_000, "重开后连上", 500);
  await sleep(2000);
  // 重开侧栏会另开新会话：像用户一样从会话列表切回刚才那段，看历史回放出来的样子。
  await rp.click(panel, "#conversation-switcher");
  await sleep(300);
  await rp.evaluate(panel, `document.querySelector('#conversation-menu [data-conversation-id="${conversationId}"]').click(); true`);
  await until(async () => (await read()).answers.length >= before.length || undefined, 20_000, "切回原会话").catch(() => null);
  await sleep(2000);
  const after = (await read()).answers;
  finals["3e-history"] = { before, after };
  await rp.screenshot(panel, join(artifacts, "3e-history.png")).catch(() => {});
  check(3, "侧栏重开（历史回放）后回答条数与内容不变", JSON.stringify(before) === JSON.stringify(after), { before: before.length, after: after.length });
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  console.error(error);
} finally {
  await writeFile(join(artifacts, "summary.json"), JSON.stringify({ at: new Date().toISOString(), checks, finals, error, modelRequests: model.requests }, null, 2));
  await rp.close();
  await model.close();
  await rp.remove();
  site.close();
}

const failed = checks.filter((c) => !c.pass);

console.log(`${checks.length - failed.length}/${checks.length} 通过${error ? "（中途出错）" : ""}；产物在 ${artifacts}`);

process.exit(failed.length || error ? 1 : 0);
