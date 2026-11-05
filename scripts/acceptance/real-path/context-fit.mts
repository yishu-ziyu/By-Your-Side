import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel, type Step } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-context-fit`);

await mkdir(out, { recursive: true });

const PAGES = 10;
const PAGE_CHARS = 90_000;
const TOKENS_PER_CHAR = 0.37;
const REAL_LIMIT_CHARS = 128_000 / TOKENS_PER_CHAR;
const GOAL = "CTXGOAL 把这些页面的发货数汇总给我";
const STEER = "CTXSTEER 只要第一页也要算进去";
const BIG = "CTXBIG 读一下这个超大的页面";
const AFTER = "CTXAFTER 刚才说到哪了";
const ANSWERS = { goal: "CTXDONE 汇总完了。", big: "CTXBIGDONE 大页面读完了。", after: "CTXAFTERDONE 接着说。" };
const hidden = (i: number) => `HIDDENFACT${i}X`;
const tail = (i: number) => `TAILFACT${i}X`;
const filler = (i: number, chars: number) => {
  const line = `PAGE${i}FILLER row shipped items for the fixture day. `;
  return line.repeat(Math.ceil(chars / line.length));
};
const html = (body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fixture</title><body><button id="mark-done" onclick="document.title='clicked'">标记</button><main>${body}</main></body></html>`;

const site = createServer((req, res) => {
  const url = req.url ?? "/";
  const big = url === "/big";
  const page = Number(url.slice(1));
  if (url === "/small") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html("<p>small</p>")); return; }
  const body = big ? `<p>BIGHEAD</p><p>${filler(99, 700_000)}</p><p>BIGTAIL</p>` : `<p>${filler(page, PAGE_CHARS / 2)}</p><p>${hidden(page)}</p><p>${filler(page, PAGE_CHARS / 2)}</p><p>${tail(page)}</p>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html(body));
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const recover = { name: "read_attachment", args: { name: "PENDING", query: tail(0) } };
const liveUsage = { prompt: 10 };
const goalSteps: Step[] = [{ tool: { name: "click", args: { target: "#mark-done" } }, usage: liveUsage }];
for (let i = 0; i < PAGES; i += 1) {
  goalSteps.push({ tool: { name: "navigate", args: { url: `${origin}/${i}` } }, usage: liveUsage });
  goalSteps.push({ tool: { name: "read_element", args: { target: "main" } }, usage: liveUsage, ...(i === 5 ? { delayMs: 4_000 } : {}) });
}
goalSteps.push({ tool: recover, usage: liveUsage }, { text: ANSWERS.goal, usage: liveUsage });

const requests: string[] = [];
const seenFacts = new Set<number>();
const overflowed: number[] = [];
let toolRequests = 0;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: GOAL, steps: goalSteps },
  { match: BIG, steps: [{ tool: { name: "navigate", args: { url: `${origin}/big` } }, usage: liveUsage }, { tool: { name: "read_element", args: { target: "main" } }, usage: liveUsage }, { text: ANSWERS.big, usage: liveUsage }] },
  { match: AFTER, steps: [{ text: ANSWERS.after }] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const raw = JSON.stringify(payload.messages);
  requests.push(raw);
  liveUsage.prompt = Math.round(JSON.stringify(payload).length * TOKENS_PER_CHAR);
  for (let i = 0; i < PAGES; i += 1) if (raw.includes(`\"tab\"`) || raw.includes(`<page-content`)) { const last = (payload.messages ?? []).at(-1); if (last?.role === "tool" && JSON.stringify(last.content).includes(hidden(i))) seenFacts.add(i); }
  const stub = /read_attachment with name \\+"(earlier:[^"\\]+)\\+"/.exec(raw);
  if (stub) recover.args.name = stub[1]!;
}, raw => {
  if (!raw.includes('"tools"')) return false;
  toolRequests += 1;
  if (raw.length <= REAL_LIMIT_CHARS) return false;
  overflowed.push(toolRequests);
  return true;
});

const rp = await launchRealPath();
const fits: string[] = [];
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const messagesOf = (raw: string) => JSON.parse(raw) as Array<{ role: string; content?: unknown }>;
const sharedPrefixBroken = (before: string, after: string) => {
  const a = messagesOf(before), b = messagesOf(after);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return true;
  return false;
};

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/0` }, work);
  await sleep(1_000);
  let panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const say = async (text: string) => { await rp.cdp.send("Page.bringToFront", {}, work); await rp.click(panel, "#input"); await rp.typeText(panel, text); await rp.pressEnter(panel); };
  const shown = (text: string) => `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].some(m => m.textContent.includes(${JSON.stringify(text)})) && document.querySelector("#send-btn")?.disabled === false`;

  await say(GOAL);
  await until(async () => requests.some(raw => raw.includes(`${origin}/5`) && raw.includes("/5")) || undefined, 90_000, "读到第六页", 200);
  await say(STEER);
  await until(async () => await rp.evaluate(panel, shown(ANSWERS.goal)) || undefined, 180_000, "长任务答完", 250).catch(() => undefined);
  await sleep(1_500);
  await rp.screenshot(panel, join(out, "long-run.png")).catch(() => {});

  const goalRequests = requests.filter(raw => raw.includes("CTXGOAL") && !raw.includes("CTXBIG"));
  const panelLong = String(await rp.evaluate(panel, `document.querySelector("#messages")?.innerText ?? ""`));
  check("a 一次读十页的任务做完，侧栏没有错误", panelLong.includes(ANSWERS.goal) && !/没有给出回答|maximum context length/i.test(panelLong), { answered: panelLong.includes(ANSWERS.goal), requests: goalRequests.length });
  check("b 提前省略，没有一次请求超过真实上限", !overflowed.length && goalRequests.every(raw => raw.length <= REAL_LIMIT_CHARS), { overflowed, maxChars: Math.max(...goalRequests.map(raw => raw.length)) });
  check("a2 每一页读完模型都真的看到了内容", seenFacts.size === PAGES, { seen: [...seenFacts] });
  const steerAt = goalRequests.findIndex(raw => raw.includes(STEER));
  check("c 用户原话和插话在之后每次请求里都还在", goalRequests.every(raw => raw.includes(GOAL)) && steerAt >= 0 && goalRequests.slice(steerAt).every(raw => raw.includes(STEER)), { steerAt, total: goalRequests.length });
  const lastRead = goalRequests.at(-1) ?? "";
  check("d 早先的页面已被省略，并留了取回方式", (lastRead.match(/PAGE1FILLER/g) ?? []).length < 5 && lastRead.includes("read_attachment with name"), { page1Left: (lastRead.match(/PAGE1FILLER/g) ?? []).length, stubs: (lastRead.match(/Earlier result elided/g) ?? []).length });
  check("e 取回拿到了被省略的原文", lastRead.includes(tail(0)) && recover.args.name.startsWith("earlier:"), { name: recover.args.name, found: lastRead.includes(tail(0)) });
  check("f 已做的点击和结果还在", lastRead.includes("mark-done") && /"role":"tool"/.test(lastRead), { click: lastRead.includes("mark-done") });
  const firstStub = goalRequests.findIndex(raw => raw.includes("Earlier result elided"));
  check("g 没到上限前不省略", firstStub > 2 && !goalRequests[0]!.includes("elided"), { firstStub });
  const breaks = goalRequests.slice(1).filter((raw, i) => sharedPrefixBroken(goalRequests[i]!, raw)).length;
  const breakAt = goalRequests.slice(1).flatMap((raw, i) => { const a = messagesOf(goalRequests[i]!), b = messagesOf(raw); const at = a.findIndex((m, k) => k < b.length && JSON.stringify(m) !== JSON.stringify(b[k])); return at < 0 ? [] : [{ request: i + 1, at, role: a[at]!.role, was: JSON.stringify(a[at]).slice(0, 120), now: JSON.stringify(b[at]).slice(0, 120) }]; });
  check("h 省略是成批的，请求前缀基本不变，缓存不会反复失效", breaks <= 4, { breaks, requests: goalRequests.length, breakAt });

  await say(BIG);
  await until(async () => await rp.evaluate(panel, shown(ANSWERS.big)) || undefined, 90_000, "大页面答完", 250).catch(() => undefined);
  await sleep(1_500);
  const bigRequests = requests.filter(raw => raw.includes("CTXBIG"));
  const lastBig = bigRequests.at(-1) ?? "";
  const clippedRead = messagesOf(lastBig).find(m => m.role === "tool" && JSON.stringify(m.content).includes("Showing the first"));
  const clippedText = JSON.stringify(clippedRead?.content ?? "");
  check("i 单个结果超过窗口也能答完：只给开头，并说明怎么读剩下的", clippedText.includes("BIGHEAD") && !clippedText.includes("BIGTAIL") && clippedText.includes("read_attachment") && lastBig.length <= REAL_LIMIT_CHARS, { chars: lastBig.length, shown: clippedText.length, overflowed });

  await rp.cdp.send("Page.reload", {}, panel);
  await sleep(2_000);
  panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, ready), 60_000, "重开侧栏就绪");
  const replayed = String(await rp.evaluate(panel, `document.querySelector("#messages")?.innerText ?? ""`));
  check("j 重开侧栏后回答都在", replayed.includes(ANSWERS.goal) && replayed.includes(ANSWERS.big), { goal: replayed.includes(ANSWERS.goal), big: replayed.includes(ANSWERS.big) });
  await rp.cdp.send("Page.navigate", { url: `${origin}/small` }, work);
  await sleep(1_000);
  await say(AFTER);
  await until(async () => await rp.evaluate(panel, shown(ANSWERS.after)) || undefined, 90_000, "重开后接着答", 250).catch(() => undefined);
  const lastAfter = requests.at(-1) ?? "";
  check("k 重开后接着问能答，长度仍在上限内", String(await rp.evaluate(panel, `document.querySelector("#messages")?.innerText ?? ""`)).includes(ANSWERS.after) && lastAfter.length <= REAL_LIMIT_CHARS, { chars: lastAfter.length, overflowed });
  await rp.screenshot(panel, join(out, "after-reopen.png")).catch(() => {});
  fits.push(...await rp.evaluate(panel, `new Promise((done, fail) => { const open = indexedDB.open("sideagent-diagnostics"); open.onerror = fail; open.onsuccess = () => { const get = open.result.transaction("trace-lines").objectStore("trace-lines").getAll(); get.onsuccess = () => done(get.result.map(row => row.line).filter(line => line.includes("context_fit"))); }; })`) as string[]);
  check("l 记录里能看到每次省略", fits.length > 0, { fits: fits.length });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, overflowed, fits, sizes: requests.map(raw => raw.length), shape: messagesOf(requests.filter(raw => raw.includes("CTXGOAL") && !raw.includes("CTXBIG")).at(-1) ?? "[]").map(m => { const t = JSON.stringify(m); return { role: m.role, chars: t.length, head: t.slice(0, 260) }; }) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
