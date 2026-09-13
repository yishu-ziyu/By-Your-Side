/**
 * Live eval: MiniMax-M3 + isolated headless Chrome + independent page oracles.
 * Hard cap from ~/.sideagent/eval-budget.json. Does not touch daily Chrome.
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchIsolatedExtension, type IsolatedExtension } from "../acceptance/isolated-extension.mts";
import { ConversationManager } from "../../agent/src/conversation-manager.js";
import { ConversationStore } from "../../agent/src/conversation-store.js";
import { createConversationRuntime } from "../../agent/src/conversation-runtime.js";
import type { ClientMessage, PageContext, ServerMessage } from "../../shared/protocol.js";
import { DEFAULT_BUDGET_FILE, assertWithinBudget, loadBudget, loadSpend, recordSpend, remaining } from "./lib/budget.js";
import { REPO_ROOT } from "./lib/verify.js";

const MODEL = "minimax-cn/MiniMax-M3";
const TIMEOUT_MS = 180_000;
const COST_PER_CALL_USD = 0.04;
const ACTION_TOOLS = new Set([
  "click", "fill", "type_text", "press_key", "scroll", "navigate", "open_tab", "switch_tab", "close_tab",
  "page_operation", "js", "mark", "clear_marks", "hover",
]);

export type Family = "read" | "form" | "multi";
export interface Template {
  id: string;
  family: Family;
  title: string;
  html: string;
  task: string;
  followup?: string;
  verify: string;
  expectDelivery?: string;
}

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>评测夹具</title><style>body{font:18px sans-serif;padding:24px}label,input,button,select,textarea{display:block;margin:8px 0}</style>${body}`;

export const TEMPLATES: Template[] = [
  { id: "pause-video", family: "form", title: "周末海边", html: page(`<h1>周末海边</h1><video id="movie" controls autoplay loop muted src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA="></video>`), task: "把视频暂停", verify: "const v=document.querySelector('video');return {ok:!!v&&v.paused,detail:v?String(v.paused):'no video'}" },
  { id: "read-h1", family: "read", title: "竹海工作坊", html: page(`<h1>竹海工作坊</h1><p>活动邀请。</p>`), task: "这个页面的主标题是什么？", verify: "return {ok:true,detail:document.querySelector('h1')?.textContent??''}", expectDelivery: "竹海工作坊" },
  { id: "count-list", family: "read", title: "客户列表", html: page(`<h1>客户</h1><ul id="list"><li>安</li><li>柏</li><li>曹</li><li>邓</li><li>冯</li></ul>`), task: "列表里有几位客户？", verify: "return {ok:true,detail:String(document.querySelectorAll('#list li').length)}", expectDelivery: "5" },
  { id: "read-price", family: "read", title: "商品", html: page(`<h1>帆布包</h1><p>价格 <span id="price">¥128</span></p>`), task: "这个商品多少钱？", verify: "return {ok:true,detail:document.getElementById('price')?.textContent??''}", expectDelivery: "128" },
  { id: "read-comment", family: "read", title: "评论", html: page(`<h1>视频评论</h1><article id="c1">今天海风很舒服。</article><article>第二条不相关。</article>`), task: "第一条评论写了什么？", verify: "return {ok:true,detail:document.getElementById('c1')?.textContent??''}", expectDelivery: "海风" },
  { id: "read-checked", family: "read", title: "条款", html: page(`<h1>条款</h1><label><input id="agree" type="checkbox" checked> 已同意</label>`), task: "同意条款的勾选现在是开还是关？", verify: "return {ok:true,detail:String((document.getElementById('agree')).checked)}", expectDelivery: "开" },
  { id: "read-href", family: "read", title: "下载", html: page(`<h1>下载</h1><a id="dl" href="/files/report-2026.csv">报表</a>`), task: "下载链接指向哪个路径？", verify: "return {ok:true,detail:(document.getElementById('dl')).getAttribute('href')??''}", expectDelivery: "report-2026.csv" },
  { id: "read-table", family: "read", title: "订单", html: page(`<h1>订单</h1><table><tr><th>编号</th><th>状态</th></tr><tr><td>A-9</td><td id="st">待发货</td></tr></table>`), task: "第一笔订单的状态是什么？", verify: "return {ok:true,detail:document.getElementById('st')?.textContent??''}", expectDelivery: "待发货" },
  { id: "read-excerpt", family: "read", title: "文章", html: page(`<h1>手记</h1><p id="body">傍晚的堤岸有人在放风筝，海风把线拉直。</p>`), task: "正文里有没有提到风筝？", verify: "return {ok:true,detail:document.getElementById('body')?.textContent??''}", expectDelivery: "风筝" },
  { id: "read-paused-start", family: "read", title: "片场", html: page(`<h1>片场</h1><video id="movie" controls muted src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA="></video>`), task: "视频现在是播放还是暂停？", verify: "const v=document.querySelector('video');return {ok:true,detail:v&&v.paused?'paused':'playing'}", expectDelivery: "暂停" },
  { id: "fill-name", family: "form", title: "登记", html: page(`<h1>登记</h1><input id="name" name="name">`), task: "把姓名填成「林夏」。", verify: "return {ok:(document.getElementById('name')).value==='林夏',detail:(document.getElementById('name')).value}" },
  { id: "fill-email", family: "form", title: "邮箱", html: page(`<h1>邮箱</h1><input id="email" type="email">`), task: "把邮箱填成 test@example.com", verify: "return {ok:(document.getElementById('email')).value==='test@example.com',detail:(document.getElementById('email')).value}" },
  { id: "fill-three", family: "form", title: "三字段", html: page(`<h1>资料</h1><input id="a" placeholder="城市"><input id="b" placeholder="街道"><input id="c" placeholder="门牌">`), task: "城市填杭州，街道填湖滨，门牌填12号。", verify: "const a=(document.getElementById('a')).value,b=(document.getElementById('b')).value,c=(document.getElementById('c')).value;return {ok:a.includes('杭州')&&b.includes('湖滨')&&c.includes('12'),detail:a+'|'+b+'|'+c}" },
  { id: "check-agree", family: "form", title: "勾选", html: page(`<h1>勾选</h1><input id="agree" type="checkbox">`), task: "勾选同意框。", verify: "return {ok:(document.getElementById('agree')).checked===true,detail:String((document.getElementById('agree')).checked)}" },
  { id: "uncheck-agree", family: "form", title: "取消勾选", html: page(`<h1>取消</h1><input id="agree" type="checkbox" checked>`), task: "取消勾选同意框。", verify: "return {ok:(document.getElementById('agree')).checked===false,detail:String((document.getElementById('agree')).checked)}" },
  { id: "fill-note", family: "form", title: "备注", html: page(`<h1>备注</h1><textarea id="note"></textarea>`), task: "备注写成「周五取件」。", verify: "return {ok:(document.getElementById('note')).value.includes('周五'),detail:(document.getElementById('note')).value}" },
  { id: "select-city", family: "form", title: "城市", html: page(`<h1>城市</h1><select id="city"><option value="">请选择</option><option value="hz">杭州</option><option value="sh">上海</option></select>`), task: "城市选杭州。", verify: "return {ok:(document.getElementById('city')).value==='hz',detail:(document.getElementById('city')).value}" },
  { id: "fill-search", family: "form", title: "搜索", html: page(`<h1>搜索</h1><input id="q">`), task: "搜索框填「帆布包」。", verify: "return {ok:(document.getElementById('q')).value.includes('帆布包'),detail:(document.getElementById('q')).value}" },
  { id: "fill-twelve", family: "form", title: "十二栏", html: page(`<h1>表格</h1>${Array.from({ length: 12 }, (_, i) => `<input id="f${i}" placeholder="栏${i + 1}">`).join("")}`), task: "把 12 个输入框按顺序填成 1 到 12。", verify: "const vals=Array.from({length:12},(_,i)=>(document.getElementById('f'+i)).value.trim());return {ok:vals.every((v,i)=>v===(i+1).toString()),detail:vals.join(',')}" },
  { id: "read-comment-count", family: "read", title: "评论数", html: page(`<h1>评论</h1><article>一</article><article>二</article>`), task: "这一页有几条评论？", verify: "return {ok:true,detail:String(document.querySelectorAll('article').length)}", expectDelivery: "2" },
  { id: "pause-then-comment", family: "multi", title: "暂停并读评", html: page(`<h1>周末海边</h1><video id="movie" controls autoplay loop muted src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA="></video><article id="c1">今天海风很舒服。</article>`), task: "先把视频暂停，再告诉我第一条评论写了什么。", verify: "const v=document.querySelector('video');return {ok:!!v&&v.paused,detail:(v&&v.paused?'paused':'playing')+'|'+(document.getElementById('c1')?.textContent??'')}", expectDelivery: "海风" },
  { id: "fill-then-save", family: "multi", title: "保存", html: page(`<h1>保存</h1><input id="name"><button id="save" type="button">保存</button><p id="st"></p><script>document.getElementById('save').onclick=()=>{document.getElementById('st').dataset.saved=document.getElementById('name').value;document.getElementById('st').textContent='已保存';}</script>`), task: "姓名填「林夏」然后点保存。", verify: "return {ok:document.getElementById('st')?.dataset.saved==='林夏',detail:(document.getElementById('st')?.dataset.saved??'')+'|'+(document.getElementById('st')?.textContent??'')}" },
  { id: "click-second", family: "multi", title: "条目", html: page(`<h1 id="head">条目</h1><button id="one" type="button">甲</button><button id="two" type="button">乙</button><script>document.getElementById('two').onclick=()=>document.getElementById('head').textContent='乙详情';</script>`), task: "打开乙这一条。", verify: "return {ok:document.getElementById('head')?.textContent==='乙详情',detail:document.getElementById('head')?.textContent??''}" },
  { id: "next-page", family: "multi", title: "翻页", html: page(`<h1>目录</h1><p id="item">第一页：竹编</p><button id="next" type="button">下一页</button><script>document.getElementById('next').onclick=()=>document.getElementById('item').textContent='第二页：藤椅';</script>`), task: "翻到下一页，告诉我这一页的标题。", verify: "return {ok:document.getElementById('item')?.textContent?.includes('藤椅')===true,detail:document.getElementById('item')?.textContent??''}", expectDelivery: "藤椅" },
  { id: "three-pages", family: "multi", title: "三页", html: page(`<h1>名录</h1><p id="item" data-page="1">第1页：安</p><button id="next" type="button">下一页</button><script>let p=1;const pages={1:'第1页：安',2:'第2页：（空）',3:'第3页：曹'};document.getElementById('next').onclick=()=>{p=Math.min(3,p+1);const el=document.getElementById('item');el.dataset.page=String(p);el.textContent=pages[p];}</script>`), task: "依次翻完三页，列出每一页的名字；第二页是空的，结果必须标明这一页不完整，不能说全部成功。", verify: "return {ok:document.getElementById('item')?.dataset.page==='3',detail:document.getElementById('item')?.textContent??''}", expectDelivery: "空" },
  { id: "revise-email", family: "multi", title: "改邮箱", html: page(`<h1>联系</h1><input id="email" value="">`), task: "邮箱先填 old@example.com", followup: "改成 new@example.com，然后继续。", verify: "return {ok:(document.getElementById('email')).value==='new@example.com',detail:(document.getElementById('email')).value}" },
  { id: "open-details", family: "multi", title: "详情", html: page(`<h1>详情</h1><button id="open" type="button">展开</button><p id="hid" hidden>内部编号 ZX-44</p><script>document.getElementById('open').onclick=()=>document.getElementById('hid').hidden=false;</script>`), task: "展开详情并告诉我内部编号。", verify: "return {ok:document.getElementById('hid')?.hidden===false,detail:document.getElementById('hid')?.textContent??''}", expectDelivery: "ZX-44" },
  { id: "add-row", family: "multi", title: "加一行", html: page(`<h1>清单</h1><ul id="list"><li>原有</li></ul><button id="add" type="button">添加</button><script>document.getElementById('add').onclick=()=>{const li=document.createElement('li');li.textContent='新项';document.getElementById('list').append(li);}</script>`), task: "添加一行，然后告诉我现在有几条。", verify: "return {ok:document.querySelectorAll('#list li').length===2,detail:String(document.querySelectorAll('#list li').length)}", expectDelivery: "2" },
  { id: "filter-count", family: "multi", title: "筛选", html: page(`<h1>筛选</h1><input id="f"><ul id="list"><li data-k="a">苹果</li><li data-k="b">香蕉</li><li data-k="a">杏</li></ul><script>document.getElementById('f').addEventListener('input',()=>{const q=document.getElementById('f').value;for(const li of document.querySelectorAll('#list li'))li.hidden=q&&!li.textContent.includes(q);})</script>`), task: "筛选「杏」，告诉我还剩几条可见。", verify: "return {ok:[...document.querySelectorAll('#list li')].filter(li=>!li.hidden).length===1,detail:String([...document.querySelectorAll('#list li')].filter(li=>!li.hidden).length)}", expectDelivery: "1" },
  { id: "two-step-date", family: "multi", title: "改期", html: page(`<h1>预约</h1><input id="date" placeholder="日期">`), task: "日期填周四", followup: "改成周五，然后继续。", verify: "return {ok:(document.getElementById('date')).value.includes('周五'),detail:(document.getElementById('date')).value}" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string, fallback: string): string {
  const flag = process.argv.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : fallback;
}

export async function runLiveSuite(): Promise<{ ok: boolean; runId: string; path: string }> {
  const replicas = Math.max(1, Number(arg("--replicas", "5")) || 5);
  const budget = loadBudget(DEFAULT_BUDGET_FILE);
  const runId = `live-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outDir = join(REPO_ROOT, "eval", "runs", runId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "templates.json"), JSON.stringify(TEMPLATES.map((t) => ({ id: t.id, family: t.family, task: t.task })), null, 2));

  const htmlById = new Map(TEMPLATES.map((t) => [t.id, t.html]));
  const server: Server = createServer((req, res) => {
    const id = new URL(req.url ?? "/", "http://local").searchParams.get("t") ?? "";
    const html = htmlById.get(id) ?? page("<p>unknown</p>");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const iso = await launchIsolatedExtension();
  const rows: Record<string, unknown>[] = [];
  let stopped: string | null = null;

  const work: Array<{ template: Template; replica: number }> = [];
  for (let replica = 1; replica <= replicas; replica += 1) {
    for (const template of TEMPLATES) work.push({ template, replica });
  }

  try {
    for (const { template, replica } of work) {
      try {
        assertWithinBudget(budget, loadSpend());
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
        break;
      }
      let row: Record<string, unknown>;
      try {
        row = await runOne(iso, origin, template, replica, join(outDir, `${template.id}-${replica}`));
      } catch (error) {
        row = {
          id: template.id,
          family: template.family,
          replica,
          ok: false,
          pageOk: false,
          deliveryOk: false,
          reason: error instanceof Error ? error.message : String(error),
          modelCalls: 0,
          totalMs: 0,
        };
      }
      rows.push(row);
      const calls = Number(row.modelCalls ?? 0);
      try {
        recordSpend({ model_calls: calls, cost: calls * COST_PER_CALL_USD, note: `${template.id}#${replica}` });
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
        break;
      }
      writeFileSync(join(outDir, "progress.json"), JSON.stringify({ runId, done: rows.length, total: work.length, stopped, remaining: remaining(budget, loadSpend()) }, null, 2));
      console.log(JSON.stringify({ id: template.id, replica, ok: row.ok, modelCalls: row.modelCalls, totalMs: row.totalMs, reason: row.reason }));
    }
  } finally {
    await iso.close().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
  }

  const byFamily = (family: Family) => rows.filter((r) => r.family === family);
  const rate = (list: Record<string, unknown>[]) => (list.length ? list.filter((r) => r.ok === true).length / list.length : null);
  const summary = {
    runId,
    model: MODEL,
    replicas,
    n: rows.length,
    firstFailure: rows.find((r) => r.ok !== true) ?? null,
    overall: rate(rows),
    read: rate(byFamily("read")),
    form: rate(byFamily("form")),
    multi: rate(byFamily("multi")),
    stopped,
    spend: loadSpend(),
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ summary, rows }, null, 2));
  return { ok: stopped === null && rows.length === work.length, runId, path: outDir };
}

async function runOne(iso: IsolatedExtension, origin: string, template: Template, replica: number, out: string): Promise<Record<string, unknown>> {
  mkdirSync(out, { recursive: true });
  const cid = `${template.id}-${replica}-${Date.now()}`;
  const store = new ConversationStore(join(out, "conversations"));
  const messages: ServerMessage[] = [];
  const bridge = new Set<Promise<unknown>>();
  let manager!: ConversationManager;
  const emit = (message: ServerMessage): void => {
    messages.push(message);
    if (message.type !== "tool_call") return;
    const sessionId = message.sessionId ?? "main";
    const job = (iso.swEval(
      `globalThis.__saCall(${JSON.stringify(`${cid}-${message.id}`)}, ${JSON.stringify(message.name)}, ${JSON.stringify(message.params)}, ${JSON.stringify(sessionId)}, ${JSON.stringify((message as { programId?: string }).programId ?? null)}, ${JSON.stringify(cid)})`,
      60_000,
    ) as Promise<{ ok?: boolean; data?: unknown; error?: string; executionFact?: "not_executed" | "unknown" | "executed" }>)
      .then((reply) => manager.handleMessage({
        type: "tool_result",
        conversationId: message.conversationId ?? cid,
        id: message.id,
        ok: reply?.ok === true,
        ...(reply?.ok === true ? { data: reply.data } : { error: String(reply?.error ?? "tool failed") }),
        ...(reply?.executionFact ? { executionFact: reply.executionFact } : {}),
      } as ClientMessage))
      .catch((error) => manager.handleMessage({
        type: "tool_result", conversationId: message.conversationId ?? cid, id: message.id, ok: false, error: String(error),
      } as ClientMessage));
    bridge.add(job);
    void job.finally(() => bridge.delete(job));
  };
  manager = new ConversationManager(
    (id, emitServer, summary) => createConversationRuntime(id, emitServer, MODEL, { sessionManager: store.sessionManager(id), mode: summary?.mode }),
    emit,
    store,
  );
  const entry = await manager.ensureDefault();
  if (!entry.runtime.session.available) throw new Error("模型会话不可用");
  let seq = 0;
  const call = (name: string, params: Record<string, unknown>) =>
    iso.swEval(`globalThis.__saCall(${JSON.stringify(`${cid}-setup-${++seq}`)}, ${JSON.stringify(name)}, ${JSON.stringify(params)}, "main", undefined, ${JSON.stringify(cid)})`, 60_000) as Promise<{ ok?: boolean; data?: { tabId?: number }; error?: string }>;
  const url = `${origin}/?t=${template.id}`;
  const opened = await call("open_tab", { url });
  const tabId = opened?.data?.tabId;
  if (opened?.ok !== true || typeof tabId !== "number") throw new Error(`open_tab 失败：${JSON.stringify(opened)}`);
  await call("switch_tab", { tabId });
  await iso.swEval(`chrome.tabs.update(${tabId},{active:true}).catch(()=>{})`).catch(() => {});
  if (template.id.includes("video") || template.html.includes("<video")) {
    for (let n = 0; n < 20; n += 1) {
      await iso.swEval(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>{const v=document.querySelector('video');if(!v)return;v.muted=true;return v.play().catch(()=>{});}})`).catch(() => {});
      await sleep(150);
    }
  }
  const context: PageContext = { tabId, url, title: template.title };
  const startedAt = Date.now();
  await manager.handleMessage({ type: "user_message", text: template.task, context } as ClientMessage);
  const waitIdle = async (): Promise<void> => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const runtime = manager.get("default")?.runtime;
      const running = runtime?.session.isStreaming() === true || Boolean(runtime?.fleet.size);
      const ended = messages.some((m) => m.type === "agent_event" && m.event.kind === "agent_end");
      const erred = messages.some((m) => m.type === "agent_event" && m.event.kind === "error");
      if (!running && (ended || erred) && bridge.size === 0) {
        if (erred) return;
        const makeupDeadline = Date.now() + 12_000;
        while (Date.now() < makeupDeadline) {
          const snap = manager.getTaskProgress("default");
          const kind = snap?.conversationContext?.latestDelivery?.kind;
          if (kind === "finding" || kind === "reply") return;
          const notice = messages.some((m) => m.type === "agent_event" && m.event.kind === "notice" && String((m as { event?: { message?: string } }).event?.message ?? "").includes("正式回答还没有"));
          if (notice) return;
          await sleep(150);
        }
        return;
      }
      await sleep(150);
    }
  };
  await waitIdle();
  if (template.followup) {
    await manager.handleMessage({ type: "user_message", text: template.followup, context } as ClientMessage);
    await waitIdle();
  }
  await sleep(400);
  const oracle = await iso.swEval(
    `chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:new Function(${JSON.stringify(`${template.verify}`)})}).then(r=>r[0].result).catch(e=>({ok:false,detail:String(e)}))`,
    15_000,
  ) as { ok?: boolean; detail?: string };
  const deliveries = messages
    .filter((m) => m.type === "agent_event" && m.event.kind === "user_delivery")
    .map((m) => (m as { event: { delivery?: { kind?: string; text?: string } } }).event.delivery)
    .filter((d) => d && d.kind !== "ack");
  const deliveryText = deliveries.map((d) => d?.text ?? "").join("\n");
  const deliveryOk = template.expectDelivery ? deliveryText.includes(template.expectDelivery) : deliveries.length >= 1;
  const modelCalls = messages.filter((m) => m.type === "agent_event" && m.event.kind === "turn_start").length;
  const firstAction = messages.find((m) => m.type === "tool_call" && ACTION_TOOLS.has((m as { name: string }).name));
  const ok = oracle?.ok === true && deliveryOk;
  const row = {
    id: template.id,
    family: template.family,
    replica,
    ok,
    pageOk: oracle?.ok === true,
    deliveryOk,
    reason: ok ? "pass" : `page=${oracle?.ok} delivery=${deliveryOk} detail=${oracle?.detail ?? ""}`,
    modelCalls,
    totalMs: Date.now() - startedAt,
    deliveryText: deliveryText.slice(0, 500),
    pageDetail: oracle?.detail ?? "",
    tools: messages.filter((m) => m.type === "tool_call").map((m) => (m as { name: string }).name),
    firstAction: firstAction ? (firstAction as { name: string }).name : null,
  };
  writeFileSync(join(out, "run.json"), JSON.stringify(row, null, 2));
  entry.runtime.dispose();
  await iso.swEval(`chrome.tabs.remove(${tabId}).catch(()=>{})`).catch(() => {});
  return row;
}


