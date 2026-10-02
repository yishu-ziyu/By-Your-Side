/**
 * Everyday entry: settings -> real offscreen agent -> sidebar task -> consent.
 * Only the OpenAI-compatible model is scripted; no service-worker hook or grant
 * injection. Independent oracle: the fixture's actual POST count.
 * Failure cases fixed before implementation: F1 denied/pending click posts;
 * F2 an allowed click does not post exactly once; F3 a later click reuses approval;
 * F4 sidebar Stop leaves a usable pending grant; F5 test bypasses the real agent.
 * This proves the extension path, not a provider model or human usability.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";
import { toolAction } from "../../../shared/user-facing.js";

requireHeadless();
const artifacts = join(REPO, "out/security-confirmation/real-path");
await mkdir(artifacts, { recursive: true });
let commits = 0;
const site = createServer((req, res) => {
  if (req.url === "/commit" && req.method === "POST") {
    commits++;
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
    '<!doctype html><html><head><title>Consent fixture</title></head><body><h1>Consent fixture</h1><button id="commit" type="button" onclick="fetch(\'/commit\',{method:\'POST\'})">Continue</button></body></html>',
  );
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const marks = ["安全验收拒绝", "安全验收允许", "安全验收第二次", "安全验收停止"];
const rules: Rule[] = marks.map(match => ({ match, steps: [
  { tool: { name: "get_active_tab", args: {} } },
  { tool: { name: "snapshot", args: {} } },
  { tool: { name: "click", args: { target: "#commit" } } },
  { text: `【${match}结束】` },
] }));
const model = await startScriptedModel(rules);
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let panel: string | undefined;
let work: string | undefined;
let error: string | null = null;
const evidence: Array<{ case: string; commits: number; requestId?: string }> = [];
const consentCards: Array<{ id: string; text: string; details: string; commits: number; decision?: string }> = [];
const seenConsents = new Set<string>();
const activeCard = '.consent-card:not(.consent-complete)';
const recordDecision = (id: string, decision: string) => { const card = consentCards.find(entry => entry.id === id); assert.ok(card); card.decision = decision; };
const cardSelector = (id: string) => `${activeCard}[data-request-id=${JSON.stringify(id)}]`;
try {
  rp = await launchRealPath();
  const browser = rp;
  const blank = await until(async () => (await browser.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  work = await browser.attach(blank.targetId);
  await browser.cdp.send("Page.navigate", { url: origin }, work);
  panel = await browser.attach(await browser.openSidePanel());
  const sidebar = panel;
  const fixtureTabId = await browser.evaluate(sidebar, `new Promise(resolve=>chrome.tabs.query({},tabs=>resolve(tabs.find(tab=>tab.url===${JSON.stringify(origin + "/")})?.id)))`);
  assert.equal(typeof fixtureTabId, "number", "the native fixture tab identity must be known");
  await browser.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sidebar);
  await until(async () => await browser.evaluate(sidebar, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "real sidebar ready");
  await browser.click(sidebar, "#header-more");
  await browser.click(sidebar, "#model-settings-open");
  const settingsTarget = await until(async () => (await browser.targets()).find(t => t.type === "page" && t.url.endsWith("/settings.html")), 10_000, "settings tab");
  const settings = await browser.attach(settingsTarget.targetId);
  await until(async () => await browser.evaluate(settings, '!!document.querySelector(\'.provider-option[data-provider="custom"]\')') || undefined, 15_000, "custom provider");
  await browser.evaluate(settings, 'document.querySelector("#provider-more").open=true;document.querySelector(\'.provider-option[data-provider="custom"]\').scrollIntoView({block:"center"});true');
  await browser.click(settings, '.provider-option[data-provider="custom"]');
  for (const [selector, value] of [["#base-url", model.baseUrl], ["#api-key", "local-demo-no-secret"], ["#model-id", "demo-model"]]) {
    await browser.evaluate(settings, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:"center"});e.focus();e.select?.();return true})()`);
    await browser.typeText(settings, value!);
  }
  await browser.evaluate(settings, 'document.querySelector("#model-save").scrollIntoView({block:"center"});true');
  await browser.click(settings, "#model-save");
  await until(async () => String(await browser.evaluate(settings, 'document.querySelector("#model-status")?.textContent')).startsWith("已保存") || undefined, 10_000, "saved scripted endpoint");
  await browser.cdp.send("Target.closeTarget", { targetId: settingsTarget.targetId });
  await sleep(500);

  const send = async (mark: string) => {
    await until(async () => await browser.evaluate(sidebar, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "previous task settled");
    await browser.click(sidebar, "#input");
    await browser.typeText(sidebar, `${mark}：点击当前练习页的 Continue。`);
    await browser.pressEnter(sidebar);
  };
  const cardForClick = async (expected: number) => {
    // Main-model snapshot plus the previous task's bounded goal-review reads
    // can coexist. Only exact fixture reads below may be approved, never JS.
    for (let i = 0; i < 8; i++) {
      const card = await until(async () => await browser.evaluate(sidebar, `(()=>{const c=document.querySelector(${JSON.stringify(activeCard)});return c?.querySelector(".consent-allow:not(:disabled)")?{id:c.dataset.requestId,text:c.textContent,details:c.querySelector("pre")?.textContent}:null})()`), 45_000, "real consent card") as { id: string; text: string; details: string };
      const record = { ...card, commits, decision: "pending" };
      consentCards.push(record);
      assert.ok(card.id && !seenConsents.has(card.id), "a consumed request must not become interactive again");
      seenConsents.add(card.id);
      assert.equal(commits, expected, "pending actions must not submit");
      const params = JSON.parse(card.details.split("\n\n")[1] ?? "null") as Record<string, unknown> | null;
      assert.ok(params && typeof params === "object" && !Array.isArray(params), "the complete action parameters must be visible");
      const action = card.details.split("\n")[0];
      const exact = (allowed: string[]) => Object.keys(params).every(key => allowed.includes(key));
      const emptyFormPolicy = (params.formRequirements === undefined || (Array.isArray(params.formRequirements) && params.formRequirements.length === 0)) && (params.userValueProvided === undefined || params.userValueProvided === false);
      if (action === `动作：${toolAction("click")}` && params.target === "#commit" && exact(["target", "tabId", "formRequirements", "userValueProvided"]) && emptyFormPolicy && (params.tabId === undefined || params.tabId === fixtureTabId)) return card.id;
      const snapshot = action === `动作：${toolAction("snapshot")}` && exact(["tabId"]) && (params.tabId === undefined || params.tabId === fixtureTabId);
      const decisionSnapshot = action === `动作：${toolAction("snapshot")}` && exact(["tabId", "decision"]) && params.tabId === fixtureTabId && params.decision === true;
      const targetRead = action === `动作：${toolAction("read_element")}` && exact(["tabId", "target"]) && params.tabId === fixtureTabId && params.target === "#commit";
      assert.ok(snapshot || decisionSnapshot || targetRead, `Unexpected consent action: ${card.details}`);
      record.decision = decisionSnapshot ? "allow exact fixture decision snapshot" : snapshot ? "allow exact fixture snapshot" : "allow exact fixture target read";
      const selector = cardSelector(card.id);
      await browser.click(sidebar, `${selector} .consent-allow`);
      await until(async () => await browser.evaluate(sidebar, `!document.querySelector(${JSON.stringify(selector)})?.querySelector(".consent-allow:not(:disabled)")`) || undefined, 15_000, "observation approval consumed");
      assert.equal(commits, expected, "an approved fixture read must not submit");
    }
    throw new Error("Unexpected extra consent requests before the planned click");
  };
  const settle = async (mark: string) => {
    await until(async () => await browser.evaluate(sidebar, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(`【${mark}结束】`)}) && !document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 60_000, "actual agent completed task");
    await sleep(300);
  };

  await send(marks[0]!);
  const denied = await cardForClick(0);
  await browser.click(sidebar, `${cardSelector(denied)} .consent-reject`);
  recordDecision(denied, "reject exact click");
  await settle(marks[0]!);
  assert.equal(commits, 0);
  evidence.push({ case: "real agent request denied without POST", commits, requestId: denied });
  await browser.screenshot(sidebar, join(artifacts, "denied.png"));

  await send(marks[1]!);
  const allowed = await cardForClick(0);
  assert.notEqual(allowed, denied);
  await browser.click(sidebar, `${cardSelector(allowed)} .consent-allow`);
  recordDecision(allowed, "allow exact click once");
  await until(async () => commits === 1 || undefined, 10_000, "exactly one approved POST");
  await settle(marks[1]!);
  assert.equal(commits, 1);
  evidence.push({ case: "real agent request allowed exactly once", commits, requestId: allowed });
  await browser.screenshot(sidebar, join(artifacts, "allowed.png"));

  await send(marks[2]!);
  const second = await cardForClick(1);
  assert.notEqual(second, allowed);
  await browser.click(sidebar, `${cardSelector(second)} .consent-reject`);
  recordDecision(second, "reject later exact click");
  await settle(marks[2]!);
  assert.equal(commits, 1);
  evidence.push({ case: "later request needs new permission", commits, requestId: second });

  await send(marks[3]!);
  const stopped = await cardForClick(1);
  recordDecision(stopped, "Stop pending exact click");
  await browser.click(sidebar, "#send-btn");
  await until(async () => await browser.evaluate(sidebar, `!document.querySelector(${JSON.stringify(cardSelector(stopped))})?.querySelector(".consent-allow:not(:disabled)")`) || undefined, 15_000, "Stop revoked pending approval");
  await sleep(500);
  assert.equal(commits, 1);
  evidence.push({ case: "sidebar Stop revokes pending grant", commits, requestId: stopped });
  await browser.screenshot(sidebar, join(artifacts, "stopped.png"));
  for (const mark of marks) assert.ok(model.requests.some(r => r.rule === mark && r.tools), "the real agent must call the configured endpoint");
  assert.ok((await browser.targets()).some(t => t.url === `chrome-extension://${browser.extensionId}/inproc.html`), "the real offscreen agent must be present");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (rp && panel) await rp.screenshot(panel, join(artifacts, "failure-sidebar.png")).catch(() => {});
  if (rp && work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => {});
} finally {
  const panelText = rp && panel ? await rp.evaluate(panel, "document.body.innerText").catch(() => "unavailable") : "unavailable";
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "real extension/offscreen agent/sidebar; scripted local model", evidence, consentCards, commits, error, panelText, modelRequests: model.requests, chromeStderr: rp?.chromeStderr() }, null, 2));
  await rp?.close();
  await rp?.remove();
  await model.close();
  await new Promise<void>(resolve => site.close(() => resolve()));
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", cases: evidence.length, commits, error }));
if (error) process.exitCode = 1;
