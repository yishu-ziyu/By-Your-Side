/**
 * 无头、只装扩展；脚本主模型故意写错，真实 GLM 快速模型核对。
 * F1 文件存在便判完成；F2 取到另一日期仍交付；F3 漏数量/来源；
 * F4 正确答案被催重做；F5 改正文却没改文件。期望来自手算及固定任务要求。
 */
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const live = process.argv.includes("--live");

const mainModel = process.argv.find(arg => arg.startsWith("--model="))?.slice(8) ?? "zai-coding-cn/glm-5.3-flash";

const out = join(REPO, "out/acceptance/answer-selfcheck", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(out, { recursive: true });

const source = "省22，直辖市4，自治区5，特别行政区2；数据日期2026-09-30。合计按这四类相加。";

const wrongCsv = "类别,数量\n省,22\n直辖市,4\n自治区,5\n特别行政区,2\n合计,34\n";

const rightCsv = wrongCsv.replace("合计,34", "合计,33");

const cases = [
  { id: "sum", goal: "合计探针：按这页四类数量统计，导出sum.csv，包含各类和合计。", bad: "已导出sum.csv，包含各类和合计。", good: "已纠正合计：22+4+5+2=33，sum.csv 的合计已改为33。" },
  { id: "date", goal: "日期探针：把2026-09-29的数据导出date.csv，CSV必须保留日期。", bad: "指定日期的数据已导出date.csv。", good: "这页只有2026-09-30的数据，没有2026-09-29的数据。刚才保存了错误日期，已删除date.csv。" },
  { id: "items", goal: "产品探针：按单价比较这页三个产品，每个产品单列价格并附上各自来源链接。", bad: "产品甲、产品乙都不错。", good: "产品甲：10元[来源](https://example.com/a)。产品乙：20元[来源](https://example.com/b)。产品丙：30元[来源](https://example.com/c)。" },
  { id: "correct", goal: "正确探针：按这页四类数量算合计并列出各类。", bad: "省22、直辖市4、自治区5、特别行政区2，合计33。", good: "省22、直辖市4、自治区5、特别行政区2，合计33。" },
];

const counts = new Map<string, number>();

const requests: Array<{ id: string; n: number; nudged: boolean; tools: boolean; system: string }> = [];

const main = createServer(async (req, res) => {
  let raw = "";

  for await (const chunk of req) raw += chunk;

  if (req.method !== "POST") { res.end("ok");

 return; }

  const payload = JSON.parse(raw);
  const messages: Array<{ role: string; content?: unknown }> = payload.messages ?? [];
  const last = messages.toReversed().flatMap(m => m.role === "user" ? [JSON.stringify(m.content)] : []).find(text => cases.some(c => text.includes(c.goal))) ?? "";
  const c = cases.find(c => last.includes(c.goal));
  const n = c ? counts.get(c.id) ?? 0 : -1;

  if (c) counts.set(c.id, n + 1);
  const nudged = last.includes("[GOAL CHECK]");

  if (c) requests.push({ id: c.id, n, nudged, tools: !!payload.tools?.length, system: JSON.stringify(messages.find(m => m.role === "system")?.content).slice(0, 140) });
  let text = c?.bad ?? "好的。";
  let call: { name: string; arguments: object } | undefined;

  if (c && n === 0) call = { name: "snapshot", arguments: {} };
  else if (c && n === 1 && (c.id === "sum" || c.id === "date" || c.id === "correct")) call = { name: "artifacts", arguments: { command: "create", filename: `${c.id}.csv`, content: c.id === "sum" ? wrongCsv : c.id === "correct" ? rightCsv : "date,total\n2026-09-30,33\n" } };
  else if (c && nudged) {
    if (c.id === "sum" && n === 3) call = { name: "artifacts", arguments: { command: "rewrite", filename: "sum.csv", content: rightCsv } };
    else if (c.id === "date" && n === 3) call = { name: "artifacts", arguments: { command: "delete", filename: "date.csv" } };
    else text = c.good;
  }

  const message = call ? { role: "assistant", content: null, tool_calls: [{ id: `call_${c?.id}_${n}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: text };
  const finish = call ? "tool_calls" : "stop";

  if (payload.stream === false) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "probe", choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));

 return; }

  res.writeHead(200, { "content-type": "text/event-stream" });
  const delta = call ? { tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : { content: text };
  res.write(`data: ${JSON.stringify({ id: "probe", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ id: "probe", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
});

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<h1>统计与产品</h1><p>${source}</p><ul><li>产品甲，单价10元 <a href="https://example.com/a">来源甲</a></li><li>产品乙，单价20元 <a href="https://example.com/b">来源乙</a></li><li>产品丙，单价30元 <a href="https://example.com/c">来源丙</a></li></ul>`));

await Promise.all([new Promise<void>(r => main.listen(0, "127.0.0.1", r)), new Promise<void>(r => site.listen(0, "127.0.0.1", r))]);

const rp = await launchRealPath({ withoutNativeHost: true });

const checks: Array<{ id: string; pass: boolean; answer: string; ms: number; requests: unknown }> = [];

let error: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "工作页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled === false`)) || undefined, 60_000, "侧栏就绪");

  if (!live) {
    const setup = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "probe", credential: { type: "api_key", key: "local-probe" } }, { baseUrl: `http://127.0.0.1:${siteAddress(main).port}/v1` });
    await rp.cdp.send("Target.closeTarget", { targetId: setup.settingsTargetId });
  }

  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  const plan = await loadModelPlan("zai-coding-cn/glm-5.3-flash");
  const items = modelStorageItems(plan);
  items.inproc_fast_model_config = items.inproc_model_config;

  if (!live) delete items.inproc_model_config;
  else if (mainModel !== "zai-coding-cn/glm-5.3-flash") {
    const [providerId, ...modelParts] = mainModel.split("/");
    const key = process.env.SIDEAGENT_TEST_MAIN_KEY;
    const mainPlan = key ? { providerId: providerId!, modelId: modelParts.join("/"), credential: { type: "api_key", key } } : await loadModelPlan(mainModel);
    Object.assign(items, modelStorageItems(mainPlan));
  }

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(()=>true)`);
  const fast = await rp.evaluate(panel, `chrome.storage.local.get('inproc_fast_model_config').then(s=>s.inproc_fast_model_config)`);

  console.log("fast-model", JSON.stringify(fast));
  await sleep(1000);

  for (const c of cases) {
    await rp.click(panel, "#conversation-new");
    await until(async () => (await rp.evaluate(panel, `document.querySelectorAll('.msg.user').length === 0 && !document.querySelector('#conversation-new').disabled`)) || undefined, 15_000, "新会话");
    const started = Date.now();
    await rp.click(panel, "#input"); await rp.typeText(panel, c.goal); await rp.pressEnter(panel);
    await until(async () => live ? (await rp.evaluate(panel, `!!document.querySelector('#messages .msg.assistant')`)) || undefined : (counts.get(c.id) ?? 0) >= 2 || undefined, 90_000, `${c.id} 主模型出结果`);
    let stable = 0;
    await until(async () => {
      const idle = await rp.evaluate(panel, `!document.querySelector('#status-pill').classList.contains('running') && !document.querySelector('.msg.assistant.streaming')`);
      stable = idle && Date.now() - started > 3000 ? stable + 1 : 0;

      return stable >= 5 || undefined;
    }, 120_000, `${c.id} 核对收尾`, 300);
    const answer = String(await rp.evaluate(panel, `[...document.querySelectorAll('#messages .msg.assistant')].filter(x=>!x.closest('.run-steps')).at(-1)?.innerText ?? ''`));
    const nudges = requests.filter(r => r.id === c.id && r.nudged);
    const links = JSON.stringify(await rp.evaluate(panel, `[...([...document.querySelectorAll('#messages .msg.assistant')].filter(x=>!x.closest('.run-steps')).at(-1)?.querySelectorAll('a[href]') ?? [])].map(x=>x.href)`));
    const corrected = c.id === "items" ? [["产品甲", 10], ["产品乙", 20], ["产品丙", 30]].every(([name, price]) => new RegExp(`${name}\\D{0,12}${price}(?:\\D|$)`).test(answer)) && ["https://example.com/a", "https://example.com/b", "https://example.com/c"].every(url => links.includes(url)) : live ? c.id === "date" ? answer.includes("2026-09-29") && /没有|未提供|不存在|无法|不能/.test(answer) : /33/.test(answer) : answer.includes(c.good);
    const files = JSON.stringify(await rp.evaluate(panel, `[...document.querySelectorAll('.artifact-card')].filter(x=>x.dataset.deleted!=='true').map(x=>x.dataset.filename)`));
    const countsMatch = [["省", 22], ["直辖市", 4], ["自治区", 5], ["特别行政区", 2]].every(([name, value]) => new RegExp(`${name}\\D{0,12}${value}(?:\\D|$)`).test(answer));
    const totalMatch = /(?:合计|总计)\D{0,12}33(?:\D|$)|22\s*\+\s*4\s*\+\s*5\s*\+\s*2\s*=\s*33/.test(answer);
    const pass = c.id === "correct" ? countsMatch && totalMatch && nudges.length === 0 : corrected && (live || nudges.length > 0) && (c.id !== "date" || !files.includes("date.csv"));
    checks.push({ id: c.id, pass, answer, ms: Date.now() - started, requests: requests.filter(r => r.id === c.id) });
    console.log(`${pass ? "PASS" : "FAIL"} ${c.id} ${Date.now() - started}ms`);
    await rp.screenshot(panel, join(out, `${c.id}.png`));

    if (c.id === "sum" && pass) {
      await rp.click(panel, `.artifact-card[data-filename="sum.csv"] .artifact-download`);
      const name = await until(async () => (await readdir(rp.dirs.downloads)).find(n => n === "sum.csv"), 10_000, "下载修正的 CSV");
      const content = (await readFile(join(rp.dirs.downloads, name), "utf8")).replace(/^\uFEFF/, "");
      checks.push({ id: "download-corrected-file", pass: live ? ["省,22", "直辖市,4", "自治区,5", "特别行政区,2"].every(row => content.includes(row)) && /(?:合计|总计),\s*33/.test(content) && !/(?:合计|总计),\s*34/.test(content) : content === rightCsv, answer: content, ms: 0, requests: [] });
      await writeFile(join(out, "sum.csv"), content);
    }
  }

  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "diagnostics"));

  await writeFile(join(out, "traces.jsonl"), diag.traces);
} catch (e) { error = String(e); console.error(error); }
finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ live, mainModel, checks, error, requests }, null, 2));
  await rp.close(); main.closeAllConnections(); main.close(); site.closeAllConnections(); site.close();
}

console.log(out);

if (error || checks.length !== 5 || checks.some(c => !c.pass)) process.exitCode = 1;
