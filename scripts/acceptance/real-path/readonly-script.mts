/** #22 real offscreen Agent → real sidebar, no approval cards (removed 2026-10-04). Only the local model is scripted.
 * Failures fixed before production: unsafe getter/serialization posts or changes DOM;
 * CPU/Promise hangs; missing capability masquerades as PASS; failed read locks fill;
 * ordinary JS timeout loses its unknown-write lock. No fallback.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/issue-22/real-path", new Date().toISOString().replace(/[:.]/g, "-"));

await mkdir(artifacts, { recursive: true });

const TITLE = "Readonly fixture independent title";

const TEXT = "Independent text oracle 22";

let commits = 0;

const site = createServer((req, res) => {
  if (req.url === "/commit" && req.method === "POST") {
    commits++;
    res.writeHead(200).end("ok");

    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>${TITLE}</title></head><body><p id="text">${TEXT}</p><label for="evidence">Evidence</label><input id="evidence"></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const scripts = {
  title: "document.title",
  text: 'document.querySelector("#text").textContent',
  cpu: "(()=>{while(true){} })()",
  domGetter: '(()=>{const o={get value(){document.querySelector("#text").textContent="UNSAFE";return "unsafe"}};return o.value})()',
  postGetter: '(()=>{const o={get value(){fetch("/commit",{method:"POST"});return "unsafe"}};return o.value})()',
  object: '({get value(){document.querySelector("#text").textContent="UNSAFE";fetch("/commit",{method:"POST"});return "unsafe"},toJSON(){document.querySelector("#text").textContent="UNSAFE";fetch("/commit",{method:"POST"});return "unsafe"}})',
  promise: 'Promise.resolve("not synchronous")',
  unsafe: '(()=>{fetch("/commit",{method:"POST"});return new Promise(()=>{})})()',
};

const plans = [
  { mark: "只读验收同步与CPU", keys: ["title", "text", "cpu"] as const, value: "Read failure may continue 22", ordinary: false },
  { mark: "只读验收副作用与对象", keys: ["domGetter", "postGetter", "object", "promise"] as const, value: "Rejected reads may continue 22", ordinary: false },
  { mark: "只读验收普通JS未知", keys: ["unsafe"] as const, value: "MUST NOT FILL 22", ordinary: true },
];

const rules: Rule[] = plans.map(plan => ({ match: plan.mark, steps: [
  { tool: { name: "get_active_tab", args: {} } },
  { tool: { name: "snapshot", args: {} } },
  ...plan.keys.map(key => ({ tool: { name: plan.ordinary ? "js" : "read_script", args: { code: scripts[key] } } })),
  { tool: { name: "fill", args: { target: "#evidence", value: plan.value } } },
  { text: `【${plan.mark}结束】` },
] }));

// Request bodies contain the real Agent's tool calls and receipts, not test-generated results.
const payloads: Array<{ at: number; payload: unknown }> = [];

const model = await startScriptedModel(rules, undefined, payload => payloads.push({ at: Date.now(), payload }));

let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;

let panel: string | undefined;

let work: string | undefined;

let error: string | null = null;

const evidence: unknown[] = [];

const failures: string[] = [];

try {
  rp = await launchRealPath();
  const browser = rp;
  const blank = await until(async () => (await browser.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  work = await browser.attach(blank.targetId);
  await browser.cdp.send("Page.navigate", { url: origin }, work);
  panel = await browser.attach(await browser.openSidePanel());
  const sidebar = panel;
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

  const pageState = () => browser.evaluate(work!, '({title:document.title,text:document.querySelector("#text").textContent,evidence:document.querySelector("#evidence").value})');

  for (const plan of plans) {
    await until(async () => await browser.evaluate(sidebar, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "previous task settled");
    await browser.cdp.send("Page.navigate", { url: origin }, work);
    await until(async () => await browser.evaluate(work!, 'document.querySelector("#evidence")?.value===""') || undefined, 10_000, "fresh fixture");
    const start = Date.now();
    const beforePosts = commits;
    const userTask = `${plan.mark}：仅在当前本地练习页按这些代码依次调用${plan.ordinary ? "普通js" : "同步只读read_script"}：${JSON.stringify(plan.keys.map(key => scripts[key]))}。诊断读取失败也继续，随后用fill将 Evidence (#evidence) 完整填写为「${plan.value}」。不得提交。普通js结果未知时不得绕过保护。`;
    await browser.click(sidebar, "#input");
    await browser.typeText(sidebar, userTask);
    await browser.pressEnter(sidebar);
    await until(async () => {
      return await browser.evaluate(sidebar, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(`【${plan.mark}结束】`)}) && !document.querySelector("#status-pill")?.classList.contains("running")`) || undefined;
    }, plan.ordinary ? 100_000 : 90_000, `${plan.mark} real Agent completion`);
    await sleep(500);
    const state = await pageState();
    const relevant = payloads.filter(entry => entry.at >= start);

    const messages = relevant.flatMap(entry => {
      // SAFETY: startScriptedModel inspects the real Agent's OpenAI-compatible JSON request; only messages are projected here, and missing messages remain empty.
      const all = (entry.payload as { messages?: Array<{ role: string; content?: unknown; tool_call_id?: string }> }).messages ?? [];
      const current = all.findLastIndex(m => m.role === "user" && JSON.stringify(m.content).includes(plan.mark));

      return current < 0 ? [] : all.slice(current + 1);
    });

    const receipts = [...new Map(messages.flatMap(m => m.role === "tool" ? [[m.tool_call_id, m] as const] : [])).values()];
    evidence.push({ case: plan.mark, userTask, elapsedMs: Date.now() - start, state, commits, beforePosts, receipts });
    await browser.screenshot(work!, join(artifacts, `${plans.indexOf(plan) + 1}-page.png`));
    await browser.screenshot(sidebar, join(artifacts, `${plans.indexOf(plan) + 1}-sidebar.png`));

    try {
      assert.equal(state.title, TITLE);
      assert.equal(state.text, TEXT, "readonly evaluation and serialization must not modify DOM");
      assert.equal(commits - beforePosts, plan.ordinary ? 1 : 0, "independent server POST count");
      assert.equal(state.evidence, plan.ordinary ? "" : plan.value, "read failures do not lock fill; ordinary unknown does");
      const raw = JSON.stringify(receipts);
      assert.ok(!/unknown tool|tool.{0,40}not found|unrecognized tool|未知工具/i.test(raw), "missing read_script is RED, never PASS");
      // SAFETY: Only assistant messages are selected; their optional tool_calls use the scripted model's OpenAI-compatible id/function format.
      const calls = messages.filter(m => m.role === "assistant") as Array<{ tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>;

      const receiptFor = (key: keyof typeof scripts) => {
        const call = calls.flatMap(m => m.tool_calls ?? []).find(c => c.function.name === (plan.ordinary ? "js" : "read_script") && JSON.parse(c.function.arguments).code === scripts[key]);
        assert.ok(call, `actual ${key} tool call required`);
        const receipt = receipts.find(r => r.tool_call_id === call.id);
        assert.ok(receipt, `actual ${key} receipt required`);

        return { call, receipt };
      };

      if (!plan.ordinary) {
        // SAFETY: These are real Agent OpenAI-compatible request bodies; tools and function/name are optional and checked before reading.
        const offered = relevant.some(entry => (entry.payload as { tools?: Array<{ function?: { name?: string } }> }).tools?.some(t => t.function?.name === "read_script"));
        assert.ok(offered, "read_script must actually be offered by the real Agent");
        const failuresExpected = plan.keys.filter(key => key !== "title" && key !== "text");

        for (const key of failuresExpected) {
          const { call, receipt } = receiptFor(key);
          assert.ok(/error|fail|拒绝|失败|超时|side.effect|timed out|terminated|not.supported|不支持/i.test(JSON.stringify(receipt.content)), `${key} needs explicit read failure`);
          // SAFETY: The same inspected request bodies contain OpenAI-compatible messages; only the tool role and call id are read.
          const carries = (entry: { payload: unknown }) => !!(entry.payload as { messages?: Array<{ role: string; tool_call_id?: string }> }).messages?.some(m => m.role === "tool" && m.tool_call_id === call.id);
          const received = relevant.find(carries);
          // The request just before the receipt is the one whose reply issued this call.
          const asked = received ? relevant.findLast(entry => entry.at <= received.at && !carries(entry)) : undefined;
          assert.ok(received && asked && received.at - asked.at < 5000, `${key} must finish without waiting for 30-second RPC timeout`);
        }

        if (plan.keys.some(key => key === "title")) {
          for (const [key, expected] of [["title", TITLE], ["text", TEXT]] as const) {
            const result = JSON.stringify(receiptFor(key).receipt.content);
            assert.ok(result.includes(expected) && !/error|fail|拒绝|失败|超时/i.test(result), `independent ${key} primitive must be returned by read_script, not snapshot`);
          }
        }
      } else {
        assert.ok(/timeout|timed out|超时|unknown|不确定|未知/i.test(JSON.stringify(receiptFor("unsafe").receipt.content)), "ordinary JS must actually time out after its POST");
        assert.ok(/unknown|不确定|未知|unconfirmed/i.test(raw), "ordinary JS must retain explicit unknown-write protection");
        assert.ok(Date.now() - start >= 29_000, "ordinary unresolved Promise must exercise the original 30-second RPC timeout");
      }
    } catch (caught) { failures.push(`${plan.mark}: ${String(caught)}`); }
  }

  // #19: the debugger-infobar explanation shows exactly once across all three tasks.
  const sidebarText = String(await browser.evaluate(sidebar, "document.querySelector('#messages')?.textContent"));
  assert.equal(sidebarText.split("正在调试此浏览器").length - 1, 1, "debug infobar explanation appears once");

  assert.ok((await browser.targets()).some(t => t.url === `chrome-extension://${browser.extensionId}/inproc.html`), "real offscreen Agent required");

  for (const plan of plans) assert.ok(model.requests.some(r => r.rule === plan.mark && r.tools));
  assert.deepEqual(failures, [], "all three critical paths must pass");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (rp && panel) await rp.screenshot(panel, join(artifacts, "failure-sidebar.png")).catch(() => {});

  if (rp && work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => {});
} finally {
  const finalPage = rp && work ? await rp.evaluate(work, '({title:document.title,text:document.querySelector("#text")?.textContent,evidence:document.querySelector("#evidence")?.value})').catch(() => "unavailable") : "unavailable";
  const panelText = rp && panel ? await rp.evaluate(panel, "document.body.innerText").catch(() => "unavailable") : "unavailable";
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model", evidence, failures, finalPage, commits, error, panelText, modelRequests: model.requests, payloads, chromeStderr: rp?.chromeStderr() }, null, 2));
  await rp?.close();
  await rp?.remove();
  await model.close();
  site.closeAllConnections();
  await new Promise<void>(resolve => site.close(() => resolve()));
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, failures, commits, error }));

if (error) process.exitCode = 1;
