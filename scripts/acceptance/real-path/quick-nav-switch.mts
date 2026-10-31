/**
 * 「切到某标签」确定性快捷通道：唯一匹配已开标签时宿主直接执行，不经模型。
 * 只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/quick-nav-switch.mts --headless
 * a) 「切换到耳机比价」：0 次模型请求，标签切到前台，回答只有一句「已切到…」，过程行「已核对页面」，无核对框。
 * b) 客气变体「请帮我打开耳机比价吧」同样命中。
 * c) 匹配不到的「切换到xyz不存在的」回退完整路径（模型被调用、脚本回答出现）。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-quick-nav-switch`);

await mkdir(out, { recursive: true });

const FALLBACK = "切换到xyz不存在的";
const FALLBACK_ANSWER = "没有找到叫 xyz不存在的 标签页或网站，完整路径接管。";
const DONE_JSON = JSON.stringify({ items: [{ text: "切换", done: true }], status: "done", remaining: "" });

const page = (title: string, body: string) => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><body><main><h1>${body}</h1></main></body></html>`;
const siteA = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("聚焦资讯", "科技新闻首页")));
const siteB = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("耳机比价", "三家报价")));

await Promise.all([new Promise<void>(done => siteA.listen(0, "127.0.0.1", done)), new Promise<void>(done => siteB.listen(0, "127.0.0.1", done))]);
const URL_A = `http://127.0.0.1:${siteAddress(siteA).port}/`;
const URL_B = `http://127.0.0.1:${siteAddress(siteB).port}/`;

const model = await startScriptedModel([
  // 目标核对的输入带 lastReply 字段，排在前面先匹配。
  { match: `"lastReply"`, steps: [{ text: DONE_JSON }] },
  { match: FALLBACK, steps: [{ text: FALLBACK_ANSWER }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");

  // 前台 A、后台 B 两个标签页。
  await rp.evaluate(panel, `chrome.tabs.create({ url: ${JSON.stringify(URL_A)}, active: true }).then((t) => t.id)`);
  await rp.evaluate(panel, `chrome.tabs.create({ url: ${JSON.stringify(URL_B)}, active: false }).then((t) => t.id)`);
  await sleep(500);

  const say = async (text: string, answerIncludes: string) => {
    const answersBefore = await rp.evaluate(panel, `document.querySelectorAll(".msg.assistant").length`) as number;
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    const sentAt = Date.now();
    await rp.pressEnter(panel);
    // 等一条「新」回答出现且含期望文字：上一轮的回答也含同样的字，不能拿来当这一轮的结果。
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].length > ${answersBefore} && [...document.querySelectorAll(".msg.assistant")].at(-1)?.textContent.includes(${JSON.stringify(answerIncludes)})`) || undefined, 30_000, `回答：${answerIncludes}`);
    await until(async () => await rp.evaluate(panel, ready), 30_000, "这一轮结束");
    return Date.now() - sentAt;
  };

  // a) 标题精确命中：快捷通道。
  const fastMs = await say("切换到耳机比价", "已切到「耳机比价」");
  const activeAfterFast = await rp.evaluate(panel, `chrome.tabs.query({ active: true }).then((tabs) => tabs[0]?.url ?? "")`) as string;
  const fastState = {
    ms: fastMs,
    modelRequests: model.requests.length,
    activeUrl: activeAfterFast,
    expectUrl: URL_B,
    runRows: await rp.evaluate(panel, `document.querySelectorAll("details.run-steps").length`),
    factCheckBox: await rp.evaluate(panel, `!!([...document.querySelectorAll(".msg.assistant")].pop()?.querySelector(".fact-check"))`),
    answer: await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].pop()?.textContent?.trim() ?? ""`),
  };
  await rp.screenshot(panel, join(out, "a-fast-switch.png"));
  check("a 快捷通道：一次模型请求都没有", fastState.modelRequests === 0, fastState);
  check("a 标签切到前台", activeAfterFast === URL_B, fastState);
  check("a 回答只有一句、没有核对框", fastState.factCheckBox === false && (fastState.answer.match(/。/g)?.length ?? 0) <= 1, fastState);

  // b) 客气变体：同样命中快捷通道。
  await rp.evaluate(panel, `chrome.tabs.query({ url: ${JSON.stringify(URL_B + "*")} }).then((tabs) => tabs[0] && chrome.tabs.update(tabs[0].id, { active: false }))`);
  await rp.evaluate(panel, `chrome.tabs.query({ url: ${JSON.stringify(URL_A + "*")} }).then((tabs) => tabs[0] && chrome.tabs.update(tabs[0].id, { active: true }))`);
  await sleep(300);
  await say("请帮我打开耳机比价吧", "已切到「耳机比价」");
  const requestsAfterB = model.requests.length;
  const activeAfterB = await rp.evaluate(panel, `chrome.tabs.query({ active: true }).then((tabs) => tabs[0]?.url ?? "")`) as string;
  check("b 客气变体同样走快捷通道（仍 0 模型请求且切过去了）", requestsAfterB === 0 && activeAfterB === URL_B, { requestsAfterB, activeAfterB, expectUrl: URL_B });

  const originalTarget = await rp.evaluate(panel, `chrome.tabs.create({url:${JSON.stringify(URL_B + 'original')},active:false}).then(t=>t.id)`) as number;
  const target = await until(async () => (await rp.targets()).find(t => t.url === URL_B + 'original') || undefined, 10000, 'original target');
  const targetSession = await rp.attach(target.targetId);
  await rp.evaluate(targetSession, `document.title='X'`);
  await sleep(300);
  await say('将页面切换到x', '已切到「X」');
  const originalActive = await rp.evaluate(panel, `chrome.tabs.query({active:true}).then(tabs=>tabs.some(t=>t.id===${originalTarget}))`);
  check('原始报告的切页请求直接到前台，不调用模型', originalActive === true && model.requests.length === 0, { originalActive, modelRequests: model.requests.length });

  // c) 匹配不到：回退完整路径，模型被调用。
  const requestsBeforeC = model.requests.length;
  await say(FALLBACK, "完整路径接管");
  const requestsAfterC = model.requests.length;
  check("c 匹配不到回退完整路径（模型被调用）", requestsAfterC > requestsBeforeC, { requestsBeforeC, requestsAfterC });
  await rp.screenshot(panel, join(out, "c-fallback.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); siteA.close(); siteB.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
