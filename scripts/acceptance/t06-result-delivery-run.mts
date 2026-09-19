/**
 * T06 统一成果、依据和未完成项交付 —— 真实隔离验收。
 *
 * 复用 T01 运行器（真实生产 ConversationManager、真实侧栏入口、真实模型、夹具页面）与 T01 oracle：
 *   R01 读查取事实+来源 / C01 三页面比较+来源 / A01 填四字段不提交 / C04 一个来源被登录墙挡住 / R03 运行中改显示
 * 每臂 T06 追加检查（不读助手摘要）：
 *   - 正式交付带宿主事实链（outcome / 已满足项 / 未完成项 / 本 run 真实读到的页面）；
 *   - 未完成项能对回宿主账本，来源是本臂真实打开的页面且 HTTP 可取；
 *   - 面板里结果正文与来源/未完成项真实可见，过程块默认收起，且没有实际不支持的导出入口；
 *   - A01 同时用页面探针与服务端写入日志核对（页面值与提交次数，不看助手怎么说）。
 * 全部臂结束后在同一真实面板里做重放/修订/晚到流检查与 50 次呈现时序采样（脚本化输入，
 * 经过真实面板接收路径；计时起点是面板收到交付信封，不含模型与网络）。
 *
 *   npx --no-install tsx scripts/acceptance/t06-result-delivery-run.mts --headless [--material 0|1] [--report out/acceptance/<dir>]
 *
 * 退出码 0 = 所选范围全部检查通过（含 oracle 判定）；1 = 有检查失败或基础设施失败。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { loadConfig } from "../../agent/src/config.js";
import { DEFAULT_PORT } from "../../shared/protocol.js";
import { CASE_BY_ID } from "./product-journeys/cases.mjs";
import { createJourneyFixture } from "./product-journeys/fixtures.mjs";
import { runOne, startHost, stopHost, type HostHandle, type HostHolder } from "./product-journeys/runner.mjs";
import { launchIsolatedExtension, sleep, until, type IsolatedExtension } from "./isolated-extension.mts";
import { isUserDelivery, type UserDelivery } from "../../shared/voice.js";

if (!process.argv.includes("--headless")) throw new Error("需要显式 --headless：本驱动只允许无头隔离运行。");
const argOf = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const material = Number(argOf("--material", "0")) as 0 | 1;
const model = loadConfig().model ?? "(未配置)";
const outRoot = resolve(argOf("--report", `out/acceptance/${new Date().toISOString().replace(/[:.]/g, "-")}-t06`)!);
mkdirSync(outRoot, { recursive: true });

const ARMS = [
  { caseId: "R01", purpose: "读查：事实与来源" },
  { caseId: "C01", purpose: "比较：三页差异与来源" },
  { caseId: "A01", purpose: "填写：四字段不提交" },
  { caseId: "C04", purpose: "未完成：锁定来源与缺口" },
  { caseId: "R03", purpose: "修改：概括与显示结果都保留" },
  { caseId: "A02", purpose: "修改：填写期间改一个字段" },
] as const;
/** --case 只用于定点复跑（例如修完一条路径先跑 R01）；正式留证不带。 */
const onlyCases = argOf("--case");
const arms = onlyCases ? ARMS.filter((arm) => onlyCases.split(",").includes(arm.caseId)) : [...ARMS];
if (!arms.length) throw new Error(`未知 --case：${onlyCases}`);

type Check = { id: string; ok: boolean; detail: string; arm?: string };
type TraceEvent = { at: number; direction: string; message: Record<string, unknown> };
const checks: Check[] = [];
const check = (id: string, ok: boolean, detail = "", arm?: string): void => { checks.push({ id, ok, detail, ...(arm ? { arm } : {}) }); };

const fixture = createJourneyFixture();
await new Promise<void>((r) => fixture.server.listen(0, "127.0.0.1", r));
const events: TraceEvent[] = [];
const storeDir = join(outRoot, "host");
const holder: HostHolder = { current: await startHost(model, storeDir, events as never) };
let iso: IsolatedExtension | undefined;
let panel = "";
const timing: unknown[] = [];

const panelEval = <T,>(expression: string): Promise<T> => iso!.evalIn(panel, expression) as Promise<T>;

/**
 * 只开一个带验收钩子的面板。不能用 startIsolatedPanel 再关掉它：那会把后台↔host 的连接带回未恢复状态，
 * 真实任务动作会被拒收（实测教训："连接尚未恢复，原任务和待办已保留"）。
 */
async function startAcceptancePanel(host: HostHandle): Promise<{ iso: IsolatedExtension; panel: string }> {
  const iso = await launchIsolatedExtension();
  await iso.swEval(`globalThis.WebSocket=class extends WebSocket { constructor(url, protocols){super(url==='ws://127.0.0.1:${DEFAULT_PORT}'?'ws://127.0.0.1:${host.port}':url,protocols)} };`);
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(host.token)}})`);
  const id = (await iso.swEval("chrome.runtime.id")) as string;
  const panel = await iso.newTarget(`chrome-extension://${id}/sidepanel.html?acceptance=t06`);
  await until(async () => (await iso.evalIn(panel, "!!document.querySelector('#input')")) || undefined, 15_000, "acceptance panel input");
  await iso.evalIn(panel, "window.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
  await until(() => host.socket?.readyState === WebSocket.OPEN || undefined, 15_000, "host connected");
  return { iso, panel };
}

function deliveriesOf(armDir: string): UserDelivery[] {
  const rows = JSON.parse(readFileSync(join(armDir, "events.json"), "utf8")) as TraceEvent[];
  return rows
    .filter((row) => row.message.type === "agent_event" && (row.message.event as { kind?: string } | undefined)?.kind === "user_delivery")
    .map((row) => (row.message.event as { delivery: unknown }).delivery)
    .filter((delivery): delivery is UserDelivery => isUserDelivery(delivery) && (delivery.kind === "finding" || delivery.kind === "reply"));
}

function hitsOf(armDir: string): Record<string, number> {
  const run = JSON.parse(readFileSync(join(armDir, "run.json"), "utf8")) as { evidence: { hits: Record<string, number> } };
  return run.evidence.hits;
}

function conversationOf(armDir: string): string {
  const run = JSON.parse(readFileSync(join(armDir, "run.json"), "utf8")) as { evidence: { conversationId: string } };
  return run.evidence.conversationId;
}

interface PanelReport {
  deliveryId: string | null;
  text: string;
  visible: boolean;
  factHead: string | null;
  factDone: string | null;
  sources: { href: string | null; text: string; visible: boolean }[];
  remaining: string[];
  runOpen: boolean | null;
  runBeforeDelivery: boolean;
  exports: number;
  answerActions: number;
}
async function readPanel(deliveryId?: string): Promise<PanelReport> {
  const selector = deliveryId ? `#messages .msg.assistant.markdown[data-delivery-id=${JSON.stringify(deliveryId)}]` : "#messages .msg.assistant.markdown:last-of-type";
  return panelEval<PanelReport>(`(()=>{
    const bubbles=[...document.querySelectorAll('#messages .msg.assistant.markdown')];
    const last=document.querySelector(${JSON.stringify(selector)})??bubbles.at(-1)??null;
    const rect=last?last.getBoundingClientRect():null;
    const facts=last?last.querySelector('.delivery-facts'):null;
    const runBlock=document.querySelector('#messages .run-steps');
    return {
      deliveryId:last?.dataset.deliveryId??null,
      text:(last?.innerText??'').replace(/\\s+/g,' ').trim().slice(0,400),
      visible:!!last&&!!rect&&rect.width>0&&rect.height>0,
      factHead:facts?facts.querySelector('.delivery-facts-head')?.textContent??null:null,
      factDone:facts?facts.querySelector('.delivery-facts-done')?.textContent??null:null,
      sources:facts?[...facts.querySelectorAll('a.delivery-source')].map(a=>({href:a.getAttribute('href'),text:a.textContent||'',visible:a.getBoundingClientRect().width>0})):[],
      remaining:facts?[...facts.querySelectorAll('.delivery-facts-remaining li')].map(li=>li.textContent||''):[],
      runOpen:runBlock?(runBlock).open:null,
      runBeforeDelivery:!!(runBlock&&last)&&(runBlock.compareDocumentPosition(last)&Node.DOCUMENT_POSITION_FOLLOWING)!==0,
      exports:last?last.querySelectorAll('a[download],button[data-export],a[data-export]').length:0,
      answerActions:last?last.querySelectorAll('.answer-actions button').length:0,
    };
  })()`);
}

const start = Date.now();
let evaluatorOk = true;
const armResults: unknown[] = [];
try {
  const started = await startAcceptancePanel(holder.current);
  iso = started.iso;
  panel = started.panel;

  for (const arm of arms) {
    const jc = CASE_BY_ID.get(arm.caseId)!;
    const mat = jc.materials[material];
    const env = {
      iso, panel, fixture, host: holder, events: events as never, model, outRoot,
      restartHost: async () => {
        const token = holder.current.token;
        const port = holder.current.port;
        await stopHost(holder.current);
        holder.current = await startHost(model, storeDir, events as never, token, port);
        await iso!.evalIn(panel, "window.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
        await until(() => holder.current.socket?.readyState === WebSocket.OPEN || undefined, 30_000, "host reconnected");
      },
    };
    let verdict: { qualified: boolean; checks: { id: string; ok: boolean; detail: string }[] } | null = null;
    try {
      const result = await runOne(env, jc, mat);
      verdict = result.verdict;
    } catch (error) {
      evaluatorOk = false;
      check(`${arm.caseId}-runner`, false, `运行器异常：${error instanceof Error ? error.message : String(error)}`, arm.caseId);
      continue;
    }
    const armDir = join(outRoot, `${jc.caseId}-${mat.materialId}`);
    const failing = verdict.checks.filter((c) => !c.ok);
    check(`${arm.caseId}-oracle`, verdict.qualified, verdict.qualified ? "T01 oracle 合格" : failing.map((c) => `${c.id}:${c.detail}`).join(" | "), arm.caseId);
    armResults.push({ caseId: arm.caseId, purpose: arm.purpose, qualified: verdict.qualified, checks: verdict.checks });

    // ── T06：事实链 / 来源 / 未完成项 ──
    const deliveries = deliveriesOf(armDir);
    const finding = [...deliveries].reverse().find((d) => d.kind === "finding") ?? deliveries.at(-1) ?? null;
    if (!finding) {
      check(`${arm.caseId}-delivery-present`, false, "本臂没有正式交付记录", arm.caseId);
      continue;
    }
    check(`${arm.caseId}-delivery-facts`, !!finding.facts, finding.facts ? `outcome=${finding.facts.outcome}` : "正式交付缺事实链字段（旧形状）", arm.caseId);
    // 正文承认有卡点/未完成时，记录绝不能是 complete（漏项报完成 = 虚假完成）。
    const blocker = /没有完成|未完成|已停止重试|执行失败|未能|无法访问|打不开|卡在|卡点|登录墙/.test(finding.text);
    if (blocker) {
      check(`${arm.caseId}-no-fake-completion`, finding.facts?.outcome === "partial",
        finding.facts ? `正文有卡点，事实链 outcome=${finding.facts.outcome}` : "正文有卡点但没有事实链字段", arm.caseId);
    }
    if (finding.facts) {
      check(`${arm.caseId}-facts-outcome-consistent`, finding.facts.outcome !== "complete" || finding.facts.remaining.length === 0,
        `outcome=${finding.facts.outcome} remaining=${finding.facts.remaining.length}`, arm.caseId);
      const ledger = (holder.current.manager.getTaskProgress(conversationOf(armDir))?.results ?? []).map((item) => ({ id: item.id, description: item.description, status: item.status }));
      const mismatched = finding.facts.remaining.filter((item) => !ledger.some((entry) => entry.id === item.id && entry.description === item.description));
      check(`${arm.caseId}-remaining-matches-ledger`, mismatched.length === 0,
        mismatched.length ? `对不回账本：${JSON.stringify(mismatched)}` : `${finding.facts.remaining.length} 项未完成均来自宿主账本`, arm.caseId);
      const hits = hitsOf(armDir);
      const origin = fixture.origin;
      const foreign = finding.facts.sources.filter((source) => !source.url.startsWith(origin));
      const unread = finding.facts.sources.filter((source) => (hits[new URL(source.url).pathname] ?? 0) <= 0);
      check(`${arm.caseId}-sources-from-real-pages`, foreign.length === 0 && unread.length === 0,
        foreign.length || unread.length ? `非本臂页面：${foreign.map((s) => s.url).join(",")}；未打开：${unread.map((s) => s.url).join(",")}` : `${finding.facts.sources.length} 个来源都是本臂真实打开的页面`, arm.caseId);
      const opened: { url: string; status: number }[] = [];
      for (const source of finding.facts.sources) {
        const status = await fetch(source.url).then((response) => response.status).catch(() => 0);
        opened.push({ url: source.url, status });
      }
      const badOpen = opened.filter((entry) => entry.status !== 200);
      check(`${arm.caseId}-sources-openable`, badOpen.length === 0, badOpen.length ? `打不开：${JSON.stringify(badOpen)}` : opened.map((entry) => `${new URL(entry.url).pathname}:200`).join("，") || "本臂没有结构化来源", arm.caseId);
    }

    // ── T06：真实面板呈现（正文 + 事实链块 + 过程收起 + 无无据导出） ──
    const selected = (await iso!.swEval("chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId??null)")) as string | null;
    check(`${arm.caseId}-panel-follows-task`, selected === conversationOf(armDir), `面板选中=${selected ?? "无"} 本臂=${conversationOf(armDir)}`, arm.caseId);
    const report = await readPanel(finding.id);
    check(`${arm.caseId}-panel-result-visible`, report.deliveryId === finding.id && report.visible && report.text.length > 0,
      `deliveryId=${report.deliveryId ?? "无"} visible=${report.visible} text=${report.text.slice(0, 80)}`, arm.caseId);
    check(`${arm.caseId}-process-folded`, report.runOpen === false && report.runBeforeDelivery,
      `runOpen=${report.runOpen} runBeforeDelivery=${report.runBeforeDelivery}`, arm.caseId);
    check(`${arm.caseId}-no-unsupported-export`, report.exports === 0, `export affordances=${report.exports}`, arm.caseId);
    check(`${arm.caseId}-answer-actions`, report.answerActions >= 2, `结果动作按钮=${report.answerActions}（复制/追问）`, arm.caseId);
    if (finding.facts) {
      if (finding.facts.sources.length) {
        const want = finding.facts.sources.map((source) => source.url).sort();
        const got = report.sources.map((source) => source.href ?? "").sort();
        check(`${arm.caseId}-panel-sources`, JSON.stringify(got) === JSON.stringify(want) && report.sources.every((source) => source.visible),
          `面板来源=${got.length} 期望=${want.length}`, arm.caseId);
      }
      if (finding.facts.remaining.length) {
        check(`${arm.caseId}-panel-remaining`, report.remaining.length > 0 && (report.factHead ?? "").includes("部分完成"),
          `未完成项=${report.remaining.length} 标题=${report.factHead ?? "无"}`, arm.caseId);
      }
      if (finding.facts.delivered.length) {
        check(`${arm.caseId}-panel-delivered`, (report.factDone ?? "").includes("已完成"),
          `已完成行=${report.factDone ?? "无"}`, arm.caseId);
      }
    }

    if (arm.caseId === "A01") {
      const probeChecks = verdict.checks.filter((c) => c.id.startsWith("field-") || c.id === "no-submit" || c.id === "no-extra-field-changes");
      check(`${arm.caseId}-independent-page-facts`, probeChecks.length >= 4 && probeChecks.every((c) => c.ok),
        probeChecks.map((c) => `${c.id}:${c.ok ? "ok" : c.detail}`).join(" | "), arm.caseId);
      check(`${arm.caseId}-no-writes`, fixture.writes().length === 0, `服务端写入记录=${fixture.writes().length}`, arm.caseId);
      check(`${arm.caseId}-says-not-submitted`, /未提交|没提交|没有提交|先不提交|尚未提交|不会提交/.test(finding.text), finding.text.slice(0, 120), arm.caseId);
    }
    if (arm.caseId === "C04") {
      check(`${arm.caseId}-panel-gap-visible`, report.visible && report.text.length > 0, report.text.slice(0, 160), arm.caseId);
    }
    if (arm.caseId === "R03") {
      check(`${arm.caseId}-both-obligations`, verdict.checks.filter((c) => c.id.startsWith("summary-") || c.id === "font-changed").every((c) => c.ok),
        verdict.checks.filter((c) => c.id.startsWith("summary-") || c.id === "font-changed").map((c) => `${c.id}:${c.ok ? "ok" : c.detail}`).join(" | "), arm.caseId);
    }

    // ── T06：同交付重放 / 两次修订 / 晚到旧流（真实面板接收路径，脚本化输入） ──
    if (arm.caseId === "R01") {
      const envelope = (delivery: UserDelivery, conversationId: string) => JSON.stringify({ type: "agent_event", conversationId, event: { kind: "user_delivery", delivery } });
      const feed = async (message: string): Promise<void> => {
        await panelEval(`window.__t06AcceptDelivery&&window.__t06AcceptDelivery(${message})`);
        await sleep(120);
      };
      const conversationId = conversationOf(armDir);
      const bubbleCount = () => panelEval<number>(`document.querySelectorAll('#messages .msg.assistant.markdown[data-delivery-id=${JSON.stringify(finding.id)}]').length`);
      await feed(envelope(finding, conversationId));
      const before = await bubbleCount();
      await feed(envelope(finding, conversationId));
      const afterReplay = await bubbleCount();
      check(`${arm.caseId}-replay-idempotent`, before === 1 && afterReplay === 1, `第一次=${before} 重放后=${afterReplay}`, arm.caseId);

      // 错会话：真实中转层按会话身份过滤，不拿其他任务的证据给当前任务背书。
      const foreign: UserDelivery = { ...finding, id: `${finding.id}-foreign`, conversationId: "t06-foreign-conversation", text: "错误会话的结果不应出现。", facts: undefined };
      await feed(envelope(foreign, foreign.conversationId));
      const foreignRendered = await panelEval<number>(`document.querySelectorAll('#messages .msg.assistant.markdown[data-delivery-id=${JSON.stringify(foreign.id)}]').length`);
      check(`${arm.caseId}-foreign-conversation-not-rendered`, foreignRendered === 0, `渲染=${foreignRendered}`, arm.caseId);
      // 错 runId：正文可以归档到历史位置，但结果卡必须保持当前任务的结果。
      const staleId = `${finding.id}-stale-run`;
      const stale: UserDelivery = { ...finding, id: staleId, runId: "stale-run-00000000", text: "错任务的结果不应进入结果卡。", facts: undefined };
      await feed(envelope(stale, conversationId));
      const staleStrip = await panelEval<string>(`document.getElementById('task-result-primary')?.textContent??''`);
      check(`${arm.caseId}-stale-run-not-in-strip`, !staleStrip.includes("错任务的结果不应进入结果卡"), `结果卡=${staleStrip.slice(0, 80)}`, arm.caseId);

      const revisionA: UserDelivery = { ...finding, id: `${finding.id}-rev-a`, text: "修订 A：时间改到周六上午十点。", facts: undefined, composedAt: Date.now() };
      const revisionB: UserDelivery = { ...finding, id: `${finding.id}-rev-b`, text: "修订 B：最终时间以周六下午两点为准。", facts: undefined, composedAt: Date.now() + 1 };
      await feed(envelope(revisionA, conversationId));
      await feed(envelope(revisionB, conversationId));
      const revisions = await panelEval<{ a: number; b: number; aText: string; bText: string }>(`(()=>{
        const a=document.querySelector('#messages .msg.assistant.markdown[data-delivery-id=${JSON.stringify(revisionA.id)}]');
        const b=document.querySelector('#messages .msg.assistant.markdown[data-delivery-id=${JSON.stringify(revisionB.id)}]');
        return {a:a?1:0,b:b?1:0,aText:a?(a.innerText||'').slice(0,60):'',bText:b?(b.innerText||'').slice(0,60):''};
      })()`);
      check(`${arm.caseId}-revisions-kept`, revisions.a === 1 && revisions.b === 1 && revisions.aText.includes("修订 A") && revisions.bText.includes("修订 B"),
        JSON.stringify(revisions), arm.caseId);
      await feed(JSON.stringify({ type: "agent_event", conversationId, event: { kind: "user_delivery_stream", stream: { id: revisionA.id, runId: revisionA.runId, kind: "finding", text: "晚到的旧流内容不应覆盖。", phase: "streaming" } } }));
      const lateStream = await panelEval<string>(`(()=>{const a=document.querySelector('#messages .msg.assistant.markdown[data-delivery-id=${JSON.stringify(revisionA.id)}]');return a?(a.innerText||'').slice(0,80):'';})()`);
      check(`${arm.caseId}-late-stream-cannot-overwrite`, lateStream.includes("修订 A") && !lateStream.includes("晚到的旧流"),
        lateStream.slice(0, 80), arm.caseId);
      const cancelledId = `${finding.id}-cancelled`;
      await feed(JSON.stringify({ type: "agent_event", conversationId, event: { kind: "user_delivery_stream", stream: { id: cancelledId, runId: revisionA.runId, kind: "reply", text: "取消前的前缀。", phase: "streaming" } } }));
      await feed(JSON.stringify({ type: "agent_event", conversationId, event: { kind: "user_delivery_stream", stream: { id: cancelledId, runId: revisionA.runId, kind: "reply", text: "", phase: "cancelled" } } }));
      await feed(JSON.stringify({ type: "agent_event", conversationId, event: { kind: "user_delivery_stream", stream: { id: cancelledId, runId: revisionA.runId, kind: "reply", text: "取消之后的前缀不应复活。", phase: "streaming" } } }));
      const cancelled = await panelEval<string>(`(()=>{const el=document.querySelector('#messages .msg.assistant.markdown[data-delivery-id=${JSON.stringify(cancelledId)}]');return el?(el.innerText||'').slice(0,80):'';})()`);
      check(`${arm.caseId}-cancelled-prefix-not-revived`, cancelled.includes("取消前的前缀") && !cancelled.includes("不应复活"),
        cancelled.slice(0, 80), arm.caseId);
    }
  }

  // ── 50 次交付呈现时序：真实面板接收路径；不含模型生成与网络 ──
  const lastArm = arms.at(-1)!;
  const lastArmDir = join(outRoot, `${lastArm.caseId}-${CASE_BY_ID.get(lastArm.caseId)!.materials[material].materialId}`);
  const lastConversation = armResults.length === arms.length ? conversationOf(lastArmDir) : "default";
  const lastRunId = holder.current.manager.getTaskProgress(lastConversation)?.runId ?? null;
  const panelTab = (await iso!.swEval("chrome.tabs.query({}).then(tabs=>{const t=tabs.find(x=>(x.url||'').includes('sidepanel.html'));return t?t.id:null;})")) as number | null;
  if (panelTab !== null) await iso!.swEval(`chrome.tabs.update(${panelTab},{active:true})`).catch(() => {});
  await sleep(800);
  for (let index = 0; index < 50; index += 1) {
    const delivery: UserDelivery = {
      conversationId: lastConversation,
      id: `t06-timing-${index}-${Date.now().toString(36)}`,
      runId: lastRunId,
      kind: "finding",
      text: `结果样本 ${index + 1}：三页差异与来源见下。`,
      composedAt: Date.now(),
      status: "composed",
      facts: { outcome: "complete", delivered: ["比较三个页面"], remaining: [], sources: [{ url: `${fixture.origin}/offer/a`, title: null }, { url: `${fixture.origin}/offer/b`, title: null }, { url: `${fixture.origin}/offer/c`, title: null }] },
    };
    const envelope = JSON.stringify({ type: "agent_event", conversationId: lastConversation, event: { kind: "user_delivery", delivery } });
    await panelEval(`window.__t06AcceptDelivery&&window.__t06AcceptDelivery(${envelope})`);
    await sleep(60);
  }
  await sleep(1_200);
  const sample = (await panelEval<{ count: number; visibleCount: number; p95: number | null; samples: number[] } | undefined>("window.__t06DeliveryTiming&&window.__t06DeliveryTiming()")) ?? { count: 0, visibleCount: 0, p95: null, samples: [] };
  timing.push(sample);
  check("timing-samples", sample.count >= 50, `count=${sample.count}`);
  check("timing-all-visible", sample.visibleCount === sample.count, `visible=${sample.visibleCount}/${sample.count}`);
  check("timing-p95", sample.p95 !== null && sample.p95 <= 200, `p95=${sample.p95}ms（nearest-rank，n=${sample.count}）`);
} catch (error) {
  evaluatorOk = false;
  check("infrastructure", false, error instanceof Error ? error.message : String(error));
} finally {
  await iso?.close().catch(() => {});
  await stopHost(holder.current).catch(() => {});
  await fixture.close().catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
const summary = {
  outRoot, model, material,
  startedAt: new Date(start).toISOString(),
  elapsedMs: Date.now() - start,
  evaluatorOk,
  caseCount: arms.length,
  checkCount: checks.length,
  failedCount: failed.length,
  timing,
  arms: armResults,
  checks,
};
writeFileSync(join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.arm ? `[${item.arm}] ` : ""}${item.id} ${item.detail.slice(0, 240)}`);
console.log(JSON.stringify({ outRoot, evaluatorOk, checks: checks.length, failed: failed.length, failedIds: failed.map((c) => c.id) }));
process.exit(evaluatorOk && failed.length === 0 ? 0 : 1);
