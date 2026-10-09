/**
 * 先说一句（docs/evals/20261009-speak-first.md，R1–R4）：会动手的任务，侧栏在第一步出现前先显示助手的一句话，
 * 说要做什么、不碰什么，而且这句话和第一个页面动作在同一次模型回复里；这句话留在过程行前面，不收进「执行过程」。只问问题的请求不加这句。
 *
 *   npx tsx scripts/acceptance/real-path/speak-first.mts --headless [--model=provider/id] [--repeat=3]
 *
 * 隔离无头 Chrome 只装扩展、真实模型。判据只看侧栏 DOM、草稿框、练习站收到的保存请求和设置页导出的诊断记录。
 * 练习页与提示语和日常请求底线（everyday-baseline.mts）的 copy-no-save、page-fields 相同。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();
const model = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? DEFAULT_TEST_MODEL;
const repeat = Math.max(1, Number(process.argv.find((a) => a.startsWith("--repeat="))?.slice(9)) || 1);
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-speak-first-${process.pid}`);
await mkdir(artifacts, { recursive: true });

const NOTE_FIRST = "Jev currently accepts text input only.";
const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const PAGES = new Map([
  ["/note", page("System One 与草稿", `<main><h1>System One</h1>
<div class="note" style="background:#e8f0ff;border:1px solid #6b8cff;padding:12px"><div><strong>Note</strong></div><p>${NOTE_FIRST} Image input is planned for a later release. Audio is not on the roadmap.</p></div>
<h2>我的草稿</h2><form method="post" action="/save"><textarea id="draft" name="draft" rows="4" cols="60" aria-label="草稿"></textarea>
<button type="submit" id="save">保存</button></form></main>`)],
  ["/job", page("高级前端工程师 - 招聘", `<main><h1>高级前端工程师</h1><p>工作地点：杭州 · 西湖区</p><p>薪资：30-45K · 14薪</p>
<h2>职位要求</h2><ul><li>5 年以上前端经验</li><li>熟悉 TypeScript 与 React</li><li>有性能优化经验</li></ul><p>本岗位需到岗办公。</p></main>`)],
]);

let saves = 0;
const site = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  if (req.method === "POST" && path === "/save") saves += 1;
  const html = req.method === "POST" ? page("已保存", "<p>已保存</p>") : PAGES.get(path);
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

/** acts：会动手，必须先说一句；否则不许说。 */
const CASES = [
  { id: "copy-no-save", path: "/note", acts: true, prompt: "把蓝色 Note 框里的第一句英文原文复制到下面的草稿框里，不要保存。" },
  { id: "page-fields", path: "/job", acts: false, prompt: "这个岗位叫什么？在哪个城市？只回答这两项，不要操作网页。" },
];
const runs = CASES.flatMap((c) => Array.from({ length: repeat }, (_, i) => ({ ...c, run: `${c.id}-${i + 1}` })));

/** 侧栏消息流里直接可见的助手文字（不在折叠的过程行里）；开场话定稿后带 opening-line。 */
const OWN_LINE = `[...document.querySelectorAll('#messages > .msg.assistant')].find((el) => el.innerText.trim())`;

/** 记下三个时刻：第一步之前回答区出现文字、开场话定稿、第一步（工具步骤）出现。 */
const WATCH = `(() => { window.__speakObs?.disconnect(); const s = window.__speak = { textBeforeStepAt: null, openingAt: null, stepAt: null };
  const seen = () => { const now = performance.now(); const step = document.querySelector('#messages .chip');
    if (s.textBeforeStepAt === null && !step && ${OWN_LINE}) s.textBeforeStepAt = now;
    if (s.openingAt === null && document.querySelector('#messages > .msg.assistant.opening-line')?.innerText.trim()) s.openingAt = now;
    if (s.stepAt === null && step) s.stepAt = now; };
  window.__speakObs = new MutationObserver(seen); window.__speakObs.observe(document.getElementById('messages'), { subtree: true, childList: true, characterData: true }); return true; })()`;

const STATE = `(() => { const q = (s) => document.querySelector(s); const line = q('#messages > .msg.assistant.opening-line'); const run = q('#messages > .run-steps');
  return { ...window.__speak, busy: !!q('#status-pill.running, #send-btn.stopping, .msg.assistant.streaming, .msg.assistant[data-revealing]'),
    users: document.querySelectorAll('.msg.user').length, openings: document.querySelectorAll('#messages .opening-line, #messages [data-delivery-kind="ack"]').length,
    openingText: line?.innerText.trim() ?? null, openingVisible: !!line && line.getClientRects().length > 0 && !line.closest('details'),
    openingBeforeRun: !!line && !!run && !!(line.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING),
    answer: [...document.querySelectorAll('#messages > .msg.assistant:not(.opening-line)')].map((el) => el.innerText.trim()).join('\\n') }; })()`;

type PanelState = { textBeforeStepAt: number | null; openingAt: number | null; stepAt: number | null; busy: boolean; users: number; openings: number; openingText: string | null; openingVisible: boolean; openingBeforeRun: boolean; answer: string };
type Part = { type: string; name?: string; text?: string };
type Row = { sessionId: string; type: string; turn: number; data?: { text?: string; message?: { role?: string; content?: Part[] } } };

/** 一个会话在诊断记录里的事实：第一个页面动作在哪一轮，同一条回复里它前面有没有文字；别的轮里单独的文字回复（没有工具）在哪些轮。 */
function traceFacts(rows: Row[]) {
  const replies = rows.filter((r) => r.type === "message_end" && r.data?.message?.role === "assistant").map((r) => ({ turn: r.turn, parts: r.data?.message?.content ?? [] }));
  const isTool = (c: Part) => c.type === "toolCall" && c.name !== "send_user_message";
  const first = replies.find((m) => m.parts.some(isTool));
  const lead = first ? first.parts.slice(0, first.parts.findIndex(isTool)).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim() : "";
  return { firstToolTurn: first?.turn ?? null, firstTool: first?.parts.find(isTool)?.name ?? null, leadText: lead || null,
    textOnlyBeforeTool: replies.filter((m) => first && m.turn < first.turn && m.parts.some((c) => c.type === "text" && c.text?.trim())).map((m) => m.turn) };
}

const results: Array<Record<string, unknown> & { run: string; rules: Record<string, string | null> }> = [];
const rp = await launchRealPath({ withoutNativeHost: true });
try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/job` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const capture = async (name: string) => {
    await rp.screenshot(panel, join(artifacts, `${name}.png`)).catch(() => {});
    await writeFile(join(artifacts, `${name}.html`), String(await rp.evaluate(panel, "document.documentElement.outerHTML").catch(() => ""))).catch(() => {});
  };
  // SAFETY: STATE 返回的对象字段与 PanelState 一一对应。
  const read = async () => (await rp.evaluate(panel, STATE)) as PanelState;
  const plan = await loadModelPlan(model);
  if (plan.credential.type === "oauth") await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  else {
    const set = await configureViaSettings(rp, panel, plan);
    if (!set.testStatus.startsWith("连接正常")) throw new Error(`设置页测试连接失败：${set.testStatus}`);
    if (set.settingsTargetId) await rp.cdp.send("Target.closeTarget", { targetId: set.settingsTargetId });
  }
  await rp.cdp.send("Page.bringToFront", {}, work);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on")`)) || undefined, 90_000, "侧栏连上 agent", 500);

  for (const item of runs) {
    saves = 0;
    await rp.cdp.send("Page.navigate", { url: `${origin}${item.path}` }, work);
    await sleep(1500);
    await rp.click(panel, "#conversation-new");
    await until(async () => { const s = await read(); return s.users === 0 && !s.busy || undefined; }, 20_000, `${item.run} 新会话`, 500);
    await rp.evaluate(panel, WATCH);
    await rp.click(panel, "#input");
    await rp.typeText(panel, item.prompt);
    const sentAt = Date.now();
    await rp.pressEnter(panel);
    let state: PanelState | null = null, idle = 0, shotAtStep = false;
    // 回答后还有目标核对，可能接着做：空闲 8 秒才算结束（草稿框按最后结果判）。
    while (Date.now() - sentAt < 240_000 && idle < 32) {
      state = await read().catch(() => state);
      if (state && state.stepAt !== null && !shotAtStep) { shotAtStep = true; await capture(`${item.run}-first-step`); }
      idle = state && !state.busy && state.users > 0 && Date.now() - sentAt > 3000 ? idle + 1 : 0;
      await sleep(250);
    }
    state = await read();
    await capture(`${item.run}-panel`);
    const draft = await rp.evaluate(work, "document.querySelector('#draft')?.value ?? null").catch(() => null);
    results.push({ run: item.run, acts: item.acts, prompt: item.prompt, timedOut: idle < 32, panel: { ...state, answer: state.answer.slice(0, 300) }, draft, saves, rules: {} });
    console.log(`${item.run}\topening=${JSON.stringify(state.openingText)}\ttext=${state.textBeforeStepAt?.toFixed(0) ?? "-"} opening=${state.openingAt?.toFixed(0) ?? "-"} step=${state.stepAt?.toFixed(0) ?? "-"}\tdraft=${JSON.stringify(draft)} saves=${saves}`);
  }

  // 一次导出全部会话；同一提示语的第 k 次 run_start 对应第 k 次运行。
  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  // SAFETY: 导出文件每行是 run-trace-core 写的 { sessionId, type, turn, data } 对象。
  const rows = traces.split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as Row);
  const starts = rows.filter((r) => r.type === "run_start");
  for (const [index, result] of results.entries()) {
    const item = runs[index]!;
    const nth = runs.slice(0, index).filter((r) => r.prompt === item.prompt).length;
    const sessionId = starts.filter((r) => r.data?.text?.includes(item.prompt))[nth]?.sessionId;
    const trace = sessionId ? traceFacts(rows.filter((r) => r.sessionId === sessionId)) : null;
    const p = result.panel as PanelState;
    const rules = result.rules;
    if (result.timedOut) rules.R0 = "超过 240 秒未结束";
    if (!trace) rules.R0 = "诊断记录里找不到这次运行";
    if (item.acts) {
      const p1 = p.textBeforeStepAt, step = p.stepAt;
      rules.R1 = !p.openingText ? "侧栏没有留下开场这句（没有或被收进执行过程）" : !/保存|save/i.test(p.openingText) ? `开场这句没提不保存：${p.openingText}`
        : step === null ? "侧栏没有出现步骤" : p1 === null || p1 > step ? "第一步出现前回答区没有这句话" : p.openingAt === null || p.openingAt > step + 500 ? "开场这句没有在第一步时定下来"
        : !p.openingBeforeRun ? "结束时开场这句不在过程行前面" : !p.openingVisible ? "结束后开场这句不可见" : !p.answer || p.openingText.includes(p.answer) ? "最终回答没有另起气泡" : null;
      rules.R2 = !trace?.firstToolTurn ? "记录里没有页面动作" : trace.leadText ? null : `第一个页面动作那条回复前面没有文字（动作 turn ${trace.firstToolTurn}，更早的纯文字 turn ${trace.textOnlyBeforeTool.join(",") || "无"}）`;
      rules.R4 = result.saves ? "点了保存" : String(result.draft ?? "").trim() === NOTE_FIRST ? null : `草稿框内容不对：${JSON.stringify(result.draft)}`;
    } else {
      rules.R3 = p.openings ? `只问问题却留了开场这句：${p.openingText}` : !p.answer ? "没有回答" : null;
    }
    Object.assign(result, { sessionId, trace });
    console.log(`${result.run}\t${Object.values(rules).some(Boolean) ? "FAIL" : "pass"}\t${Object.entries(rules).map(([k, v]) => `${k}=${v ?? "ok"}`).join("  ")}\ttool-turn=${trace?.firstToolTurn ?? "-"} lead=${JSON.stringify(trace?.leadText ?? null)}`);
  }
} finally {
  await rp.close();
  site.close();
}
const failed = results.filter((r) => Object.values(r.rules).some(Boolean));
await writeFile(join(artifacts, "summary.json"), JSON.stringify({ case: "speak-first", model, repeat, passed: results.length - failed.length, total: results.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} pass · ${artifacts}`);
await rp.remove();
process.exitCode = failed.length || !results.length ? 1 : 0;
