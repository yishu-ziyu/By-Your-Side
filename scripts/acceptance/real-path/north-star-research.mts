/**
 * YIS-26：仅练习站 + 真实扩展/侧栏。脚本模型只代替提供方，不代替浏览器执行。
 * 失败面先定：缺交接/记忆、出现任何批准卡、保存多条/正文不符、搜索越站、回车没提交表单、慢保存后重复保存或说反结果。
 * 10-04 起网页操作不再弹批准卡（docs/evals/20261004-remove-approvals.md）：N1 断言全程零张卡，并用回车提交维基搜索框。
 * N2 慢保存门槛见 honest-completion；技术前提复用 cross-site-tabs / selection-reaches-task / memory-recalls-sources。
 * --headless [--scripted|--model=provider/id] [--only=N1,N2]；--rejudge=<目录> [--self-test-judges] 不开浏览器、不调模型。
 * 产物在当前 worktree 的 out/acceptance/real-path/<时间>-north-star/；重判写 rejudge.json，不改 summary.json。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, watchInproc, type JsonRecord } from "./harness.mts";
import { configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";
import { startNorthStarSites, TERMS, EXPLANATIONS, POST_TEXT, type SiteRequest, type MemoPost } from "./north-star-sites.mts";

type Scenario = "N1" | "N2";

interface TurnCapture { elapsedMs: number; completed: boolean; term: string; startedAt: number; endedAt: number; conversationId: string }

type Content = string | Array<{ text?: string }> | null | undefined;

const contentText = (c: Content) => Array.isArray(c) ? c.map(p => p.text ?? "").join("") : c ?? "";

/** 只数实际 HTTP 请求里的工具结果；OpenAI、Anthropic 和 Responses 的消息格式。 */
function requestToolChars(body: string) {
  // SAFETY: 提供方 JSON 请求的公开消息格式；不支持的格式返回 null，不能冒充零字数。
  const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string; content?: Content }> }>; input?: Array<{ type?: string; output?: string }> };

  if (!Array.isArray(payload.messages) && !Array.isArray(payload.input)) return null;
  let chars = 0;

  for (const m of payload.messages ?? []) {
    if (m.role === "tool") chars += contentText(m.content).length;

    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "tool_result") chars += contentText(part.content).length;
      }
    }
  }

  for (const input of payload.input ?? []) {
    if (input.type === "function_call_output") chars += String(input.output ?? "").length;
  }

  return chars;
}

/** cardsSeen：每次轮询侧栏里任何批准/确认卡元素数的最大值；scripted：脚本模型按固定步骤（回车提交搜索）执行。 */
interface Capture { scenario: Scenario; scripted: boolean; requests: SiteRequest[]; posts: MemoPost[]; cardsSeen: number; nativeEvents: JsonRecord[]; finished: boolean; fatal: string | null; turns: TurnCapture[] }

/** Live 原生消息与 history 重放可能重复；按 toolCallId/消息身份去重，不把脚本步骤当证据。 */
function nativeMessages(events: JsonRecord[]): JsonRecord[] {
  const messages: JsonRecord[] = [];
  const seen = new Set<string>();

  const add = (msg: JsonRecord) => {
    const key = JSON.stringify(msg);

    if (!seen.has(key)) { seen.add(key); messages.push(msg); }
  };

  for (const wire of events) {
    // SAFETY: 旁听端口输出原生 envelope；history.item.msg 和 server.msg 都是协议消息。
    if (wire.kind === "server" && wire.msg) {
      // SAFETY: server.msg 是已观察到的协议消息。
      add(wire.msg as JsonRecord);
    }

    if (wire.kind === "history") {
      // SAFETY: history.entries 为协议历史列表；只展开含 msg 的项。
      for (const entry of (wire.entries ?? []) as JsonRecord[]) {
        // SAFETY: history.item 是协议 envelope。
        const item = entry.item as JsonRecord | undefined;

        // SAFETY: 与 live server.msg 相同的协议消息。
        if (item?.msg) {
          // SAFETY: history.item.msg 是已观察到的协议消息。
          add(item.msg as JsonRecord);
        }
      }
    }
  }

  return messages;
}

function agentEvents(events: JsonRecord[]) {
  // SAFETY: agent_event.event 是协议定义的 AgentUiEvent。
  return nativeMessages(events).flatMap(m => m.type === "agent_event" && m.event ? [m.event as JsonRecord] : []);
}

/** history 是原生事件的交付方式；只去掉本轮之前的同步历史，不丢新增历史事件。 */
function since(events: JsonRecord[], at: number): JsonRecord[] {
  return events.flatMap(wire => {
    if (wire.kind === "history") {
      // SAFETY: 原生 history.entries 带服务端 occurredAt；只筛选时间，不改事件内容。
      const entries = ((wire.entries ?? []) as JsonRecord[]).filter(e => Number(e.occurredAt) >= at);

      return entries.length ? [{ ...wire, entries }] : [];
    }

    return Number(wire.receivedAt) >= at ? [wire] : [];
  });
}

/** 每次真正执行了的保存点击（非被拦下的重复），回执都写着页面发出了 POST flomo.test/api/memo。 */
function saveClicksSawPost(events: JsonRecord[]): boolean {
  const saves = events.filter(e => e.kind === "tool_end" && e.name === "click" && e.executionFact === "executed" && String(e.resultText).startsWith("Clicked 保存"));

  return saves.length > 0 && saves.every(e => String(e.resultText).includes("page sent POST flomo.test/api/memo"));
}

/** 本轮回车提交维基搜索框：press_key 回执为已执行，且服务器收到这次搜索。 */
function enterSubmittedSearch(c: Capture, events: JsonRecord[]): boolean {
  const pressed = events.some(e => e.kind === "tool_end" && e.name === "press_key" && e.isError === false && e.executionFact === "executed");

  return pressed && c.requests.some(r => r.method === "GET" && r.host === "wiki.test" && r.path === `/search?q=${encodeURIComponent(TERMS[0]!).replaceAll("%20", "+")}`);
}

function judge(c: Capture) {
  const messages = nativeMessages(c.nativeEvents);
  const searchHosts = [...new Set(c.requests.flatMap(r => r.path.startsWith("/search?") ? [r.host] : []))].sort();
  const events = agentEvents(c.nativeEvents);
  // SAFETY: user_delivery.delivery 为原生用户可见回答，text 是协议字段。
  const reply = String((events.findLast(e => e.kind === "user_delivery")?.delivery as JsonRecord | undefined)?.text ?? "");
  // 不弹卡：侧栏里没出现过卡片元素，原生消息里也没有任何批准请求。
  const zeroCards = c.cardsSeen === 0 && !messages.some(m => String(m.type).startsWith("consent_"));

  const checks = c.scenario === "N1" ? {
    zeroCards,
    exactlyOnePost: c.posts.length === 1,
    bodyMatchesNote: c.posts.length === 1 && (!c.scripted || c.posts[0]?.body === noteFor(0)),
    onlyPreferredSearchSites: JSON.stringify(searchHosts) === JSON.stringify(["wiki.test", "x.test"]),
    readSources: c.requests.some(r => r.method === "GET" && r.host === "wiki.test" && r.path.startsWith("/wiki/"))
      && c.requests.some(r => r.method === "GET" && r.host === "x.test" && r.path === "/status/1"),
    // docs/evals/20261004-honest-completion.md R2：保存点击的回执认出页面发出了保存请求。
    saveClickSawPost: saveClicksSawPost(events),
    // docs/evals/20261004-remove-approvals.md：回车不再被拦，提交了表单。
    enterSubmitsForm: !c.scripted || enterSubmittedSearch(c, events),
  } : {
    zeroCards,
    // honest-completion R1：拦下的重复保存不算失败；每个词只保存一次（第 2 条服务器只收到 1 次）。
    eachTermSavedOnce: c.posts.length === 2,
    answerNotClaimingFailure: !reply.includes("有一步没做成"),
    saveClickSawPost: saveClicksSawPost(events),
  };

  return { status: c.fatal ? "ERROR" : c.finished && Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks, searchHosts, reply };
}

const rejudgeDir = process.argv.find(a => a.startsWith("--rejudge="))?.slice(10);

if (rejudgeDir) {
  const dir = resolve(rejudgeDir);

  if (!dir.startsWith(REPO + "/")) throw new Error("重判目录必须在当前 worktree 内");
  // SAFETY: 本脚本写入的 summary 包含 Capture，各字段用于同一服务器/原生事件判据。
  const original = JSON.parse(await readFile(join(dir, "summary.json"), "utf8")) as { scenarios: Capture[] };

  if (!Array.isArray(original.scenarios)) throw new Error("请传入包含整轮 summary.json 的产物根目录，不是场景子目录");

  if (process.argv.includes("--self-test-judges")) {
    const cases = original.scenarios.flatMap(c => {
      const extraPost = structuredClone(c);
      extraPost.posts.push({ ...c.posts[0]!, ordinal: c.posts.length + 1 });
      const card = structuredClone(c);
      card.cardsSeen = 1;

      const noEnter = structuredClone(c);
      noEnter.requests = noEnter.requests.filter(r => !(r.host === "wiki.test" && r.path.startsWith("/search?")));

      return [
        { scenario: c.scenario, mutation: "服务器多收到一条相同保存", original: judge(c), broken: judge(extraPost) },
        { scenario: c.scenario, mutation: "侧栏出现一张批准卡", original: judge(c), broken: judge(card) },
        ...(c.scenario === "N1" ? [{ scenario: c.scenario, mutation: "回车后服务器没收到搜索请求", original: judge(c), broken: judge(noEnter) }] : []),
      ];
    });

    const ok = cases.length > 0 && cases.every(c => c.original.status === "PASS" && c.broken.status === "FAIL");
    await writeFile(join(dir, "judge-counterexamples.json"), JSON.stringify({ cases, ok }, null, 2));
    console.log(JSON.stringify({ cases, ok, directory: dir }));
    process.exit(ok ? 0 : 1);
  }

  const scenarios = original.scenarios.map(c => ({ scenario: c.scenario, ...judge(c) }));
  const ok = scenarios.length > 0 && scenarios.every(s => s.status === "PASS");
  await writeFile(join(dir, "rejudge.json"), JSON.stringify({ at: new Date().toISOString(), scenarios, ok }, null, 2));
  console.log(JSON.stringify({ scenarios, ok, directory: dir }));
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--self-test-judges")) throw new Error("反例自证必须同时传 --rejudge=<产物目录>");

requireHeadless();

const modelArg = process.argv.find(a => a.startsWith("--model="))?.slice(8);

if (modelArg && process.argv.includes("--scripted")) throw new Error("--scripted 与 --model 二选一");

const only = process.argv.find(a => a.startsWith("--only="))?.slice(7).split(",");

const scenarios: Scenario[] = ["N1", "N2"];

if (only?.some(s => !scenarios.some(valid => valid === s))) throw new Error("--only 只接受 N1,N2");

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-north-star`);

await mkdir(artifacts, { recursive: true });

const PREF = "我查资料常去维基百科和 X";

const USER_TEXT = "查一下这个词，整理成一条 Flomo 笔记";

const taskText = modelArg ? USER_TEXT + "。本次只用本机练习站：维基百科对应 http://wiki.test，X 对应 http://x.test，Flomo 对应 http://flomo.test；搜索入口均为 /search?q=，不要访问真实网站。" : USER_TEXT;

const urlFor = (host: string, path: string) => `http://${host}${path}`;

function noteFor(i: number): string {
  return `${TERMS[i]}\n${EXPLANATIONS[i]!.join("\n")}\n来源：http://wiki.test/wiki/${encodeURIComponent(TERMS[i]!)}\n${i === 0 ? POST_TEXT + "\n来源：http://x.test/status/1" : "X 上没找到相关讨论。\n来源：http://x.test/search?q=Computer%20Use"}`;
}

function stepsFor(i: number, scenario: Scenario): Step[] {
  const term = TERMS[i]!;
  const tool = (name: string, args: JsonRecord): Step => ({ tool: { name, args } });

  // N1 用维基首页的搜索框：填入词后按回车，由表单提交带出搜索请求（回车不再被拦）。
  const wikiSearch: Step[] = scenario === "N1"
    ? [tool("tabs", { action: "open", url: urlFor("wiki.test", "/") }), tool("fill", { target: "#q", value: term }), tool("press_key", { key: "Enter" })]
    : [tool("tabs", { action: "open", url: urlFor("wiki.test", `/search?q=${encodeURIComponent(term)}`) })];

  const steps: Step[] = [
    ...wikiSearch,
    tool("read_elements", { selector: "#results" }),
    tool("tabs", { action: "open", url: urlFor("wiki.test", `/wiki/${encodeURIComponent(term)}`) }),
    tool("read_elements", { selector: "#summary" }),
    tool("tabs", { action: "open", url: urlFor("x.test", `/search?q=${encodeURIComponent(term)}`) }),
    tool("read_elements", { selector: "#results" }),
  ];

  if (i === 0) steps.push(tool("tabs", { action: "open", url: urlFor("x.test", "/status/1") }), tool("read_elements", { selector: "#post" }));
  steps.push(tool("tabs", { action: "open", url: urlFor("flomo.test", "/") }), tool("fill", { target: "#note", value: noteFor(i) }), tool("click", { target: "#save", label: "保存" }));

  if (scenario === "N2" && i === 1) steps.push(tool("click", { target: "#save", label: "保存" }));
  steps.push({ text: scenario === "N2" && i === 1 ? "第二条保存结果请以 Flomo 列表为准。" : "已整理并保存笔记。" });

  return steps;
}

/** 侧栏里任何批准/确认卡样式的元素；卡片已删除，这里应始终为 0。 */
const CARD_SELECTOR = '#consent-requests, .consent-card, .consent-allow, [data-request-id]';

async function runScenario(scenario: Scenario) {
  const dir = join(artifacts, scenario);
  await mkdir(dir);
  const startedAt = Date.now();
  const site = await startNorthStarSites(scenario === "N2" ? 2 : 0, scenario === "N2" ? 40_000 : 0);
  const requestsToModel: JsonRecord[] = [];
  const networkInputs: Array<{ at: number; url: string; toolResultChars: number | null }> = [];
  let lastModelRequest = "";
  const rules = TERMS.map((term, i) => ({ match: `[User's selected text]\n${term}\n`, steps: stepsFor(i, scenario) }));

  const model = modelArg ? null : await startScriptedModel(rules, undefined, payload => {
    lastModelRequest = (payload.messages ?? []).map(m => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "").join("\n");
    const tools = (payload.messages ?? []).flatMap(m => m.role === "tool" ? [Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? ""] : []);
    requestsToModel.push({ at: Date.now(), main: !!payload.tools?.length, toolMessages: tools.length, toolResultChars: tools.reduce((n, s) => n + s.length, 0), selection: lastModelRequest.includes("[User's selected text]"), memory: lastModelRequest.includes(PREF), lastToolResult: tools.at(-1) ?? null });
  });

  let rp: Awaited<ReturnType<typeof launchRealPath>> | null = null;
  let panel = "";
  let watcher: Awaited<ReturnType<typeof watchInproc>> | null = null;
  let cardsSeen = 0;
  let nativeEvents: JsonRecord[] = [];
  let fatal: string | null = null;
  let finished = false;
  let firstTaskAt: number | null = null;
  let lastTurnAt = 0;
  let lastEventsIndex = 0;
  const turns: TurnCapture[] = [];

  try {
    console.log(`${scenario} 启动隔离浏览器`);
    rp = await launchRealPath({ chromeArgs: [site.resolver, "--no-proxy-server"] });
    const browser = rp;

    const ready = async () => {
      panel = await browser.attach(await browser.openSidePanel());
      await until(async () => (await browser.evaluate(panel, `document.querySelector('#send-btn')?.disabled === false`)) || undefined, 30_000, "侧栏就绪");
    };

    await ready();

    if (model) {
      await configureViaSettings(browser, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-scripted-no-secret" } }, { baseUrl: model.baseUrl });
    } else {
      const plan = await loadModelPlan(modelArg!);
      await browser.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
    }

    console.log(`${scenario} 预置记忆`);
    const now = Date.now();
    const doc = JSON.stringify({ format: 2, entries: [{ id: "north-star-sources", version: 1, text: PREF, scope: { kind: "all" }, sourceConversationId: "seed", createdAt: now, updatedAt: now, kind: "profile", status: "active", sourceQuote: PREF, useCount: 0, formatVersion: 2 }] }) + "\n";
    await browser.evaluate(panel, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(${JSON.stringify(doc)}, "memories"); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); })`);
    console.log(`${scenario} 重启读取记忆`);
    await browser.restart();
    const blog = await browser.cdp.send("Target.createTarget", { url: urlFor("blog.test", "/post") });
    await browser.cdp.send("Target.activateTarget", { targetId: blog.targetId });
    await sleep(800);
    await ready();

    console.log(`${scenario} 接入原生旁听`);
    watcher = await watchInproc(browser, browser.extensionId);
    const inproc = (await browser.targets()).find(t => t.url === `chrome-extension://${browser.extensionId}/inproc.html`);

    if (!inproc) throw new Error("未找到模型请求所在的 offscreen 文档");
    const networkSession = await browser.attach(inproc.targetId);
    browser.cdp.onEvent("Network.requestWillBeSent", (wire: { sessionId?: string; params: { request: { method: string; url: string; postData?: string } } }) => {
      if (wire.sessionId !== networkSession || wire.params.request.method !== "POST") return;
      const request = wire.params.request;
      let chars: number | null = null;

      try { chars = request.postData ? requestToolChars(request.postData) : null; } catch { chars = null; }

      networkInputs.push({ at: Date.now(), url: request.url, toolResultChars: chars });
    });
    await browser.cdp.send("Network.enable", { maxPostDataSize: 8_000_000 }, networkSession);

    for (let i = 0; i < (scenario === "N2" ? 2 : 1); i += 1) {
      console.log(`${scenario} 交接划选 ${TERMS[i]}`);
      await browser.cdp.send("Target.activateTarget", { targetId: blog.targetId });
      await browser.evaluate(panel, `chrome.tabs.query({url:"http://blog.test/*"}).then(([t]) => chrome.tabs.update(t.id,{active:true}).then(() => chrome.storage.session.set({pendingAsk:{text:${JSON.stringify(TERMS[i])},tabId:t.id,title:t.title,url:t.url}})))`);
      await browser.evaluate(panel, "location.reload()").catch(() => undefined);
      await sleep(1500);
      await ready();
      await browser.evaluate(panel, `(() => { globalThis.__northPort?.disconnect(); globalThis.__northEvents=[]; const p=chrome.runtime.connect({name:"sideagent-panel"}); globalThis.__northPort=p;
        p.onMessage.addListener(e => { globalThis.__northEvents.push({...e,receivedAt:Date.now()}); if(e.kind === "conversations") globalThis.__northSelected=e.selectedConversationId; }); p.postMessage({kind:"sync"}); return true; })()`);
      await sleep(300);
      console.log(`${scenario} 发送任务 ${TERMS[i]}`);
      const turnStart = Date.now();
      firstTaskAt ??= turnStart;
      lastTurnAt = turnStart;
      lastEventsIndex = nativeEvents.length;
      await browser.click(panel, "#input");
      await browser.typeText(panel, taskText);
      await browser.pressEnter(panel);
      let idle = 0;
      let completed = false;

      while (Date.now() - turnStart < (modelArg ? 360_000 : 180_000)) {
        // SAFETY: 只读侧栏 DOM 与旁听端口收到的原生事件。
        const view = await browser.evaluate(panel, `(() => ({events:globalThis.__northEvents??[], cards:document.querySelectorAll(${JSON.stringify(CARD_SELECTOR)}).length,
          busy:!!(document.querySelector('#status-pill.running,#send-btn.stopping,.msg.assistant.streaming,.msg.assistant[data-revealing]'))}))()`) as { events: JsonRecord[]; cards: number; busy: boolean };

        if (view.cards > cardsSeen) {
          cardsSeen = view.cards;
          await browser.screenshot(panel, join(dir, `card-seen-${cardsSeen}.png`));
        }

        completed = agentEvents(since(view.events, turnStart)).some(e => e.kind === "agent_end" || e.kind === "user_delivery");
        idle = !view.busy && completed && Date.now() - turnStart > 3000 ? idle + 1 : 0;

        if (idle >= 8) break;
        await sleep(250);
      }

      // SAFETY: observer 保存原生端口消息，按接收时间截取本轮，排除 reload 同步的旧历史。
      const observed = await browser.evaluate(panel, "globalThis.__northEvents") as JsonRecord[];
      nativeEvents.push(...since(observed, turnStart));
      const conversationId = String(await browser.evaluate(panel, "globalThis.__northSelected"));
      turns.push({ elapsedMs: Date.now() - turnStart, completed, term: TERMS[i]!, startedAt: turnStart, endedAt: Date.now(), conversationId });
      console.log(`${scenario} 第 ${i + 1} 轮结束，侧栏出现过的卡片元素：${cardsSeen}`);

      if (!completed || idle < 8) throw new Error(`${scenario} 第 ${i + 1} 轮未结束`);
    }

    // 等完被故意延迟的服务端响应，记录晚到 POST，不用模型宣称推断。
    await until(async () => site.posts.every(p => p.responseAt !== null) || undefined, 50_000, "保存响应收录");
    await sleep(1000);
    // SAFETY: 响应晚于任务回答时，继续保留原生晚到事件；替换本轮快照，不重复累计。
    const lateEvents = await browser.evaluate(panel, "globalThis.__northEvents") as JsonRecord[];
    nativeEvents.splice(lastEventsIndex);
    nativeEvents.push(...since(lateEvents, lastTurnAt));
    await browser.screenshot(panel, join(dir, "panel-final.png"));
    finished = true;
  } catch (error) {
    fatal = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(fatal);

    if (rp && panel) {
      await rp.screenshot(panel, join(dir, "error.png")).catch(() => undefined);
      // SAFETY: 在失败时保留旁听记录，不将缺记录解释为零工具调用。
      const observed = await rp.evaluate(panel, "globalThis.__northEvents ?? []").catch(() => []) as JsonRecord[];
      nativeEvents.push(...observed);
    }
  } finally {
    await rp?.close();
    await rp?.remove();
    await model?.close();
    await site.close();
  }

  const capture: Capture = { scenario, scripted: !modelArg, requests: site.requests, posts: site.posts, cardsSeen, nativeEvents, finished, fatal, turns };
  const verdict = judge(capture);
  const events = agentEvents(nativeEvents);
  const starts = events.filter(e => e.kind === "tool_start");
  const ends = events.filter(e => e.kind === "tool_end");
  const clickEnds = ends.filter(e => e.name === "click");
  const repeat = clickEnds[2];
  const secondPosts = site.posts.slice(1);

  const observation = scenario === "N2" ? {
    secondMemoPostCount: secondPosts.length,
    secondMemoPosts: secondPosts,
    clickResults: clickEnds,
    repeatedClickResult: repeat ?? null,
    repeatedClickExecutionFact: repeat?.executionFact ?? null,
    repeatedClickDisposition: !repeat ? "not_observed" : repeat.executionFact === "not_executed" ? "blocked" : repeat.executionFact === "executed" ? "allowed" : "unknown",
  } : { pressKeyResults: ends.filter(e => e.name === "press_key") };

  const summary = { ...capture, ...verdict, mode: modelArg ?? "scripted", elapsedMs: firstTaskAt === null ? null : Date.now() - firstTaskAt, harnessElapsedMs: Date.now() - startedAt, turns,
    modelRequests: model ? requestsToModel.filter(r => firstTaskAt !== null && Number(r.at) >= firstTaskAt).length : watcher?.requestsBetween(0).filter(r => r.method === "POST").length ?? null,
    toolCalls: starts.length, toolNames: starts.map(e => e.name),
    toolResultCharsToModel: model ? requestsToModel.reduce((n, r) => n + Number(r.toolResultChars), 0)
      : networkInputs.length && networkInputs.every(r => r.toolResultChars !== null) ? networkInputs.reduce((n, r) => n + r.toolResultChars!, 0) : null,
    toolResultCharsMetric: "实际模型请求中工具结果文字字符数之和；历史重复进入也计数。脚本模式由服务端收录，真实模式旁听 offscreen HTTP 请求；缺请求体或不支持的格式记 null，不冒充零。",
    nativeToolResultChars: ends.reduce((n, e) => n + String(e.resultText ?? "").length, 0),
    requestsToModel, networkInputs, modelTimeline: model?.requests ?? null, inprocNetworkRequests: watcher?.requestsBetween(0) ?? [], cost: modelArg ? null : 0, observation,
    setup: { selectionAndMemoryInMainRequests: model ? requestsToModel.some(r => r.main && r.selection && r.memory) : null },
  };

  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`${verdict.status} ${scenario} ${JSON.stringify(verdict.checks)} ${dir}`);

  return summary;
}

const results = [];

for (const scenario of scenarios) {
  if (!only || only.includes(scenario)) results.push(await runScenario(scenario));
}

const ok = results.every(r => r.status === "PASS");

await writeFile(join(artifacts, "summary.json"), JSON.stringify({ contract: "docs/evals/20261004-north-star-cross-site.md", approvalsContract: "docs/evals/20261004-remove-approvals.md", mode: modelArg ?? "scripted", scenarios: results, ok }, null, 2));

console.log(`${ok ? "PASS" : "FAIL"} north-star ${artifacts}`);

process.exitCode = ok ? 0 : 1;
