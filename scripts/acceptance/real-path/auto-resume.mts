/**
 * 重启后等待用户检查页面并手动继续。脚本模型、隔离真实扩展与虚构表单。
 * npx tsx scripts/acceptance/real-path/auto-resume.mts --headless
 * 加 --stop 验证继续后停止；加 --changed-page 验证换页后拒绝继续。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, type Json, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const STOP = process.argv.includes("--stop");
const CHANGED_PAGE = process.argv.includes("--changed-page");

const GOAL = "自动接续验收：把这页 5 个输入框依次填好。";

/** 页面每收到一次 change 就报给本机服务：服务端按字段计数，判断有没有重复填写。 */
const fills: Record<string, number> = {};
const writes: Array<{ field: string; page: string; value: string }> = [];

const html = `<!doctype html><meta charset="utf-8"><title>五个输入框</title>${[1, 2, 3, 4, 5].map((i) => `<p><label>字段${i} <input id="f${i}" name="f${i}"></label></p>`).join("")}
<script>document.addEventListener("input", (e) => fetch("/fill?f=" + e.target.id + "&page=" + encodeURIComponent(location.pathname) + "&value=" + encodeURIComponent(e.target.value), { method: "POST" }));</script>`;

const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");


  if (url.pathname !== "/fill") { res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(html);

    return; }

  const f = url.searchParams.get("f") ?? "?";
  fills[f] = (fills[f] ?? 0) + 1;
  writes.push({field:f,page:url.searchParams.get("page")??"",value:url.searchParams.get("value")??""});
  res.writeHead(204).end();
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const fill = (i: number, delayMs = 0) => ({ tool: { name: "fill", args: { target: `#f${i}`, value: `值${i}` } }, delayMs });

// 第 4 步挂起几秒：关掉 offscreen 时模型这一步还没回。
const rules = [{ match: "自动接续验收", steps: [fill(1), fill(2), fill(3), fill(4, 6000), fill(5), { text: "5 个都填好了。" }] }];
const resumeInputs: string[] = [];
const model = await startScriptedModel(rules, undefined, (payload) => {
  const text=JSON.stringify(payload.messages);
  if(text.includes("[RESTART CONTINUATION]")) {
    if(!resumeInputs.length) resumeInputs.push(text);
    rules[0]!.steps=[fill(4,6000),fill(5),{text:"5 个都填好了。"}];
  }
});

const out = join(REPO, "out/acceptance/real-path", new Date().toISOString().replace(/[:.]/g, "-") + (CHANGED_PAGE ? "-manual-resume-changed-page" : STOP ? "-manual-resume-stop" : "-manual-resume"));

await mkdir(out, { recursive: true });

const rp = await launchRealPath();

let panel = "", failure: string | null = null;

let logs: Awaited<ReturnType<typeof watchInproc>> | undefined, logsAfter: typeof logs;

/** result.json 的内容。 */
type Evidence = { before?: Json; waiting?: Json; after?: Json; final?: Json; reopenedTask?: boolean; pass?: boolean; failure?: string; modelRequests?: Json; writes?: Json; resumedAfterClick?: boolean; mode?: string };

const evidence: Evidence = {};
let automaticWait = false;

// SAFETY: 表达式返回的就是这两个字符串字段。
const state = () => rp.evaluate(panel, `(() => { const r = document.querySelector("#resume-entry-root");
  return { resumeText: r?.hidden ? "" : r?.innerText.trim() ?? "", resumeButton: !r?.hidden && !!r?.querySelector(".resume-action"),
    messages: document.querySelector("#messages")?.innerText ?? "" }; })()`) as Promise<{ resumeText: string; resumeButton: boolean; messages: string }>;

/** 重启后侧栏有时落到新会话，原任务只剩顶部一条「… ↗」：点它回到原任务会话。返回是否点了。 */
const showTask = async () => {
  const away = await rp.evaluate(panel, `(() => { const b = document.querySelector("#conversation-background");
    return !!b && !b.hidden && b.textContent.includes(${JSON.stringify(GOAL.slice(0, 6))}); })()`);

  if (away) await rp.click(panel, "#conversation-background");

  return away === true;
};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`) || undefined, 30_000, "侧栏可发送");
  await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "test-key" } }, { asCustom: true, baseUrl: model.baseUrl });
  logs = await watchInproc(rp, rp.extensionId);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, GOAL);
  await rp.pressEnter(panel);

  // SAFETY: 表达式返回 5 个输入框的 value 字符串。
  const values = () => rp.evaluate(work, `[1,2,3,4,5].map((i) => document.querySelector("#f" + i).value)`) as Promise<string[]>;
  await until(async () => {
    const v = await values();
    return v[0] === "值1" && v[1] === "值2" && v[2] === "值3" && !v[3] && !v[4]
      && model.requests.some(r => r.rule === "自动接续验收" && r.step === 3 && !r.finished) || undefined;
  }, 30_000, "前三项已填、第四步仍在等待模型", 50);
  evidence.before = { values: await values(), fills: { ...fills } };
  await rp.screenshot(panel, join(out, "before.png"));
  assert.deepEqual(await values(), ["值1", "值2", "值3", "", ""], "重启必须发生在第四项执行前");

  // 只重启扩展内 agent：关掉 offscreen 文档，浏览器、标签页、侧栏都留着。
  const inproc = (await rp.targets()).find((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`);
  assert.ok(inproc, "找不到 offscreen 文档");

  const requestsBeforeRestart = model.requests.filter(r=>r.rule==="自动接续验收").length;
  await rp.cdp.send("Target.closeTarget", { targetId: inproc.targetId });
  const closedAt = Date.now();
  await until(async () => (await rp.targets()).some((t) => t.url === inproc.url && t.targetId !== inproc.targetId) || undefined, 30_000, "扩展内 agent 重新起来");
  logsAfter = await watchInproc(rp, rp.extensionId);

  await until(async () => { evidence.reopenedTask ||= await showTask();
    return (await state()).resumeButton || undefined; }, 15_000, "侧栏出现「继续原任务」");
  const requestsBeforeClick = model.requests.length;
  await sleep(7000);
  evidence.waiting={values:await values(),fills:{...fills},panel:await state(),requestsBeforeRestart,requestsBeforeClick,requestsAfterWait:model.requests.length};
  assert.deepEqual(await values(), ["值1","值2","值3","",""], "未手动继续前不得自动写入");
  automaticWait=model.requests.filter(r=>r.rule==="自动接续验收").length===requestsBeforeRestart;
  console.log("未手动点击前主任务模型请求增量："+(model.requests.filter(r=>r.rule==="自动接续验收").length-requestsBeforeRestart));
  assert.deepEqual([fills.f1,fills.f2,fills.f3],[1,1,1],"前三项必须各真实写入一次");
  if(CHANGED_PAGE){
    await rp.cdp.send("Page.navigate",{url:`http://127.0.0.1:${siteAddress(site).port}/other`},work);
    await until(async()=>await rp.evaluate(work,'location.pathname === "/other" && !!document.querySelector("#f1")')||undefined,10000,"新页面就绪");
  }
  await rp.click(panel, "#resume-entry-root .resume-action");
  console.log("已手动点击继续，检查"+(CHANGED_PAGE?"换页拒绝":STOP?"停止":"剩余字段"));

  if (CHANGED_PAGE) {
    await sleep(7000);
    const changed = await values();
    evidence.final = { values: changed, fills: { ...fills }, panel: await state() };
    assert.deepEqual(changed, ["", "", "", "", ""], "页面身份变化后不得继续写入");
    assert.equal(model.requests.length,requestsBeforeClick,"换页拒绝必须发生在模型续做前");
    assert.ok((await state()).resumeText.includes("原任务") && (await state()).resumeText.includes("页面"),"应向用户说明原页面不匹配");
    assert.equal(writes.filter(w=>w.page==="/other").length,0,"新页面真实写入计数必须为0");
    evidence.pass = true;
  } else if (STOP) {
    await until(async () => model.requests.length > requestsBeforeClick && resumeInputs.length > 0 || undefined, 15_000, "重启后的模型请求已开始");
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.classList.contains("stopping") === true') || undefined, 15_000, "续做期间停止键出现");
    await rp.click(panel, "#send-btn");
    await sleep(7000);
    const stopped = await values();
    evidence.final = { values: stopped, fills: { ...fills }, panel: await state() };
    assert.deepEqual(stopped, ["值1", "值2", "值3", "", ""], "停止后不能继续填写");
    assert.deepEqual([fills.f1, fills.f2, fills.f3], [1, 1, 1], "已填字段不能重做");
    evidence.pass = true;
  } else {
  const filled = await until(async () => { const v = await values();

    return v[3] && v[4] ? v : undefined; }, 12_000, "字段 4、5 手动继续后填好").catch(async () => values());

  evidence.after = { values: filled, fills: { ...fills }, secondsAfterRestart: (Date.now() - closedAt) / 1000, panel: await state() };
  await rp.screenshot(panel, join(out, "after.png"));
  assert.deepEqual(filled, ["值1", "值2", "值3", "值4", "值5"], `手动继续后没有填完：${JSON.stringify(filled)}；侧栏：${JSON.stringify((await state()).resumeText)}`);
  assert.deepEqual([fills.f1, fills.f2, fills.f3, fills.f4, fills.f5], [1, 1, 1, 1, 1], `每个字段必须只真实填写一次：${JSON.stringify(fills)}`);
  assert.ok(resumeInputs[0]?.includes("[FRESH PAGE OBSERVATION"),"手动继续前必须重新读取当前页面");
  assert.ok(resumeInputs[0]?.includes("值1")&&resumeInputs[0]?.includes("值2")&&resumeInputs[0]?.includes("值3"),"继续模型必须看到页面已有填写值");
  // 任务结束后（回答已出现），侧栏应当说做完了：不说「没做成」，不再给「继续原任务」。
  await until(async () => { evidence.reopenedTask ||= await showTask();

    return (await state()).messages.includes("5 个都填好了。") || undefined; }, 30_000, "原任务会话里出现回答");
  await sleep(1500);
  const final = await state();
  evidence.final = { resumeText: final.resumeText, resumeButton: final.resumeButton };
  await rp.screenshot(panel, join(out, "final.png"));
  assert.ok(!final.resumeText.includes("没做成") && !final.resumeButton, `5 个都填好了，侧栏却说：${JSON.stringify(final.resumeText)}`);
  evidence.pass = true;
  }
} catch (e) {
  failure = String(e); evidence.pass = false; evidence.failure = failure;

  await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
  console.error(e);
} finally {
  if (logs) await writeFile(join(out, "inproc.log"), logs.logs()).catch(() => {});

  if (logsAfter) await writeFile(join(out, "inproc-after-restart.log"), logsAfter.logs()).catch(() => {});
  if(evidence.pass&&!automaticWait){evidence.pass=false;evidence.failure="未手动继续就自动调用了主任务模型";failure=evidence.failure;}
  evidence.modelRequests = model.requests;
  evidence.writes=writes;
  evidence.mode=CHANGED_PAGE?"changed-page":STOP?"stop":"manual";
  evidence.resumedAfterClick=resumeInputs.length>0;
  await writeFile(join(out,"resume-inputs.json"),JSON.stringify(resumeInputs,null,2));
  await writeFile(join(out, "result.json"), JSON.stringify(evidence, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}

console.log(out);

if (failure) process.exitCode = 1;
