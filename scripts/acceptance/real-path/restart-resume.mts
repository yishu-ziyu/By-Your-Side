/**
 * 改页面的工具已经做完、模型下一句还没回来时强杀浏览器：重开侧栏后任务不自己接着做，用户点「继续原任务」后做完，提交只发生一次。
 *   npx tsx scripts/acceptance/real-path/restart-resume.mts --headless
 *   npx tsx scripts/acceptance/real-path/restart-resume.mts --headless --wipe
 * --wipe 在重开前清掉 pi-durable 的存储，任务不该自己做完（用来证明这条用例会失败）。
 * 提交次数记在浏览器外面的本机页面上，扩展重载或浏览器被强杀都不清零。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import type { Step } from "./scripted-model.mts";

requireHeadless();

const wipe = process.argv.includes("--wipe");
const fromOtherPage = process.argv.find(arg => arg.startsWith('--from-other-page='))?.split('=')[1];
const ANSWER = "已经提交。";
let hits = 0;

const site = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/hit") {
    hits += 1;
    res.writeHead(200, { "content-type": "text/plain" }).end(String(hits));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>提交练习</title>
<body><button id="submit" type="button">提交</button><p id="n">0</p>
<script>document.querySelector("#submit").onclick=()=>fetch("/hit",{method:"POST"}).then(r=>r.text()).then(t=>{document.querySelector("#n").textContent=t})</script>`);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const answer = { text: ANSWER, delayMs: 30_000 };
let sawToolResult = false;
// 用户点「继续原任务」后的那次请求：对话里还带着强杀前那次点击的结果吗（真模型靠它知道已经点过）。
let continuationCarriesClick: boolean | null = null;
const submitRule = { match: "提交按钮", steps: [{ tool: { name: "click", args: { target: "#submit", label: "提交" } } }, answer] as Step[] };
const model = await startModel();

function startModel() {
  return import("./scripted-model.mts").then(({ startScriptedModel }) => startScriptedModel([
    { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
    submitRule,
  ], undefined, payload => {
    const messages = payload.messages ?? [];
    if (messages.some(message => message.role === "tool")) sawToolResult = true;
    if (continuationCarriesClick === null && JSON.stringify(messages).includes("[RESTART CONTINUATION]")) {
      continuationCarriesClick = messages.some(message => message.role === "tool");
      // 像读过记录的模型那样：已经点过，只回答。
      submitRule.steps = [answer];
    }
  }));
}

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-restart-resume${wipe ? "-wipe" : ""}${fromOtherPage ? '-' + fromOtherPage : ''}`);
await mkdir(out, { recursive: true });

const rp = await launchRealPath();

async function wipeStore(): Promise<void> {
  const page = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html`, background: true })).targetId;
  try {
    const session = await rp.attach(page);
    await until(async () => (await rp.evaluate(session, "document.readyState==='complete'")) || undefined, 10_000, "wipe page");
    await rp.evaluate(session, `navigator.storage.getDirectory().then(root=>root.removeEntry("pi-durable",{recursive:true})).then(()=>"wiped",()=>"missing")`);
  } finally {
    await rp.cdp.send("Target.closeTarget", { targetId: page }).catch(() => {});
  }
}

const evidence: Record<string, unknown> = { wipe, hits: 0 };
let panel = "";
let again = "";
try {
  const port = siteAddress(site).port;
  panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏可发送");
  const work = await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` });
  await rp.cdp.send("Target.activateTarget", { targetId: work.targetId });
  await sleep(400);
  await rp.click(panel, "#input");
  await rp.typeText(panel, "请点一下页面上的提交按钮，点完用一句话告诉我。");
  await rp.pressEnter(panel);
  await until(async () => sawToolResult || undefined, 45_000, "工具结果已交给模型");
  await sleep(400);
  evidence.hitsBefore = hits;
  assert.equal(hits, 1, "打断前提交应当已经发生一次");
  assert.equal(await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes(${JSON.stringify(ANSWER)})`), false, '必须在模型回答前强杀，不能把已完成任务当作恢复');
  await rp.restart({ abrupt: true });
  answer.delayMs = 0;
  evidence.restartKind = "SIGKILL + same profile";
  if (wipe) await wipeStore();
  const againId = await rp.attach(await rp.openSidePanel());
  again = againId;
  const text = () => rp.evaluate(againId, "document.querySelector('#messages')?.innerText ?? ''") as Promise<string>;
  if (wipe) {
    await sleep(8_000);
    const body = await text();
    evidence.after = body.slice(0, 500);
    evidence.hits = hits;
    await writeFile(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
    assert.equal(hits, 1, "清掉存储后也不该再点一次");
    assert.equal(body.includes(ANSWER), false, "清掉存储后任务不该自己答完");
  } else {
    // 重启后不自己接着做：等用户看过页面、点「继续原任务」才做完。
    assert.equal((await text()).includes(ANSWER), false, "用户点继续之前任务不该自己答完");
    await until(async () => await rp.evaluate(againId, `(() => { const r = document.querySelector("#resume-entry-root"); return !!r && !r.hidden && !!r.querySelector(".resume-action"); })()`) || undefined, 15_000, "侧栏出现「继续原任务」");
    const reopened = fromOtherPage === 'missing' ? null : await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/`, background: !!fromOtherPage });
    const current = fromOtherPage ? await rp.cdp.send('Target.createTarget', { url: `chrome-extension://${rp.extensionId}/settings.html` }) : reopened!;
    await rp.cdp.send("Target.activateTarget", { targetId: current.targetId });
    await sleep(400);
    const resume = async () => {
      if (fromOtherPage && fromOtherPage !== 'button') {
        await rp.click(againId, '#input'); await rp.typeText(againId, '继续'); await rp.pressEnter(againId);
      } else await rp.click(againId, '#resume-entry-root .resume-action');
    };
    await resume();
    if (fromOtherPage === 'missing') {
      await until(async () => (await text()).includes('没找到') || (await text()).includes('当前页面不是原任务') || undefined, 20_000, '原页面缺失时说明原因');
      const missing = await text();
      evidence.missing = missing;
      assert.ok(missing.includes('没找到') && missing.includes('提交练习'), '说明缺失的是哪一个原页面');
      assert.equal(hits, 1, '找不到原页面时不在设置页执行');
      assert.equal(continuationCarriesClick, null, '原页面缺失时未调用模型继续');
      await rp.cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/`, background: true });
      await resume();
    }
    await until(async () => (await text()).includes(ANSWER) || (await text()).includes('当前页面不是原任务') || undefined, 60_000, "点继续后答完");
    assert.ok((await text()).includes(ANSWER), '说继续或点继续必须自动找到仍开着的原页面');
    await sleep(500);
    evidence.hits = hits;
    evidence.after = (await text()).slice(0, 500);
    await writeFile(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
    evidence.continuationCarriesClick = continuationCarriesClick;
    assert.equal(continuationCarriesClick, true, "继续时发给模型的对话里要有强杀前那次点击的结果");
    assert.equal(hits, 1, "重开后不能再点一次提交");
    assert.ok((await text()).includes(ANSWER), "侧栏应当显示做完的回答");
    await rp.screenshot(againId, join(out, 'panel.png'));
  }
  console.log(`restart-resume ${wipe ? "wipe " : ""}ok via ${evidence.restartKind}, hits=${hits}`);
} catch (error) {
  evidence.hits = hits;
  const live = again || panel;
  if (live) evidence.panel = await rp.evaluate(live, "document.body.innerText.slice(0, 1500)").catch(reason => String(reason));
  if (live) await rp.screenshot(live, join(out, 'panel.png')).catch(() => {});
  await writeFile(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  throw error;
} finally {
  await model.close();
  site.close();
  await rp.close();
}
