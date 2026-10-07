/**
 * text= 目标在点击那一刻再核对：定位之后、按下之前按钮文字变了，就不点、报 TARGET_GONE、记为没执行
 * （docs/evals/20261008-check-assert-referee.md R3）。只装扩展、隔离构建、本机脚本模型；只有模型回复是脚本。
 *   npx tsx scripts/acceptance/real-path/target-gone.mts --headless
 * 两轮同一条路：练习站的「已读」按钮在 pointerover 时改名成「已读中…」（真实点击流程先派发 CDP mouseMoved
 * 再做按下前核对，所以改名正好落在定位与按下之间）；对照轮不改名。
 * 判据：改名轮服务器 /ack 计数为 0、回执以 TARGET_GONE 开头、侧栏那一步标失败；
 * 紧接着的 CSS 点击照常送达（结果未知锁没上，说明这一步记成了「没执行」）。对照轮 text= 点击送达一次。
 * 失败方式：改名后仍点下去（acks=1）；回执是泛泛的「未找到元素」；记成结果未知、后一步被锁拦下。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-target-gone`);

await mkdir(artifacts, { recursive: true });

const MARK = "点已读";

/** 产品发给模型的 OpenAI 兼容请求里本脚本要读的部分。 */
type Payload = { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };

type Chip = { text: string; error: boolean; kind: string | null };

type CaseResult = {
  name: string;
  status: "PASS" | "FAIL";
  error: string | null;
  /** 第 n 条工具回执送回模型那一刻服务器收到的 /ack 次数（独立于产品的计数）。 */
  acksAtReceipt: Record<number, number>;
  acksFinal: number;
  receipts: string[];
  chips: Chip[];
  screenshot: string;
};

async function runCase(name: string, renameOnHover: boolean): Promise<CaseResult> {
  let acks = 0;
  const rename = renameOnHover ? ` onpointerover="this.textContent='已读中…'"` : "";

  const site = createServer((req, res) => {
    if (req.url === "/ack") { acks++; res.writeHead(204).end(); return; }

    if (req.url !== "/") { res.writeHead(404).end(); return; }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>已读页</title><p>通知</p><button id="ack" onclick="fetch('/ack')"${rename}>已读</button>`);
  });

  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

  const payloads: Payload[] = [];
  const acksAtReceipt: Record<number, number> = {};

  const model = await startScriptedModel([{ match: MARK, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "click", args: { target: "text=已读" } } },
    // 紧接着用 CSS 再点一次：上一步若被记成「结果未知」，这一步会被锁拦下。
    { tool: { name: "click", args: { target: "#ack" } } },
    { text: `【${MARK}结束】` },
  ] }], undefined, payload => {
    // SAFETY: 脚本模型把产品的 OpenAI 兼容请求体原样交给这里；Payload 只取其中可选的 tools 与 messages。
    const p = payload as Payload;
    payloads.push(p);
    const toolResults = (p.messages ?? []).filter(m => m.role === "tool").length;

    if (p.tools?.length && toolResults > 0 && !(toolResults in acksAtReceipt)) acksAtReceipt[toolResults] = acks;
  });

  const rp = await launchRealPath();
  const screenshot = join(artifacts, `${name}-sidebar.png`);
  let error: string | null = null;
  let receipts: string[] = [];
  let chips: Chip[] = [];

  try {
    const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
    const work = await rp.attach(blank.targetId);
    await rp.cdp.send("Page.navigate", { url: origin }, work);
    const panel = await rp.attach(await rp.openSidePanel());
    await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
    const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
    await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
    await rp.click(panel, "#input");
    await rp.typeText(panel, `${MARK}：把这页的「已读」按钮点一下。`);
    await rp.pressEnter(panel);

    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(`【${MARK}结束】`)}) && !document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 90_000, "task finished");
    await sleep(500);

    const last = payloads.findLast(p => p.tools?.length && p.messages?.some(m => m.role === "user" && JSON.stringify(m.content).includes(MARK)))!;
    receipts = (last.messages ?? []).filter(m => m.role === "tool").map(m => Array.isArray(m.content) ? m.content.map(part => part.text ?? "").join("") : m.content ?? "").map(r => r.slice(0, 300));
    chips = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .chip:not(.prep)")].map(c => ({ text: c.textContent.trim().slice(0, 40), error: c.classList.contains("error"), kind: c.dataset.kind ?? null }))`) as Chip[];
    await rp.screenshot(panel, screenshot);

    const buttonText = String(await rp.evaluate(work, 'document.querySelector("#ack")?.textContent ?? ""'));

    if (renameOnHover) {
      // R3：改名发生在定位与按下之间；没点、回执是 TARGET_GONE、侧栏那一步标失败。
      assert.equal(buttonText, "已读中…", "the page renamed the button during the click flow");
      assert.equal(acksAtReceipt[3], 0, "text= click did not reach the site");
      assert.match(receipts[2] ?? "", /^TARGET_GONE: .*「已读」/, "receipt names the original text with the TARGET_GONE code");
      assert.ok(chips.some(c => c.error), "sidebar marks the click step failed");
      // 记成「没执行」而不是「结果未知」：后一步 CSS 点击没被锁拦下，真的送达。
      assert.equal(acksAtReceipt[4], 1, "following CSS click went through (no unknown-result lock)");
      assert.doesNotMatch(receipts[3] ?? "", /结果未知|未再次|没有重复执行/, "following CSS click was not blocked by the unknown-result lock");
    } else {
      assert.equal(buttonText, "已读", "control page keeps the text");
      assert.equal(acksAtReceipt[3], 1, "text= click reached the site once");
      assert.doesNotMatch(receipts[2] ?? "", /TARGET_GONE/, "no TARGET_GONE on the control page");
      assert.ok(!chips.some(c => c.error), "no failed step on the control page");
      assert.equal(acksAtReceipt[4], 2, "following CSS click reached the site");
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  } finally {
    await rp.close();
    await rp.remove();
    await model.close();
    site.closeAllConnections();
    site.close();
  }

  return { name, status: error ? "FAIL" : "PASS", error, acksAtReceipt, acksFinal: acks, receipts, chips, screenshot };
}

const results = [await runCase("rename-on-hover", true), await runCase("control", false)];
const status = results.every(r => r.status === "PASS") ? "PASS" : "FAIL";

await writeFile(join(artifacts, "summary.json"), JSON.stringify({ status, results }, null, 2));

console.log(JSON.stringify({ status, artifacts, cases: results.map(r => ({ name: r.name, status: r.status, error: r.error?.split("\n")[0] ?? null })) }));

if (status === "FAIL") process.exitCode = 1;
