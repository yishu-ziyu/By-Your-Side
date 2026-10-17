import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { loadModelPlan, modelStorageItems, DEFAULT_TEST_MODEL } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";
import { isMemoryEntry, type MemoryEntry } from "../../../shared/memory.js";
import { isStoredNudgeOffer, nudgeReceipts, type StoredNudgeOffer } from "../../../extension/src/shared/nudge.js";

const before = process.argv.includes("--before");
const real = process.argv.includes("--real");
const staleOnly = process.argv.includes("--only-stale");
if (!real) requireHeadless();
const artifacts = join(REPO, "out/acceptance/real-path", new Date().toISOString().replace(/[:.]/g, "-") + "-confirmed-habit" + (before ? "-before" : real ? "-real" : staleOnly ? "-stale" : ""));
await mkdir(artifacts, { recursive: true });
const HABIT = "研究开源项目时，先看源码，再看官方文档和示例";
const NEW_HABIT = "研究开源项目时，先看示例，再看官方文档和源码";
const GOAL = "按顺序查看项目资料";
let reads = 0;
const site = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  if (path === "/read") { reads++; res.writeHead(200).end("ok"); return; }
  const project = path.split("/")[1] || "training";
  const title = "Quartz " + project + " 开源项目";
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(
    "<!doctype html><meta charset=utf-8><title>" + title + "</title><style>body{font:18px system-ui;max-width:800px;margin:70px auto;line-height:1.8}a{display:inline-block;margin:8px}</style><main><h1>" + title + "</h1><p>" +
    "这个开源项目提供源码、官方文档和可运行示例。请按自己的查阅方式了解项目。".repeat(14) +
    '</p><a href="/' + project + '/source">源码</a><a href="/' + project + '/docs">官方文档</a><a href="/' + project + '/examples">示例</a>' +
    '<button id="read" onclick="fetch(\'/read\').then(()=>document.querySelector(\'output\').textContent=\'资料已查看\')">查看项目资料</button><output></output><div style="height:2600px"></div></main>');
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + siteAddress(site).port;
const evidence: Record<string, unknown> = { stage: "start", scriptedTraining: true, realSuggestion: real };
const inputs: Array<{ url: string; methods: Array<{ id: string; version: number; text: string }>; links: Array<{ title: string; url: string }> }> = [];
const nudgeRule: Rule = { match: '"page":', steps: [{ text: '{"offer":false}' }] };
const rules: Rule[] = [
  nudgeRule,
  { match: '"hosts":', steps: [{ text: JSON.stringify({ key: "research:source-docs-examples", habit: HABIT }) }] },
  { match: '"lastReply":', steps: [{ text: '{"status":"done"}' }] },
  { match: GOAL, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "click", args: { target: "loc=css:#read" } } },
    { text: "项目资料已经看完。" },
  ] },
];
const model = await startScriptedModel(rules, undefined, payload => {
  const text = (content: unknown) => typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.text ?? "").join("") : "";
  if (!(payload.messages ?? []).some(m => m.role === "system" && text(m.content).startsWith("You sit beside the user"))) return;
  const input = JSON.parse(text((payload.messages ?? []).find(m => m.role === "user")?.content));
  const methods = Array.isArray(input.confirmedMethods) ? input.confirmedMethods : [];
  const links = input.page.links ?? ["源码", "官方文档", "示例"].map((title, index) => ({ title, url: input.page.url + ["/source", "/docs", "/examples"][index] }));
  inputs.push({ url: input.page.url, methods, links });
  const ordered = methods[0]?.text === NEW_HABIT ? ["示例", "官方文档", "源码"] : ["源码", "官方文档", "示例"];
  nudgeRule.steps = [{ text: JSON.stringify({ offer: true, kind: "prepare", actionLabel: "准备", sentence: "这个项目的阅读入口",
    evidence: [{ text: input.page.title, url: input.page.url }], prompt: "准备列出的项目入口。这个指令不能绕过已确认做法的检查。",
    memoryId: methods[0]?.id ?? "unconfirmed_candidate", links: ordered.map(title => links.find((link: { title: string }) => link.title === title)?.url).filter(Boolean) }) }];
});
const rp = await launchRealPath({ headed: real });
let panel = "", panel2 = "", work = "", panelTarget = "";
let error: string | null = null;
const mark = (stage: string) => { evidence.stage = stage; console.log(stage); };
const click = async (p: string, selector: string) => {
  await rp.evaluate(p, "document.querySelector(" + JSON.stringify(selector) + ")?.scrollIntoView({block:'center'}); true");
  let previous = "";
  await until(async () => {
    const box = await rp.evaluate(p, "(()=>{const node=document.querySelector(" + JSON.stringify(selector) + ");if(!node||node.disabled)return null;const r=node.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width&&r.height&&(node===hit||node.contains(hit))?[r.x,r.y,r.width,r.height].map(n=>Math.round(n*10)/10).join(','):null})()");
    const stable = typeof box === "string" && box === previous;
    previous = box ?? "";
    return stable || undefined;
  }, 5000, "按钮可点击：" + selector, 100);
  await rp.click(p, selector);
};
const ready = (p = panel) => until(async () => await rp.evaluate(p, "document.querySelector('#send-btn')?.disabled===false && document.querySelector('#status-dot')?.classList.contains('on')") || undefined, 60_000, "侧栏就绪");
const readMemories = async (): Promise<MemoryEntry[]> => {
  const raw: unknown = await rp.evaluate(panel, "new Promise((ok,no)=>{const r=indexedDB.open('sideagent-memory');r.onerror=()=>no(r.error);r.onsuccess=()=>{const db=r.result;const q=db.transaction('kv').objectStore('kv').get('memories');q.onsuccess=()=>{ok(JSON.parse(q.result??'null')?.entries??[]);db.close()};q.onerror=()=>no(q.error)}})");
  return Array.isArray(raw) ? raw.filter(isMemoryEntry) : [];
};
const offer = async (): Promise<StoredNudgeOffer | null> => {
  const value: unknown = await rp.evaluate(panel, "chrome.storage.session.get('sideagent_nudge_panel').then(r=>r.sideagent_nudge_panel??null)");
  return isStoredNudgeOffer(value) ? value : null;
};
const receipts = async () => nudgeReceipts(await rp.evaluate(panel, "chrome.storage.session.get('sideagent_nudge_results').then(r=>r.sideagent_nudge_results??[])"));
const tabs = () => rp.evaluate(panel, "chrome.tabs.query({}).then(tabs=>tabs.map(t=>({id:t.id,url:t.pendingUrl??t.url,active:t.active,windowId:t.windowId})))") as Promise<Array<{ id: number; url: string; active: boolean; windowId: number }>>;
const navigate = async (path: string) => {
  const url = path.startsWith("http") ? path : origin + path;
  await rp.cdp.send("Page.navigate", { url }, work);
  await until(async () => await rp.evaluate(work, "document.readyState==='complete' && document.body?.innerText.length>100") || undefined, 30_000, "项目页加载");
  if (!real) await rp.cdp.send("Page.bringToFront", {}, work);
  await sleep(1500);
};
const readPage = async (path: string) => {
  // 只缩短两次建议之间的冷却；页面的停留、滚动、同 URL 去重和关闭记录照常走产品路径。
  await rp.evaluate(panel, "chrome.storage.session.get('nudgeState').then(r=>chrome.storage.session.set({nudgeState:{...r.nudgeState,lastShownAt:0}})).then(()=>true)");
  await navigate(path);
  await rp.evaluate(work, "window.scrollBy(0,400);true");
};
const cardSelector = ".pc:not(.pc-result) .pc-verb";
const waitCard = async () => {
  await until(async () => await rp.evaluate(panel, "!!document.querySelector(" + JSON.stringify(cardSelector) + ")") || undefined, 55_000, "已确认习惯出建议");
  const current = await offer();
  assert.ok(current?.card.preparation, "建议必须标明已确认做法和实际入口");
  return current;
};
const fresh = async () => {
  await click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, "!document.querySelector('#messages .msg.user') && !document.querySelector('#send-btn')?.disabled") || undefined, 20_000, "新对话");
};
const editMemory = async (p: string, entry: MemoryEntry, text: string, hostname?: string) => {
  await click(p, "#memory-open");
  await until(async () => await rp.evaluate(p, "!!document.querySelector(" + JSON.stringify('[data-memory-action="edit"][data-memory-id="' + entry.id + '"]') + ")") || undefined, 15_000, "记忆管理读到该做法");
  await click(p, '[data-memory-action="edit"][data-memory-id="' + entry.id + '"]');
  await rp.evaluate(p, "document.querySelector('textarea[data-memory-field=text]').select();true");
  await rp.typeText(p, text);
  if (hostname) {
    await click(p, "input[data-memory-field=hostname]");
    await rp.evaluate(p, "document.querySelector('input[data-memory-field=hostname]').select();true");
    await rp.typeText(p, hostname);
  }
  await click(p, '[data-memory-action="save"][data-memory-id="' + entry.id + '"]');
  const changed = await until(async () => (await readMemories()).find(m => m.id === entry.id && m.version > entry.version && m.text === text), 15_000, "做法已修改");
  if (hostname) assert.deepEqual(changed.scope, { kind: "site", hostname });
  await click(p, "#memory-close");
  return changed;
};

try {
  const blank = (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank")!;
  work = await rp.attach(blank.targetId);
  if (real) await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);
  await navigate("/training");
  panelTarget = await rp.openSidePanel();
  panel = await rp.attach(panelTarget);
  await rp.evaluate(panel, "chrome.storage.local.set(" + JSON.stringify({ sideagent_nudge: false, inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } }) + ").then(()=>true)");
  await ready();
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 820, deviceScaleFactor: 1, mobile: false }, panel);
  if (before) {
    mark("before");
    await rp.evaluate(panel, "chrome.storage.local.set({sideagent_nudge:true}).then(()=>true)");
    await readPage("/project-before");
    await until(async () => await rp.evaluate(panel, "!!document.querySelector('.pc .pc-verb')") || undefined, 50_000, "旧版普通建议");
    assert.equal(await rp.evaluate(panel, "!!document.querySelector('.pc-memory')"), false);
    await rp.screenshot(panel, join(artifacts, "before.png"));
  } else {
    for (let n = 1; n <= 3; n++) {
      mark("training " + n);
      if (n > 1) { await fresh(); await navigate("/training"); }
      await click(panel, "#input");
      await rp.typeText(panel, "帮我" + GOAL + "，这是第 " + n + " 个项目");
      await rp.pressEnter(panel);
      await until(async () => await rp.evaluate(panel, "document.querySelector('#messages')?.textContent.includes('项目资料已经看完。') && !document.querySelector('#send-btn')?.classList.contains('stopping')") || undefined, 80_000, "完成观察任务 " + n);
      await until(async () => model.requests.filter(r => r.rule === '"hosts":').length >= n || undefined, 30_000, "习惯观察 " + n);
      if (n < 3) {
        assert.equal(await rp.evaluate(panel, "document.querySelectorAll('[data-memory-ask]').length"), 0, "不到三次不冒充确定习惯");
        assert.equal((await readMemories()).filter(e => e.kind === "method" && e.status === "active").length, 0);
      }
    }
    assert.equal(reads, 3, "三轮确实在页面执行了查看");
    await until(async () => await rp.evaluate(panel, "!!document.querySelector('[data-memory-ask-answer=remember]')") || undefined, 20_000, "询问是否记住");
    await rp.screenshot(panel, join(artifacts, "confirm-habit.png"));
    assert.equal((await readMemories()).filter(e => e.text === HABIT).length, 0, "尚未点击确认不能成为记忆");
    await click(panel, "[data-memory-ask-answer=remember]");
    let memory = await until(async () => (await readMemories()).find(e => e.text === HABIT && e.status === "active"), 15_000, "确认做法入库");
    assert.ok(memory.sourceQuote);
    assert.equal(memory.kind, "method");
    if (real) memory = await editMemory(panel, memory, HABIT, "github.com");
    else if (!staleOnly) {
      // 负向样本只放在隔离扩展的持久层，不伪造卡片；正向记忆始终来自刚才的真实确认按钮。
      const negative = ["expired", "future", "task", "other_host", "not_here", "experience", "no_source"].map((kind, i) => {
        const entry: MemoryEntry = { ...memory, id: "excluded_" + kind, factId: "excluded_" + kind, text: "不应带入：" + kind, updatedAt: memory.updatedAt + i + 1 };
        if (kind === "expired") entry.validity = { end: Date.now() - 1000 };
        if (kind === "future") entry.validity = { start: Date.now() + 24 * 60 * 60_000 };
        if (kind === "task") entry.validity = { task: "task_fixture" };
        if (kind === "other_host") entry.scope = { kind: "site", hostname: "other.example" };
        if (kind === "not_here") entry.notOnHosts = ["127.0.0.1"];
        if (kind === "experience") entry.experience = { runId: "fixture_run", evidence: ["一段未经确认的任务经验"] };
        if (kind === "no_source") delete entry.sourceQuote;
        return entry;
      });
      await rp.evaluate(panel, "new Promise((ok,no)=>{const r=indexedDB.open('sideagent-memory');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('kv','readwrite');const store=tx.objectStore('kv');const q=store.get('memories');q.onsuccess=()=>{const doc=JSON.parse(q.result);doc.entries.push(..."+ JSON.stringify(negative) +");doc.rev++;doc.methodRev=(doc.methodRev??0)+1;store.put(JSON.stringify(doc),'memories')};tx.oncomplete=()=>{db.close();ok(true)};tx.onerror=()=>no(tx.error)}})");
    }
    evidence.confirmedMemory = memory;
    await fresh();
    await rp.evaluate(panel, "chrome.storage.local.set({sideagent_nudge:true}).then(()=>true)");

    if (!staleOnly) {
      mark(real ? "real website and model" : "prepare");
      if (real) {
        const plan = await loadModelPlan(DEFAULT_TEST_MODEL);
        await rp.evaluate(panel, "chrome.storage.local.set(" + JSON.stringify(modelStorageItems(plan)) + ").then(()=>true)");
        await ready();
        await readPage("https://github.com/mermaid-js/mermaid");
      } else {
        await rp.cdp.send("Target.createTarget", { url: origin + "/project-one/docs", background: true });
        await readPage("/project-one");
      }
      const current = await waitCard();
      evidence.offer = current;
      assert.equal(current.card.preparation!.memory.id, memory.id, "引用真正确认的那条做法");
      assert.equal(current.card.preparation!.memory.version, memory.version, "引用做法当前版本");
      if (!real) assert.deepEqual(inputs.at(-1)?.methods.map(m => m.id), [memory.id], "过期、未确认、经验和其他网站做法均未带给模型");
      await rp.screenshot(panel, join(artifacts, "after.png"));
      await click(panel, ".pc:not(.pc-result) .pc-memory summary");
      assert.equal(await rp.evaluate(panel, "document.querySelector('.pc-memory p')?.textContent"), HABIT);
      await click(panel, ".pc-memory-edit");
      await until(async () => await rp.evaluate(panel, "document.querySelector('#memory-search')?.value===" + JSON.stringify(HABIT) + " && !!document.querySelector('[data-memory-action=edit]')") || undefined, 15_000, "来源进入真实记忆管理");
      await rp.screenshot(panel, join(artifacts, "memory-source.png"));
      await click(panel, "#memory-close");
      await rp.cdp.send("Page.reload", {}, panel);
      await ready();
      await waitCard();
      const beforeTabs = await tabs();
      if (!real) {
        const window = await rp.evaluate(panel, "chrome.windows.create({url:" + JSON.stringify(origin + "/other-window") + ",focused:false}).then(w=>({id:w.id}))");
        await rp.evaluate(panel, "chrome.sidePanel.open({windowId:" + window.id + "}).then(()=>true)", { userGesture: true });
        const target = await until(async () => (await rp.targets()).find(t => t.url.startsWith("chrome-extension://" + rp.extensionId + "/sidepanel.html") && t.targetId !== panelTarget), 15_000, "第二窗口真实侧栏");
        panel2 = await rp.attach(target.targetId);
        await ready(panel2);
        await click(panel2, "#conversation-switcher");
        await click(panel2, 'button[data-conversation-id="' + current.conversationId + '"]');
        await until(async () => await rp.evaluate(panel2, "!!document.querySelector(" + JSON.stringify(cardSelector) + ")") || undefined, 15_000, "两窗口同一张建议");
      }
      const requestsBeforeClick = model.requests.length;
      const clickedAt = Date.now();
      if (panel2) await Promise.all([click(panel, cardSelector), click(panel2, cardSelector)]);
      else await click(panel, cardSelector);
      const completed = await until(async () => (await receipts()).find(r => r.card.id === current.card.id && r.result.state !== "opening"), 25_000, "入口真实打开");
      assert.equal(completed.result.state, "opened", completed.result.message);
      const afterTabs = await tabs();
      assert.ok(beforeTabs.every(tab => afterTabs.some(after => after.id === tab.id)), "原有标签页全部保留");
      assert.ok(completed.result.opened.length > 0);
      for (const link of current.card.preparation!.links) assert.ok(afterTabs.some(tab => tab.url.split("#")[0] === link.url.split("#")[0]), "对应入口实际存在：" + link.url);
      if (!real) {
        assert.equal(completed.result.opened.length, 2, "双窗口同时按只新增缺少的两个入口");
        assert.equal(completed.result.reused.length, 1);
        assert.equal(model.requests.length, requestsBeforeClick, "点击后没有新增一轮模型请求");
      }
      assert.ok((completed.result.firstActionAt ?? 0) >= clickedAt);
      evidence.prepared = completed;
      evidence.timings = { suggestionMs: current.at - (current.requestedAt ?? current.at), firstActionMs: (completed.result.firstActionAt ?? completed.result.clickedAt) - completed.result.clickedAt, completedMs: (completed.result.completedAt ?? completed.result.clickedAt) - completed.result.clickedAt };
      await rp.screenshot(panel, join(artifacts, "prepared.png"));
      if (real) {
        evidence.pages = [];
        for (const item of completed.result.opened) {
          const loaded = await until(async () => {
            const current = (await receipts()).find(r => r.card.id === completed.card.id)?.result.opened.find(t => t.tabId === item.tabId);
            return current?.loaded ? current : undefined;
          }, 30_000, "真实入口加载：" + item.title);
          const target = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url.split("#")[0] === loaded.actualUrl.split("#")[0]), 5000, "实际加载后的页面");
          const session = await rp.attach(target.targetId);
          const page = await rp.evaluate(session, "({url:location.href,title:document.title,text:document.body?.innerText.slice(0,600)})");
          (evidence.pages as unknown[]).push(page);
          assert.ok(page.text?.length > 40 && !page.text.includes("ERR_"), "入口有真实内容：" + item.title);
        }
      } else {
        const used = completed.result.opened[0]!;
        await rp.evaluate(panel, "chrome.tabs.update(" + used.tabId + ",{active:true}).then(()=>true)");
        await until(async () => (await receipts()).find(r => r.card.id === current.card.id)?.result.opened.find(t => t.tabId === used.tabId)?.canUndo === false || undefined, 5000, "用户用过的标签页保留");
      }
      await click(panel2 || panel, '.pc-result[data-nudge-id="' + current.card.id + '"] .pc-undo');
      const undone = await until(async () => (await receipts()).find(r => r.card.id === current.card.id && r.result.state === "undone"), 10_000, "撤回完成");
      const kept = await tabs();
      assert.ok(beforeTabs.every(tab => kept.some(after => after.id === tab.id)), "撤回仍保留原有页面");
      if (!real) {
        assert.ok(kept.some(tab => tab.id === completed.result.opened[0]!.tabId), "已使用的新增标签页保留");
        assert.ok(!kept.some(tab => tab.id === completed.result.opened[1]!.tabId), "未使用的新增标签页收起");
      } else assert.ok(completed.result.opened.every(item => !kept.some(tab => tab.id === item.tabId)));
      evidence.undone = undone;
      await rp.screenshot(panel, join(artifacts, "undone.png"));
      await rp.cdp.send("Page.reload", {}, panel);
      await ready();
      await until(async () => await rp.evaluate(panel, "!!document.querySelector('[data-nudge-result=undone]')") || undefined, 10_000, "重开仍显示结果");
      assert.equal(await rp.evaluate(panel, "!!document.querySelector(" + JSON.stringify(cardSelector) + ")"), false, "重放不再给执行按钮");
    }

    if (!real && !staleOnly) {
      mark("switch off while opening");
      await readPage("/project-switch");
      const switching = await waitCard();
      await rp.evaluate(panel, "(()=>{const id=" + JSON.stringify(switching.card.id) + ";const onChange=(changes,area)=>{if(area!=='session')return;const item=changes.sideagent_nudge_results?.newValue?.find(r=>r.card.id===id);if(item?.result.state==='opening'&&item.result.opened.length===1){chrome.storage.onChanged.removeListener(onChange);chrome.storage.local.set({sideagent_nudge:false})}};chrome.storage.onChanged.addListener(onChange);return true})()");
      await click(panel, cardSelector);
      const stopped = await until(async () => (await receipts()).find(r => r.card.id === switching.card.id && r.result.state === "stopped"), 12_000, "关闭建议后保留部分结果");
      assert.ok(stopped.result.opened.length >= 1, "至少一个入口已打开才触发关闭");
      await until(async () => await rp.evaluate(panel, "!!document.querySelector(" + JSON.stringify('.pc-result[data-nudge-id="' + switching.card.id + '"] .pc-undo') + ")") || undefined, 5000, "关闭总开关仍可撤回");
      await click(panel, '.pc-result[data-nudge-id="' + switching.card.id + '"] .pc-undo');
      await until(async () => (await receipts()).find(r => r.card.id === switching.card.id && r.result.state === "undone"), 8000, "撤回部分打开");
      evidence.switchOffPreservesResult = true;
      await rp.evaluate(panel, "chrome.storage.local.set({sideagent_nudge:true}).then(()=>true)");
    }

    if (!real) {
      mark("stale memory");
      await readPage("/project-stale");
      const stale = await waitCard();
      if (!panel2) {
        const window = await rp.evaluate(panel, "chrome.windows.create({url:" + JSON.stringify(origin + "/other-window") + ",focused:false}).then(w=>({id:w.id}))");
        await rp.evaluate(panel, "chrome.sidePanel.open({windowId:" + window.id + "}).then(()=>true)", { userGesture: true });
        const target = await until(async () => (await rp.targets()).find(t => t.url.startsWith("chrome-extension://" + rp.extensionId + "/sidepanel.html") && t.targetId !== panelTarget), 15_000, "另一窗口");
        panel2 = await rp.attach(target.targetId);
        await ready(panel2);
        await click(panel2, "#conversation-switcher");
        await click(panel2, 'button[data-conversation-id="' + stale.conversationId + '"]');
      }
      const unchangedTabs = await tabs();
      memory = await editMemory(panel2, memory, NEW_HABIT);
      await until(async () => await rp.evaluate(panel, "!document.querySelector(" + JSON.stringify(cardSelector) + ")") || undefined, 8000, "另一窗口改习惯后旧建议失效");
      const late = await rp.evaluate(panel, "chrome.runtime.sendMessage({type:'NUDGE_ACT',id:" + JSON.stringify(stale.card.id) + "})");
      assert.equal(late.ok, false, "迟到的旧点击不执行");
      assert.deepEqual((await tabs()).map(tab => tab.id).sort(), unchangedTabs.map(tab => tab.id).sort());
      evidence.stale = { oldId: stale.card.id, reply: late, memoryVersion: memory.version };
      if (!staleOnly) {
        mark("new habit and dismiss");
        await readPage("/project-new");
        const updated = await waitCard();
        assert.equal(updated.card.preparation!.memory.text, NEW_HABIT);
        assert.equal(updated.card.preparation!.links[0]!.title, "示例");
        assert.ok(await rp.evaluate(panel, "!!document.querySelector('[data-nudge-result=undone]')"), "新建议不顶掉之前的撤回结果");
        await click(panel, ".pc:not(.pc-result) .pc-x");
        await until(async () => !(await offer()) || undefined, 5000, "收起建议");
        const count = inputs.length;
        await navigate("/project-new"); await rp.evaluate(work, "window.scrollBy(0,400);true");
        await sleep(17_000);
        assert.equal(inputs.length, count, "同一浏览器会话同 URL 收起后不再判断");
        await click(panel2, "#memory-open");
        await click(panel2, '[data-memory-action="forget"][data-memory-id="' + memory.id + '"]');
        await until(async () => await rp.evaluate(panel2, "!!document.querySelector(" + JSON.stringify('[data-memory-action="confirm-forget"][data-memory-id="' + memory.id + '"]') + ")") || undefined, 5000, "删除确认展开");
        await click(panel2, '[data-memory-action="confirm-forget"][data-memory-id="' + memory.id + '"]');
        await until(async () => !(await readMemories()).some(e => e.id === memory.id) || undefined, 8000, "删除真实记忆");
        await click(panel2, "#memory-close");
        await readPage("/project-deleted");
        await until(async () => inputs.length > count || undefined, 35_000, "删除后再次判断");
        await until(async () => model.requests.filter(r => r.rule === nudgeRule.match).at(-1)?.finished || undefined, 5000, "删除后模型回复结束");
        await sleep(800);
        assert.equal(inputs.at(-1)!.methods.length, 0);
        assert.equal(await rp.evaluate(panel, "!!document.querySelector(" + JSON.stringify(cardSelector) + ")"), false, "模型伪造已删除习惯不能出卡");
        evidence.dismissedAndDeleted = true;
      }
    }
  }
  mark("done");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) {
    await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => {});
    evidence.ui = await rp.evaluate(panel, "document.body.innerText.slice(-9000)").catch(() => "");
    evidence.storedOffer = await offer().catch(() => null);
    evidence.receipts = await receipts().catch(() => []);
    evidence.currentMemories = await readMemories().catch(() => []);
    if (panel2) {
      await rp.screenshot(panel2, join(artifacts, "failure-second-window.png")).catch(() => {});
      evidence.secondWindowUi = await rp.evaluate(panel2, "document.body.innerText.slice(-9000)").catch(() => "");
    }
  }
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error, inputs, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
