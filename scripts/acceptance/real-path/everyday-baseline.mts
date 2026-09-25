/**
 * 日常请求底线：10 条取自真实使用记录的请求，逐条在新会话里发出，只看用户看得到的结果。
 *
 *   npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless [--model=provider/id] [--only=hello,math]
 *   npx tsx scripts/acceptance/real-path/everyday-baseline.mts --daily [--only=...]   # 用户已开的日常 Chrome（9222），需用户同意
 *   npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless --inproc=stepfun/step-3.7-flash   # 只装扩展，设置页配模型
 *   npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless --inproc=stepfun/step-3.7-flash --suite=sitegeist   # Sitegeist 宣传的 5 类任务
 *
 * --inproc 时每条另记扩展内 agent 发出的模型请求（地址、首字节、结束），并判定请求都发往所选服务商。
 *
 * 每条记录：是否出现回答、首字出现耗时、整轮结束耗时、侧栏里回答之外的杂项数（提示、错误、回执、任务卡、续做入口），
 * 以及该条的结果判据（答案内容、页面圈画、新标签页、草稿框原文且未保存）。练习页全在本机，不碰真实账号。
 */
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { REPO, attachDailyChrome, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc, type InprocRequest } from "./harness.mts";
import { configureViaSettings, loadModelPlan, type ModelPlan } from "./inproc-config.mts";

const daily = process.argv.includes("--daily");

/** --inproc=provider/id：不注册伴随进程，从设置页配置这个模型。 */
const inprocModel = process.argv.find((a) => a.startsWith("--inproc="))?.slice(9);

/** --suite=sitegeist：换成 Sitegeist 官网与新手教程里宣传的任务（多页汇总、导出表格、改错字、提取会议、做小工具）。 */
const suite = process.argv.find((a) => a.startsWith("--suite="))?.slice(8) === "sitegeist" ? "sitegeist" : "everyday";

if (!daily) requireHeadless();

const CASE_LIMIT_MS = 240_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-everyday-baseline${suite === "sitegeist" ? "-sitegeist" : ""}${daily ? "-daily" : inprocModel ? "-inproc" : ""}`);

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
  "/companies": page("三家候选供应商", `<main><h1>三家候选供应商</h1><p>详细资料在各自页面。</p>
<ul><li><a href="/company/lumen">Lumen 光子</a></li><li><a href="/company/harbor">Harbor 港湾</a></li><li><a href="/company/kite">Kite 风筝</a></li></ul></main>`),
  "/company/lumen": page("Lumen 光子", `<main><h1>Lumen 光子</h1><p>成立于 2016 年，总部在苏州，目前员工 120 人。</p></main>`),
  "/company/harbor": page("Harbor 港湾", `<main><h1>Harbor 港湾</h1><p>成立于 2019 年，总部在厦门，目前员工 45 人。</p></main>`),
  "/company/kite": page("Kite 风筝", `<main><h1>Kite 风筝</h1><p>成立于 2012 年，总部在成都，目前员工 310 人。</p></main>`),
  "/products": page("家居小物", `<main><h1>家居小物</h1><table><thead><tr><th>商品</th><th>价格</th></tr></thead><tbody>
<tr><td>竹纤维毛巾</td><td>¥39</td></tr><tr><td>陶瓷马克杯</td><td>¥58</td></tr><tr><td>亚麻抱枕套</td><td>¥89</td></tr><tr><td>香薰蜡烛</td><td>¥66</td></tr></tbody></table></main>`),
  "/compose": page("写通知", `<main><h1>写通知</h1><form method="post" action="/save"><textarea id="draft" name="draft" rows="4" cols="60" aria-label="通知草稿">各位好：我们明天下午三点在会议是开会，讨论新版本的上线计画，请大家准时参加，不要迟道。</textarea>
<button type="submit" id="save">发送</button></form></main>`),
  "/chat": page("新版本群", `<main><h1>新版本群</h1><ul>
<li><b>小林</b>：下周三下午两点半碰一下新版本的事？</li>
<li><b>阿杰</b>：可以，地点就定望京 SOHO T3 12 层的小会议室吧</li>
<li><b>我</b>：好，那就 10 月 8 日（周三）14:30，小林、阿杰和我三个人</li></ul></main>`),
  "/recipe": page("巧克力曲奇", `<main><h1>巧克力曲奇（24 块）</h1><ul><li>黄油 115 克</li><li>红糖 100 克</li><li>白砂糖 50 克</li><li>鸡蛋 1 个</li><li>面粉 190 克</li><li>巧克力豆 170 克</li></ul></main>`),
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

type Box = { x: number; y: number; w: number; h: number };

/** 页面上一个标注的外框和名牌（视口坐标）；文字框取页面每个文字节点的行框。 */
type DrawnMark = { frame: Box; label: Box | null };

type TextBox = Box & { text: string };

type Ctx = { answer: string; pageText: string; marks: DrawnMark[]; texts: TextBox[]; draft: string | null; tabs: string[]; saves: number; files: Array<{ name: string; text: string }> };

type Case = { id: string; path: string; prompt: string; check: (c: Ctx) => string | null };

const has = (text: string, ...needles: string[]) => needles.every((n) => text.includes(n));

const contains = (outer: Box, inner: Box) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;

const overlaps = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;

/** 圈「名称 + 数值」：一个框同时盖住两者，任何名牌都不压页面文字。 */
function checkPairMark(c: Ctx, name: string, value: string): string | null {
  if (c.marks.length === 0) return "页面上没有圈画";
  const nameBox = c.texts.find((t) => t.text === name);
  const valueBox = c.texts.find((t) => t.text === value);

  if (!nameBox || !valueBox) return `页面上找不到「${name}」或「${value}」`;

  if (!c.marks.some((m) => contains(m.frame, nameBox) && contains(m.frame, valueBox))) return `没有一个框同时圈住「${name}」和「${value}」`;
  const covered = c.marks.flatMap((m) => (m.label ? c.texts.filter((t) => overlaps(m.label!, t)).map((t) => t.text) : []));

  return covered.length ? `名牌压住了页面文字：${covered.join("、")}` : null;
}

const CASES: Case[] = [
  { id: "hello", path: "/article", prompt: "你好", check: (c) => (c.answer ? null : "没有回答") },
  { id: "math", path: "/article", prompt: "1+1等于几啊？", check: (c) => (/2|二/.test(c.answer) ? null : "回答里没有 2") },
  { id: "upset", path: "/article", prompt: "好烦", check: (c) => (c.answer ? null : "没有回答") },
  { id: "page-gist", path: "/article", prompt: "这篇文章的核心观点是什么？", check: (c) => (has(c.answer, "新人") ? null : "没提到新人成长这一核心观点") },
  { id: "page-fields", path: "/job", prompt: "这个岗位叫什么？在哪个城市？只回答这两项，不要操作网页。", check: (c) => (has(c.answer, "前端", "杭州") ? null : "缺岗位名或城市") },
  { id: "three-repos", path: "/projects", prompt: "找到这三个项目的 GitHub 仓库地址。", check: (c) => (has(c.answer, "alpha-kit", "beta-flow", "gamma-db") ? null : "三个仓库没有全部给出") },
  { id: "translate", path: "/en", prompt: "把这个页面翻译成中文。", check: (c) => ((c.pageText.match(/[一-鿿]/g) ?? []).length >= 20 ? null : "页面上没有出现中文译文") },
  { id: "mark", path: "/quota", prompt: "在页面上圈出五小时用量。", check: (c) => checkPairMark(c, "五小时用量", "32%") },
  { id: "open-tab", path: "/article", prompt: `在新标签页打开 ${origin}/job`, check: (c) => (c.tabs.some((u) => u.startsWith(`${origin}/job`)) ? null : "没有打开新标签页") },
  { id: "copy-no-save", path: "/note", prompt: "把蓝色 Note 框里的第一句英文原文复制到下面的草稿框里，不要保存。",
    check: (c) => (c.saves > 0 ? "点了保存" : c.draft?.trim() === NOTE_FIRST ? null : `草稿框内容不对：${JSON.stringify(c.draft)}`) },
];

const flat = (text: string) => text.replace(/\s+/g, "");

/** Sitegeist 宣传的任务，全部换成本机练习页；判据只看用户拿到的结果。 */
const SITEGEIST_CASES: Case[] = [
  { id: "research", path: "/companies", prompt: "打开这页列出的三家公司，把每家的成立年份、城市和员工人数整理成一张表，每行注明来源网址。",
    check: (c) => {
      const missing = ["2016", "苏州", "120", "2019", "厦门", "45", "2012", "成都", "310", "/company/lumen", "/company/harbor", "/company/kite"].filter((n) => !c.answer.includes(n));

      return missing.length ? `回答缺少：${missing.join("、")}` : null;
    } },
  { id: "export-csv", path: "/products", prompt: "把这页的商品名称和价格导出成 CSV 文件下载给我。",
    check: (c) => {
      const csv = c.files.find((f) => f.name.toLowerCase().endsWith(".csv"));

      if (!csv) return `没有下载到 CSV（下载了：${c.files.map((f) => f.name).join("、") || "无"}）`;
      const missing = ["竹纤维毛巾", "陶瓷马克杯", "亚麻抱枕套", "香薰蜡烛", "39", "58", "89", "66"].filter((n) => !csv.text.includes(n));

      return missing.length ? `CSV 缺少：${missing.join("、")}` : null;
    } },
  { id: "fix-typos", path: "/compose", prompt: "帮我把草稿框里的错别字改好，其他字不要动，不要发送。",
    check: (c) => (c.saves > 0 ? "点了发送" : c.draft === "各位好：我们明天下午三点在会议室开会，讨论新版本的上线计划，请大家准时参加，不要迟到。" ? null : `草稿框内容不对：${JSON.stringify(c.draft)}`) },
  { id: "meeting", path: "/chat", prompt: "从这段聊天里整理出会议的日期、时间、地点和参会人。",
    check: (c) => {
      const a = flat(c.answer);
      const missing = [["10月8日"], ["14:30", "两点半", "2:30"], ["望京SOHOT3"], ["12层"], ["小林"], ["阿杰"]].flatMap((alts) => (alts.some((n) => a.includes(n)) ? [] : [alts[0]]));

      return missing.length ? `回答缺少：${missing.join("、")}` : null;
    } },
  { id: "calculator", path: "/recipe", prompt: "根据这页的配方做一个小工具：我输入想做几块饼干，它自动换算每样用料。",
    check: (c) => (c.files.some((f) => /\.html?$/i.test(f.name) && /<input/i.test(f.text)) || /<input/i.test(c.answer) || c.tabs.some((u) => !u.startsWith(origin) && !u.startsWith("about:") && !u.startsWith("chrome"))
      ? null : "没有生成可输入份数的小工具（无 HTML 文件、回答里无输入框、也没新开页面）") },
];

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");

const pool = suite === "sitegeist" ? SITEGEIST_CASES : CASES;

const selected = only ? pool.filter((c) => only.includes(c.id)) : pool;

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

type DomNode = { nodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

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

  const boxOf = async (nodeId: number): Promise<Box | null> => {
    // SAFETY: CDP 规范里 DOM.getBoxModel 返回 { model: { border: Quad } }，Quad 为 4 个点 8 个数。
    const { model } = (await rp.cdp.send("DOM.getBoxModel", { nodeId }, work)) as { model: { border: number[] } };
    const xs = [0, 2, 4, 6].map((i) => model.border[i]!);
    const ys = [1, 3, 5, 7].map((i) => model.border[i]!);

    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };

  /** 标注画在扩展的封闭 shadow root 里，页面脚本看不到；用 CDP 穿透读外框和名牌。 */
  const readMarks = async (): Promise<DrawnMark[]> => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const { root } = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)) as { root: DomNode };
    const found: Array<{ frame: number; label: number | null }> = [];

    const classOf = (node: DomNode) => {
      const attrs = node.attributes ?? [];
      const at = attrs.indexOf("class");

      return at >= 0 ? attrs[at + 1] ?? "" : "";
    };

    const walk = (node: DomNode) => {
      if (/(^|\s)mark(\s|$)/.test(classOf(node))) {
        found.push({ frame: node.nodeId, label: node.children?.find((c) => /(^|\s)mark-label(\s|$)/.test(classOf(c)))?.nodeId ?? null });
      }

      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };

    walk(root);
    const drawn: DrawnMark[] = [];

    for (const f of found) {
      const frame = await boxOf(f.frame);

      if (frame) drawn.push({ frame, label: f.label === null ? null : await boxOf(f.label) });
    }

    return drawn;
  };

  // SAFETY: 下面这段页面脚本只返回 { text, x, y, w, h } 数组，字段与 TextBox 一致。
  const readTexts = async (): Promise<TextBox[]> => (await rp.evaluate(work, `(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim();
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width && r.height) out.push({ text, x: r.x, y: r.y, w: r.width, h: r.height });
    }
    return out;
  })()`)) as TextBox[];

  for (const item of selected) {
    saveRequests = 0;
    // 每条用例单独一个下载目录：判据只看这一条下载了什么。
    const caseDownloads = join(artifacts, `downloads-${item.id}`);

    await mkdir(caseDownloads, { recursive: true });
    await rp.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: caseDownloads });
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
    const downloaded = (await readdir(caseDownloads)).filter((name) => !name.endsWith(".crdownload"));
    const files = await Promise.all(downloaded.map(async (name) => ({ name, text: await readFile(join(caseDownloads, name), "utf8").catch(() => "") })));
    const ctx: Ctx = { answer, pageText, marks: await readMarks().catch(() => []), texts: await readTexts().catch(() => []), draft: draftValue == null ? null : String(draftValue), tabs, saves: saveRequests, files };
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
