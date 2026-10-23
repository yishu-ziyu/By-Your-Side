/**
 * 真扩展 + 隔离 Chrome + 脚本模型 + 拦截成练习页的 flomo：「记进 flomo」的内置方法。
 * 判定：在别的网站上说要记 flomo 时，模型能拿到 flomo.add-memo；方法新开 flomo 标签页、填写、点发送，读回新笔记才算记上；
 * 点了发送但列表里没出现时报 unconfirmed 且只点一次；没登录时报 login_required、什么都不写；用户原来的页面不被换走。
 * 「记下来」没说去处（用户 10-23 定：两个都记）：脚本模型照产品给的上下文办事——提供了 flomo.add-memo 才调它，
 * 上下文里有「Noting something down」才写兴趣记忆；判定只看用户看得到的：flomo 列表里的新笔记（要点 + 来源链接）、
 * 记忆面板里的「对……感兴趣」、回答里两件各自的结果。flomo 没登录时回答说没记进 flomo、记忆照写；
 * 点名「记进 flomo」时即使模型多调一次兴趣记忆也不写。
 *   npx tsx scripts/acceptance/real-path/flomo-memo.mts --headless [--case=saved|lost|signed-out|record|record-signed-out|record-named]
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel, type Rule, type Step, type TextStep } from "./scripted-model.mts";

requireHeadless();
const only = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-flomo-memo`);
await mkdir(out, { recursive: true });
const cases = [
  { id: "saved", mode: "ok", expected: '"status":"observed"', also: ['"memoId":"m3"'], clicks: 1 },
  // 只出现本地占位、一直没换成正式编号：不能算记上。
  { id: "unsynced", mode: "local", expected: '"status":"unconfirmed"', also: ["has not synced"], clicks: 1 },
  { id: "lost", mode: "lost", expected: '"status":"unconfirmed"', also: ["Do not send again"], clicks: 1 },
  { id: "signed-out", mode: "out", expected: '"status":"login_required"', also: [], clicks: 0 },
].filter(c => !only || c.id === only);
const ARTICLE = "https://article.example/post";
const recordCases = [
  { id: "record", say: "把这段的要点帮我记下来 甲", mode: "ok", topic: "命令行工具的 Skill 设计", points: "要点甲：命令行工具加一份 README 就是一个 Skill", memo: true, memory: true, greedy: false },
  { id: "record-signed-out", say: "把这段的要点帮我记下来 乙", mode: "out", topic: "阅读时做标注的方法", points: "要点乙：读文章时先标出感兴趣的段落", memo: false, memory: true, greedy: false },
  // 点名 flomo：模型就算多调一次兴趣记忆，也不该写进去。
  { id: "record-named", say: "这段的要点记进flomo 丙", mode: "ok", topic: "丙主题不该进记忆", points: "要点丙：只记 flomo", memo: true, memory: false, greedy: true },
].filter(c => !only || c.id === only);
const MEMO = "命令行工具加一份 README，本质上就是一个 Skill。";
const textOf = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => typeof part?.text === "string" ? part.text : "").join("") : "";
const replies = new Map<string, TextStep>();
let offered = false;
const rules: Rule[] = cases.map(c => {
  const reply = { text: "等待真实工具结果" }; replies.set(c.id, reply);
  return { match: `记进flomo ${c.id}`, steps: [{ tool: { name: "browser_run", args: { label: c.id, code: `return await browser.siteMethod(${JSON.stringify({ id: "flomo.add-memo", text: MEMO })});` } } }, reply] };
});
// 记下来的三条：首个主任务请求时按产品给的上下文排好步骤，最后一步按两件事各自的工具结果写回答。
const recordReplies = new Map<string, TextStep>();
const recordOffered = new Map<string, boolean>();
for (const c of recordCases) {
  const reply = { text: "等待真实工具结果" }; recordReplies.set(c.id, reply);
  rules.push({ match: c.say, steps: [reply] });
}
const model = await startScriptedModel(rules, undefined, payload => {
  const all = JSON.stringify(payload);
  if (all.includes("flomo.add-memo v1")) offered = true;
  const messages = payload.messages ?? [];
  const asked = [...messages].reverse().find(message => message.role === "user" && recordCases.some(c => textOf(message.content).includes(c.say)));
  const rc = asked ? recordCases.find(c => textOf(asked.content).includes(c.say)) : undefined;
  if (rc && payload.tools?.length) {
    const rule = rules.find(r => r.match === rc.say)!;
    const results = messages.slice(messages.indexOf(asked!) + 1).filter(message => message.role === "tool").map(message => textOf(message.content));
    if (!results.length) {
      const flomoOffered = all.includes("flomo.add-memo v1");
      recordOffered.set(rc.id, flomoOffered);
      const plan: Step[] = [];
      if (flomoOffered) plan.push({ tool: { name: "browser_run", args: { label: rc.id, code: `return await browser.siteMethod(${JSON.stringify({ id: "flomo.add-memo", text: rc.points, source: true })});` } } });
      if (rc.greedy || all.includes("Noting something down")) plan.push({ tool: { name: "user_memory", args: { action: "interest", topic: rc.topic } } });
      rule.steps.splice(0, rule.steps.length, ...plan, recordReplies.get(rc.id)!);
    }
    const flomoResult = results.find(text => text.includes("flomo.add-memo")) ?? "";
    const memoryResult = results.find(text => !text.includes("flomo.add-memo")) ?? "";
    const flomoLine = /"status":"observed"/.test(flomoResult) ? "记进 flomo 了" : flomoResult ? `没记进 flomo：${flomoResult.match(/"status":"(\w+)"/)?.[1] ?? "出错"}` : "没有调用 flomo";
    const memoryLine = /已记住|早已记着/.test(memoryResult) ? `也记住了你对${rc.topic}感兴趣` : memoryResult ? `记忆没写：${memoryResult.slice(0, 80)}` : "没有写记忆";
    recordReplies.get(rc.id)!.text = `${flomoLine}；${memoryLine}。记下来结束。`;
  }
  const task = [...messages].reverse().find(message => message.role === "user" && textOf(message.content).includes("记进flomo "));
  const result = [...messages].reverse().find(message => message.role === "tool");
  const id = task ? cases.find(c => textOf(task.content).includes(`记进flomo ${c.id}`))?.id ?? "" : "";
  if (result && replies.has(id)) replies.get(id)!.text = `工具实际返回：\n\n\`\`\`text\n${textOf(result.content)}\n\`\`\`\n本次记录结束。`;
});
let mode = "ok";
// 练习页：编辑器有字时才显示第二个发送按钮；点它把内容加成列表最前面的一条（lost 模式什么都不加）。置顶笔记永远在最上面。
const flomo = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>flomo</title><body>${mode === "out" ? "<a href='/login'>登录</a>" : `
<div id="fl_editor" class="input-box"><div class="editor-content"><div class="tiptap ProseMirror" contenteditable="true"></div></div>
<div class="editor-menu-bar"><div class="pin-right"><svg class="el-tooltip saveBtn" width="0" height="0"></svg><svg class="saveBtn" width="20" height="20" style="display:none"><rect width="20" height="20"/></svg></div></div></div>
<div class="memos"><div class="memos-list">
<div class="memo"><div class="normal"><div class="header"><a class="time" href="/mine/?memo_id=m1">置顶・2026-06-11</a></div><div class="richText">置顶的旧笔记</div></div></div>
<div class="memo"><div class="normal"><div class="header"><a class="time" href="/mine/?memo_id=m2">2026-10-20</a></div><div class="richText">昨天的笔记</div></div></div>
</div></div>
<script>
const ed=document.querySelector('.tiptap'), btn=document.querySelectorAll('.saveBtn')[1];
new MutationObserver(()=>{btn.style.display=ed.textContent.trim()?'':'none'}).observe(ed,{childList:true,subtree:true,characterData:true});
ed.addEventListener('input',()=>{btn.style.display=ed.textContent.trim()?'':'none'});
window.__clicks=0;
btn.addEventListener('click',()=>{window.__clicks++;const t=ed.innerText.trim();ed.textContent='';btn.style.display='none';
 if(${JSON.stringify(mode)}==='lost')return;
 const list=document.querySelector('.memos-list');const m=document.createElement('div');m.className='memo';
 m.innerHTML='<div class="normal"><div class="header"><a class="time" href="/mine/?memo_id=local_1">刚刚</a></div><div class="richText"></div></div>';
 m.querySelector('.richText').textContent=t;list.insertBefore(m,list.children[1]);
 if(${JSON.stringify(mode)}!=='local')setTimeout(()=>m.querySelector('a.time').setAttribute('href','/mine/?memo_id=m3'),800);});
</script>`}</body></html>`;
// 方法会新开 flomo 标签页，新页面不在拦截范围里：用本机 https 练习站（临时自签名证书）加域名映射顶替 v.flomoapp.com。
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=v.flomoapp.com", "-keyout", join(out, "key.pem"), "-out", join(out, "cert.pem")], { stdio: "ignore" });
const site = createServer({ key: await readFile(join(out, "key.pem")), cert: await readFile(join(out, "cert.pem")) }, (_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(flomo()));
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP v.flomoapp.com 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server", "--ignore-certificate-errors"] });
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
let panel = "";
try {
  const work = await rp.attach((await rp.targets()).find(target => target.url === "about:blank")!.targetId);
  rp.cdp.onEvent("Fetch.requestPaused", (event: { sessionId?: string; params: { requestId: string; request: { url: string } } }) => {
    const url = new URL(event.params.request.url);
    const body = `<!doctype html><meta charset="utf-8"><title>正在读的文章</title><h1>正在读的文章</h1><p>命令行工具加一份 README。</p>`;
    void rp.cdp.send("Fetch.fulfillRequest", { requestId: event.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }], body: Buffer.from(body).toString("base64") }, event.sessionId);
  });
  await rp.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://article.example/*", requestStage: "Request" }] }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })})`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(() => rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  for (const c of cases) {
    mode = c.mode;
    for (const t of await rp.targets()) if (t.type === "page" && t.url.includes("flomoapp.com")) await rp.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    await rp.cdp.send("Page.navigate", { url: "https://article.example/post" }, work);
    await until(() => rp.evaluate(work, 'document.readyState==="complete"'), 15_000, c.id + " 文章页");
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#conversation-new");
    await until(() => rp.evaluate(panel, ready), 20_000, "新会话就绪");
    await rp.click(panel, "#input"); await rp.typeText(panel, `记进flomo ${c.id}`); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("本次记录结束")`), 60_000, c.id + " 侧栏交付");
    const text = String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("\\n")'));
    check(c.id + " 结果", text.includes(c.expected) && c.also.every(part => text.includes(part)), { text: text.slice(0, 900) });
    const tabs = (await rp.targets()).filter(t => t.type === "page");
    const flomoTab = tabs.find(t => t.url.includes("flomoapp.com"));
    check(c.id + " 原来的文章页还在", String(await rp.evaluate(work, "location.href")) === "https://article.example/post", tabs.map(t => t.url) as Json);
    if (flomoTab) {
      const s = await rp.attach(flomoTab.targetId);
      const clicks = await rp.evaluate(s, "window.__clicks ?? 0");
      console.log(c.id, "flomo 标签页", JSON.stringify(await rp.evaluate(s, "({title:document.title, practice:!!document.querySelector('.memos-list'), editor:!!document.querySelector('#fl_editor')})")));
      check(c.id + " 发送次数", clicks === c.clicks, clicks as Json);
    } else check(c.id + " 发送次数", c.clicks === 0, "没有 flomo 标签页");
    await rp.screenshot(panel, join(out, c.id + ".png"));
    await until(() => rp.evaluate(panel, ready), 25_000, c.id + " 收尾");
  }
  if (cases.length) check("在别的网站上提到 flomo 时提供了 flomo.add-memo", offered, offered);
  for (const c of recordCases) {
    mode = c.mode;
    for (const t of await rp.targets()) if (t.type === "page" && t.url.includes("flomoapp.com")) await rp.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    await rp.cdp.send("Page.navigate", { url: ARTICLE }, work);
    await until(() => rp.evaluate(work, 'document.readyState==="complete"'), 15_000, c.id + " 文章页");
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#conversation-new");
    await until(() => rp.evaluate(panel, ready), 20_000, "新会话就绪");
    await rp.click(panel, "#input"); await rp.typeText(panel, c.say); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("记下来结束")`), 90_000, c.id + " 侧栏交付");
    const answer = String(await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].map(m=>m.textContent).join("\\n")'));
    const flomoTab = (await rp.targets()).find(t => t.type === "page" && t.url.includes("flomoapp.com"));
    const list = flomoTab ? String(await rp.evaluate(await rp.attach(flomoTab.targetId), "document.querySelector('.memos-list')?.innerText ?? ''")) : "";
    check(c.id + " flomo 列表", c.memo ? list.includes(c.points) && (c.greedy || list.includes(ARTICLE)) : !list.includes(c.points), { list: list.slice(0, 400), offered: recordOffered.get(c.id) ?? null });
    const said = c.memo ? answer.includes("记进 flomo 了") : answer.includes("没记进 flomo：login_required");
    check(c.id + " 回答说清两件", said && (c.memory ? answer.includes(`也记住了你对${c.topic}感兴趣`) : !answer.includes("也记住了")), { answer: answer.slice(-300) });
    await rp.screenshot(panel, join(out, c.id + ".png"));
    await until(() => rp.evaluate(panel, ready), 25_000, c.id + " 收尾");
  }
  if (recordCases.length) {
    // 用户在记忆面板里看到的条目。
    for (let i = 0; i < 3 && !(await rp.evaluate(panel, `document.querySelector("#header-menu").matches(":popover-open")`)); i += 1) { await rp.click(panel, "#header-more"); await new Promise(r => setTimeout(r, 400)); }
    await rp.click(panel, "#memory-open");
    const memories = String(await until(async () => (await rp.evaluate(panel, `(() => { const t = document.querySelector("#memory-body")?.innerText ?? ""; return t.length > 0 && !t.includes("正在读取") ? t : ""; })()`)) || undefined, 15_000, "记忆面板读完"));
    await rp.screenshot(panel, join(out, "memory-panel.png"));
    for (const c of recordCases) check(c.id + " 记忆面板", (memories.includes(`对${c.topic}感兴趣`) && !memories.includes(`用户对${c.topic}感兴趣`)) === c.memory, { memories: memories.slice(0, 600) });
  }
} catch (error) {
  check("流程完成", false, String(error));
  if (panel) await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
}
finally { await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, replies: Object.fromEntries(replies), recordReplies: Object.fromEntries(recordReplies) }, null, 2)); await rp.close(); await rp.remove(); await model.close(); site.close(); }
console.log(`证据：${out}`);
if (!checks.length || checks.some(c => !c.pass)) process.exitCode = 1;
