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

type Payload = { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };

type Chip = { text: string; error: boolean; kind: string | null };

type CaseResult = {
  name: string;
  status: "PASS" | "FAIL";
  error: string | null;
  acksAtReceipt: Record<number, number>;
  acksFinal: number;
  receipts: string[];
  chips: Chip[];
  screenshot: string;
};

async function runCase(name: string, renameOnHover: boolean, rerender = false, swapOnHover = false): Promise<CaseResult> {
  let acks = 0;
  let wrong = 0;
  const swap = ` onpointerover="const n=document.createElement('button');n.id='ack';n.textContent='已读';n.onclick=()=>fetch('/wrong');this.replaceWith(n)"`;
  const rename = swapOnHover ? swap : renameOnHover ? ` onpointerover="this.textContent='已读中…'"` : "";

  const site = createServer((req, res) => {
    if (req.url === "/ack") { acks++; res.writeHead(204).end(); return; }

    if (req.url === "/wrong") { wrong++; res.writeHead(204).end(); return; }

    if (req.url !== "/") { res.writeHead(404).end(); return; }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>已读页</title><p>通知</p><button id="ack" onclick="fetch('/ack')"${rename}>已读</button>`);
  });

  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

  const payloads: Payload[] = [];
  const acksAtReceipt: Record<number, number> = {};
  const wrongAtReceipt: Record<number, number> = {};
  let workSession: string | null = null;
  let replaced = false;

  const model = await startScriptedModel([{ match: MARK, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: rerender ? "mark" : "click", args: { target: "text=已读" } } },
    ...(rerender ? [{ tool: { name: "js", args: { code: "document.querySelector('#ack').textContent" } } }] : []),
    { tool: { name: "click", args: rerender ? { target: "text=已读", point: [40, 70] } : { target: "#ack" } } },
    { text: `【${MARK}结束】` },
  ] }], undefined, async payload => {
    // SAFETY: 脚本模型把产品的 OpenAI 兼容请求体原样交给这里；Payload 只取其中可选的 tools 与 messages。
    const p = payload as Payload;
    payloads.push(p);
    const toolResults = (p.messages ?? []).filter(m => m.role === "tool").length;

    if (p.tools?.length && toolResults > 0 && !(toolResults in acksAtReceipt)) { acksAtReceipt[toolResults] = acks; wrongAtReceipt[toolResults] = wrong; }
    if (rerender && p.tools?.length && toolResults === 3 && !replaced && workSession) {
      replaced = await rp.evaluate(workSession, "(() => { const old = document.querySelector('#ack'); const next = old.cloneNode(true); old.replaceWith(next); return !old.isConnected && next.isConnected; })()") as boolean;
    }
  });

  const rp = await launchRealPath();
  const screenshot = join(artifacts, `${name}-sidebar.png`);
  let error: string | null = null;
  let receipts: string[] = [];
  let chips: Chip[] = [];

  try {
    const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
    const work = await rp.attach(blank.targetId);
    workSession = work;
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

    if (swapOnHover) {
      assert.equal(wrongAtReceipt[3], 0, "text= click did not reach the swapped-in button");
      assert.match(receipts[2] ?? "", /^TARGET_GONE: .*「已读」已换到别的元素上/, "receipt says the text moved to another element");
      assert.ok(chips.some(c => c.error), "sidebar marks the click step failed");
      assert.equal(wrongAtReceipt[4], 1, "following CSS click went through (no unknown-result lock)");
    } else if (renameOnHover) {
      assert.equal(buttonText, "已读中…", "the page renamed the button during the click flow");
      assert.equal(acksAtReceipt[3], 0, "text= click did not reach the site");
      assert.match(receipts[2] ?? "", /^TARGET_GONE: .*「已读」/, "receipt names the original text with the TARGET_GONE code");
      assert.ok(chips.some(c => c.error), "sidebar marks the click step failed");
      assert.equal(acksAtReceipt[4], 1, "following CSS click went through (no unknown-result lock)");
      assert.doesNotMatch(receipts[3] ?? "", /结果未知|未再次|没有重复执行/, "following CSS click was not blocked by the unknown-result lock");
    } else {
      if (rerender) assert.ok(replaced, "the fixture replaced the marked button before the next action");
      assert.equal(buttonText, "已读", "control page keeps the text");
      assert.equal(acksAtReceipt[3], rerender ? 0 : 1, rerender ? "mark does not click the button" : "text= click reached the site once");
      assert.doesNotMatch(receipts[2] ?? "", /TARGET_GONE/, "no TARGET_GONE on the control page");
      assert.ok(!chips.some(c => c.error), "no failed step on the control page");
      assert.equal(acksAtReceipt[rerender ? 5 : 4], rerender ? 1 : 2, rerender ? "new action with explicit point accepts the rerendered same-name button" : "following CSS click reached the site");
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

const results = [await runCase("rename-on-hover", true), await runCase("swap-on-hover", false, false, true), await runCase("control", false), await runCase("mark-rerender-point", false, true)];
const status = results.every(r => r.status === "PASS") ? "PASS" : "FAIL";

await writeFile(join(artifacts, "summary.json"), JSON.stringify({ status, results }, null, 2));

console.log(JSON.stringify({ status, artifacts, cases: results.map(r => ({ name: r.name, status: r.status, error: r.error?.split("\n")[0] ?? null })) }));

if (status === "FAIL") process.exitCode = 1;
