/**
 * 日常请求底线：10 条取自真实使用记录的请求，逐条在新会话里发出，只看用户看得到的结果。
 *
 *   npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless [--model=provider/id] [--only=hello,math]
 *   npx tsx scripts/acceptance/real-path/everyday-baseline.mts --daily [--only=...]   # 用户已开的日常 Chrome（9222），需用户同意
 *   npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless --inproc=stepfun/step-3.7-flash   # 只装扩展，设置页配模型
 *
 * --inproc 时每条另记扩展内 agent 发出的模型请求（地址、首字节、结束），并判定请求都发往所选服务商。
 *
 * 每条记录：是否出现回答、首字出现耗时、整轮结束耗时、侧栏里回答之外的杂项数（提示、错误、回执、任务卡、续做入口），
 * 以及该条的结果判据（答案内容、页面圈画、新标签页、草稿框原文且未保存）。练习页全在本机，不碰真实账号。
 */
import { cp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { REPO, attachDailyChrome, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc, type InprocRequest } from "./harness.mts";
import { configureViaSettings, loadModelPlan, type ModelPlan } from "./inproc-config.mts";

const daily = process.argv.includes("--daily");

/** --inproc=provider/id：不注册伴随进程，从设置页配置这个模型。 */
const inprocModel = process.argv.find((a) => a.startsWith("--inproc="))?.slice(9);

if (!daily) requireHeadless();

const CASE_LIMIT_MS = 240_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-everyday-baseline${daily ? "-daily" : inprocModel ? "-inproc" : ""}`);

await mkdir(artifacts, { recursive: true });

const NOTE_FIRST = "Jev currently accepts text input only.";

const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const PAGES = {
  "/article": page("远程办公的代价", `<article><h1>远程办公的代价</h1>
<p>过去三年，我们团队全员远程。本文的核心观点是：远程办公明显提高了资深成员的专注时间，但严重削弱了新人的成长速度。</p>
<p>资深工程师每周不被打断的整块时间从 9 小时增加到 21 小时；新人第一次独立交付功能的时间却从 6 周拖长到 14 周。</p>
<p>原因在于新人失去了旁听和随手提问的机会。我们的对策是每周两天集中办公，专门留给带新人。</p></article>`),
  "/job": page("高级前端工程师 - 招聘", `<main><h1>高级前端工程师</h1><p>工作地点：杭州 · 西湖区</p><p>薪资：30-45K · 14薪</p>
<h2>职位要求</h2><ul><li>5 年以上前端经验</li><li>熟悉 TypeScript 与 React</li><li>有性能优化经验</li></ul><p>本岗位需到岗办公。</p></main>`),
  "/en": page("Why small teams ship faster", `<article><h1>Why small teams ship faster</h1>
<p>Small teams spend less time coordinating and more time building. Every additional person adds communication paths that grow quadratically.</p>
<p>In our survey of forty startups, teams under six people shipped features twice as often as larger teams.</p>
<p>The lesson is not that big teams are bad, but that each team should own a narrow problem end to end.</p></article>`),
  "/quota": page("套餐用量", `<main><h1>套餐用量</h1><section><h2>当前套餐：Go</h2>
<div class="row"><span>本月请求数</span><strong>1,204</strong></div>
<div class="row" id="five-hour"><span>五小时用量</span><strong>32%</strong></div>
<div class="row"><span>剩余额度</span><strong>$12.40</strong></div></section></main>`),
  "/projects": page("本周值得关注的三个开源项目", `<main><h1>本周值得关注的三个开源项目</h1>
<ol><li><b>Alpha Kit</b>：一个轻量的表单校验库。仓库：<a href="https://github.com/example-org/alpha-kit">github.com/example-org/alpha-kit</a></li>
<li><b>Beta Flow</b>：可视化工作流编辑器。仓库：<a href="https://github.com/example-org/beta-flow">github.com/example-org/beta-flow</a></li>
<li><b>Gamma DB</b>：嵌入式时序数据库。仓库：<a href="https://github.com/example-org/gamma-db">github.com/example-org/gamma-db</a></li></ol></main>`),
  "/note": page("System One 与草稿", `<main><h1>System One</h1>
<div class="note" style="background:#e8f0ff;border:1px solid #6b8cff;padding:12px"><div><strong>Note</strong></div><p>${NOTE_FIRST} Image input is planned for a later release. Audio is not on the roadmap.</p></div>
<h2>我的草稿</h2><form method="post" action="/save"><textarea id="draft" name="draft" rows="4" cols="60" aria-label="草稿"></textarea>
<button type="submit" id="save">保存</button></form></main>`),
} satisfies Record<string, string>;

const PAGE_BY_PATH = new Map<string, string>(Object.entries(PAGES));

let saveRequests = 0;

const site = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "POST" && path === "/save") {
    saveRequests += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("已保存", "<p>已保存</p>"));

    return;
  }

  const html = PAGE_BY_PATH.get(path);
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

type Ctx = { answer: string; pageText: string; marks: number; draft: string | null; tabs: string[]; saves: number };

type Case = { id: string; path: string; prompt: string; check: (c: Ctx) => string | null };

const has = (text: string, ...needles: string[]) => needles.every((n) => text.includes(n));

const CASES: Case[] = [
  { id: "hello", path: "/article", prompt: "你好", check: (c) => (c.answer ? null : "没有回答") },
  { id: "math", path: "/article", prompt: "1+1等于几啊？", check: (c) => (/2|二/.test(c.answer) ? null : "回答里没有 2") },
  { id: "upset", path: "/article", prompt: "好烦", check: (c) => (c.answer ? null : "没有回答") },
  { id: "page-gist", path: "/article", prompt: "这篇文章的核心观点是什么？", check: (c) => (has(c.answer, "新人") ? null : "没提到新人成长这一核心观点") },
  { id: "page-fields", path: "/job", prompt: "这个岗位叫什么？在哪个城市？只回答这两项，不要操作网页。", check: (c) => (has(c.answer, "前端", "杭州") ? null : "缺岗位名或城市") },
  { id: "three-repos", path: "/projects", prompt: "找到这三个项目的 GitHub 仓库地址。", check: (c) => (has(c.answer, "alpha-kit", "beta-flow", "gamma-db") ? null : "三个仓库没有全部给出") },
  { id: "translate", path: "/en", prompt: "把这个页面翻译成中文。", check: (c) => ((c.pageText.match(/[一-鿿]/g) ?? []).length >= 20 ? null : "页面上没有出现中文译文") },
  { id: "mark", path: "/quota", prompt: "在页面上圈出五小时用量。", check: (c) => (c.marks > 0 ? null : "页面上没有圈画") },
  { id: "open-tab", path: "/article", prompt: `在新标签页打开 ${origin}/job`, check: (c) => (c.tabs.some((u) => u.startsWith(`${origin}/job`)) ? null : "没有打开新标签页") },
  { id: "copy-no-save", path: "/note", prompt: "把蓝色 Note 框里的第一句英文原文复制到下面的草稿框里，不要保存。",
    check: (c) => (c.saves > 0 ? "点了保存" : c.draft?.trim() === NOTE_FIRST ? null : `草稿框内容不对：${JSON.stringify(c.draft)}`) },
];

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");

const selected = only ? CASES.filter((c) => only.includes(c.id)) : CASES;

/** 导出文件的一行必须带本机记录的公共字段（time、sessionId、type、整数 turn）；data.text 可缺省。 */
const TraceLineSchema = Type.Object({
  time: Type.String(), sessionId: Type.String(), type: Type.String(), turn: Type.Integer(),
  data: Type.Optional(Type.Object({ text: Type.Optional(Type.String()) })),
});

type TraceLine = Static<typeof TraceLineSchema>;

/** 解析失败或缺字段返回 null，由调用方计为缺字段。 */
function parseTraceLine(raw: string): TraceLine | null {
  try {
    const value = JSON.parse(raw);

    return Check(TraceLineSchema, value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 用户路径：设置页点「导出」拿到 jsonl，再点「清空」。判据独立于产品实现：直接读下载下来的文件。
 * 可能的失败：扩展没写记录；漏会话；行缺字段；密钥进了记录；清空不彻底。
 */
async function checkTraceExport(modelPlan: ModelPlan) {
  const { exportStatus, traces: text, clearedStatus } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"), { clearAfter: true });
  const lines = text.split("\n").filter(Boolean).map(parseTraceLine);
  const starts = lines.filter((line) => line?.type === "run_start").map((line) => line?.data?.text ?? "");
  const missing = selected.filter((item) => !starts.some((started) => started.includes(item.prompt))).map((item) => item.id);
  const malformed = lines.filter((line) => !line).length;
  const key = String(modelPlan.credential.key ?? "");
  const leaked = key.length > 8 && text.includes(key);
  const sessions = new Set(lines.map((line) => line?.sessionId)).size;
  const cleared = clearedStatus ?? "";
  const reason = !text ? `没有导出任务记录（${exportStatus}）` : missing.length ? `缺少这些用例的记录：${missing.join(", ")}` : malformed ? `${malformed} 行缺字段或不是 JSON` : leaked ? "导出里出现了 API key" : !cleared.startsWith("还没有") ? `清空后导出仍有内容：${cleared}` : null;

  return { outcome: reason ? "fail" as const : "pass" as const, reason, sessions, lines: lines.length, missing, exportStatus, clearedStatus: cleared };
}

/** 所选服务商的 API 主机；--inproc 时用来判定请求发往哪里。 */
const PROVIDER_HOSTS = { stepfun: "api.stepfun.com", "zai-coding-cn": "open.bigmodel.cn" } satisfies Record<string, string>;

const hostOf = (provider: string): string | undefined => Object.entries(PROVIDER_HOSTS).find(([id]) => id === provider)?.[1];

const expectedHost = inprocModel ? hostOf(inprocModel.split("/")[0] ?? "") : undefined;

if (inprocModel && !expectedHost) throw new Error(`不知道 ${inprocModel} 的 API 主机，先补进 PROVIDER_HOSTS`);

/** 模型调用：发往已知服务商主机的 POST（排除练习站、扩展自身资源和语音握手）。 */
const isModelCall = (r: InprocRequest) => r.method === "POST" && Object.values(PROVIDER_HOSTS).includes(new URL(r.url).host);

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  const visible = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && el.innerText.trim().length > 0;
  const answers = [...document.querySelectorAll("#messages .msg.assistant")].map((el) => el.innerText.trim()).filter(Boolean);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    running: q("#status-pill")?.classList.contains("running") ?? false,
    stopping: q("#send-btn")?.classList.contains("stopping") ?? false,
    streaming: !!q(".msg.assistant.streaming, .msg.assistant[data-revealing]"),
    inputValue: q("#input")?.value ?? null,
    userMessages: [...document.querySelectorAll(".msg.user")].map((el) => el.innerText.trim()),
    answers,
    noise: {
      notices: [...document.querySelectorAll("#messages .msg.notice")].map((el) => el.innerText.trim()),
      errors: [...document.querySelectorAll("#messages .msg.error")].map((el) => el.innerText.trim()),
      receipts: document.querySelectorAll("#messages > .msg.receipt, #messages > details:not(.run-steps)").length,
      taskCard: visible(q("#task-result-card")),
      taskBar: visible(q("#task-bar-root")),
      resumeEntry: visible(q("#resume-entry-root")),
      processRows: document.querySelectorAll("#messages .run-steps").length,
      toolSteps: document.querySelectorAll("#messages .chip").length,
      footers: document.querySelectorAll("#messages .delivery-facts").length,
    },
  };
})()`;

type PanelState = {
  connected: boolean; running: boolean; stopping: boolean; streaming: boolean; inputValue: string | null;
  userMessages: string[]; answers: string[];
  noise: { notices: string[]; errors: string[]; receipts: number; taskCard: boolean; taskBar: boolean; resumeEntry: boolean; processRows?: number; footers?: number; toolSteps?: number };
};

type DomNode = { attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

type CaseResult = {
  id: string; prompt: string; replied: boolean; firstVisibleMs: number | null; doneMs: number | null; noiseCount: number;
  noise: PanelState["noise"] | null; outcome: "pass" | "fail"; reason: string | null; answer: string;
  /** 只在 --inproc：本条发出的模型请求（毫秒相对发送时刻）。 */
  modelCalls?: Array<{ host: string; startMs: number; firstByteMs: number | null; endMs: number | null; status: number | null; failed: string | null }>;
};

const results: CaseResult[] = [];

const rp = daily ? await attachDailyChrome() : await launchRealPath({ withoutNativeHost: !!inprocModel });

let inproc: Awaited<ReturnType<typeof watchInproc>> | null = null;

let plan: ModelPlan | null = null;

/** 只在 --inproc：设置页导出的诊断记录是否覆盖每条用例、不含密钥、清空后为空。 */
let traceCheck: { outcome: "pass" | "fail"; reason: string | null; sessions: number; lines: number; missing: string[]; exportStatus: string; clearedStatus: string } | null = null;

try {
  const blank = "workTargetId" in rp ? { targetId: rp.workTargetId } : await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/article` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  // SAFETY: PANEL_STATE 返回的对象字段与 PanelState 一一对应。
  const readPanel = async () => (await rp.evaluate(panel, PANEL_STATE)) as PanelState;

  // 日常 Chrome 若在跑扩展内 agent（无本机伴随进程），同样从外部记录它的请求。
  if (daily && (await rp.targets()).some((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`)) inproc = await watchInproc(rp, rp.extensionId);

  if (inprocModel) {
    inproc = await watchInproc(rp, rp.extensionId);
    plan = await loadModelPlan(inprocModel);
    const run = await configureViaSettings(rp, panel, plan);

    if (!run.testStatus.startsWith("连接正常")) throw new Error(`设置页测试连接失败：${run.testStatus}`);
    await rp.cdp.send("Target.closeTarget", { targetId: run.settingsTargetId });
    await rp.cdp.send("Page.bringToFront", {}, work);
  }

  await until(async () => (await readPanel()).connected || undefined, 90_000, "侧栏连上伴随进程", 500);

  const countMarks = async (): Promise<number> => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const { root } = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)) as { root: DomNode };
    let count = 0;

    const walk = (node: DomNode) => {
      const attrs = node.attributes ?? [];
      const at = attrs.indexOf("class");

      if (at >= 0 && /(^|\s)mark(\s|$)/.test(attrs[at + 1] ?? "")) count += 1;

      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };

    walk(root);

    return count;
  };

  for (const item of selected) {
    saveRequests = 0;
    await rp.cdp.send("Page.navigate", { url: `${origin}${item.path}` }, work);
    // 上一条可能新开了标签页并让它成为当前页（open-tab）；每条都从自己的练习页开始。
    await rp.cdp.send("Page.bringToFront", {}, work);
    await sleep(1500);
    await rp.click(panel, "#conversation-new");
    await until(async () => {
      const state = await readPanel();

      return state.userMessages.length === 0 && !state.running ? state : undefined;
    }, 20_000, `${item.id} 新会话`, 500);
    await sleep(1000);
    await rp.screenshot(panel, join(artifacts, `${item.id}-starter.png`)).catch(() => {});

    if (process.env.STARTER_DEBUG) {
      console.log("starter-debug", JSON.stringify(await rp.evaluate(panel, `(() => ({
        app: document.getElementById("app")?.className,
        messages: [...document.getElementById("messages").children].map((c) => c.id + ":" + c.childElementCount + ":" + c.className),
        starter: getComputedStyle(document.getElementById("starter")).display,
        input: document.getElementById("input").value,
        placeholderShown: document.getElementById("input").matches(":placeholder-shown"),
        running: !!document.querySelector("#status-pill.running"),
        actions: document.getElementById("starter-actions").innerText,
      }))()`)));
    }

    await rp.click(panel, "#input");
    await rp.typeText(panel, item.prompt);
    const sentAt = Date.now();
    const sentAtInproc = inproc?.now() ?? 0;
    await rp.pressEnter(panel);
    let firstVisibleMs: number | null = null;
    let doneMs: number | null = null;
    let idle = 0;
    let last: PanelState | null = null;
    let pageShots = 0;
    let nextPageShotAt = 0;

    while (Date.now() - sentAt < CASE_LIMIT_MS) {
      const state = await readPanel().catch(() => null);

      if (state) {
        last = state;

        if (state.inputValue?.includes(item.prompt) && !state.userMessages.length) await rp.pressEnter(panel);

        if (firstVisibleMs === null && state.answers.length) firstVisibleMs = Date.now() - sentAt;

        // 助手运行期间每 2.5 秒给网页本身拍一张（最多 4 张）：验收页面边缘光、光标与标注。
        if (pageShots < 4 && state.running && (state.noise.toolSteps ?? 0) > 0 && Date.now() >= nextPageShotAt) {
          pageShots += 1;
          nextPageShotAt = Date.now() + 1500;
          await rp.screenshot(work, join(artifacts, `${item.id}-page-running-${pageShots}.png`)).catch(() => {});
        }

        const busy = state.running || state.stopping || state.streaming;
        idle = !busy && state.userMessages.length > 0 && Date.now() - sentAt > 3000 ? idle + 1 : 0;

        if (idle >= 6) {
          doneMs = Date.now() - sentAt - 1500;
          break;
        }
      }

      await sleep(250);
    }

    await sleep(1000);
    const final = (await readPanel().catch(() => null)) ?? last;

    // 超时的任务先停掉，免得它在后台继续跑、干扰下一条。
    if (doneMs === null) {
      await rp.click(panel, "#send-btn").catch(() => {});
      await until(async () => {
        const state = await readPanel();

        return !state.running && !state.stopping ? state : undefined;
      }, 30_000, `${item.id} 停止`, 500).catch(() => null);
    }

    const pageText = String(await rp.evaluate(work, "document.body?.innerText ?? ''").catch(() => ""));
    const draftValue = await rp.evaluate(work, "document.querySelector('#draft')?.value ?? null").catch(() => null);
    const tabs = (await rp.targets()).filter((t) => t.type === "page").map((t) => t.url);
    const answer = final?.answers.join("\n\n") ?? "";
    const ctx: Ctx = { answer, pageText, marks: await countMarks().catch(() => 0), draft: draftValue == null ? null : String(draftValue), tabs, saves: saveRequests };
    const noise = final?.noise ?? null;
    const noiseCount = noise ? noise.notices.length + noise.errors.length + noise.receipts + Number(noise.taskCard) + Number(noise.taskBar) + Number(noise.resumeEntry) + (noise.processRows ?? 0) + (noise.footers ?? 0) : 0;
    const reason = doneMs === null ? `超过 ${CASE_LIMIT_MS / 1000} 秒未结束` : item.check(ctx);

    const modelCalls = inproc?.requestsBetween(sentAtInproc).filter(isModelCall).map((r) => ({
      host: new URL(r.url).host, startMs: r.startMs - sentAtInproc, firstByteMs: r.firstByteMs === null ? null : r.firstByteMs - sentAtInproc,
      endMs: r.endMs === null ? null : r.endMs - sentAtInproc, status: r.status, failed: r.failed,
    }));

    // 设置页选的是哪家，请求就只能发往哪家：防「换了模型却仍用旧模型」。
    const wrongHost = inprocModel && modelCalls?.find((c) => c.host !== expectedHost);
    const finalReason = reason ?? (wrongHost ? `模型请求发往 ${wrongHost.host}，不是所选的 ${expectedHost}` : null);
    results.push({ id: item.id, prompt: item.prompt, replied: answer.length > 0, firstVisibleMs, doneMs, noiseCount, noise, outcome: finalReason ? "fail" : "pass", reason: finalReason, answer: answer.slice(0, 600), modelCalls });
    await rp.screenshot(panel, join(artifacts, `${item.id}-panel.png`)).catch(() => {});
    const calls = modelCalls ? `\tcalls=${modelCalls.length} ttfb=${modelCalls.map((c) => (c.firstByteMs === null ? "-" : c.firstByteMs - c.startMs)).join(",")}` : "";
    console.log(`${item.id}\t${finalReason ? "FAIL" : "pass"}\treply=${answer.length > 0}\tfirst=${firstVisibleMs ?? "-"}ms\tdone=${doneMs ?? "-"}ms\tnoise=${noiseCount}${calls}\t${finalReason ?? ""}`);
  }

  if (inprocModel && plan) traceCheck = await checkTraceExport(plan);
} finally {
  await writeFile(join(artifacts, "hostlog.txt"), inproc ? inproc.logs() : await rp.hostLog()).catch(() => {});

  if (inproc) await writeFile(join(artifacts, "inproc-requests.json"), JSON.stringify(inproc.requestsBetween(0), null, 2)).catch(() => {});
  await cp(join(rp.dirs.data, "traces"), join(artifacts, "traces"), { recursive: true }).catch(() => {});
  await rp.close();
  site.close();
}

const summary = {
  case: "everyday-baseline", startedAt: startedAt.toISOString(), model: process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? (inprocModel ?? (daily ? "daily extension settings" : "daily config")), browser: daily ? "daily Chrome" : inprocModel ? "isolated headless, extension only" : "isolated headless",
  passed: results.filter((r) => r.outcome === "pass").length, total: results.length, results, traceCheck,
};

await writeFile(join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));

if (traceCheck) console.log(`traces\t${traceCheck.outcome}\tsessions=${traceCheck.sessions} lines=${traceCheck.lines}\t${traceCheck.reason ?? traceCheck.exportStatus}`);

console.log(`\n${summary.passed}/${summary.total} pass · ${artifacts}`);

await rp.remove();
