/**
 * 模型出错后，用户在错误卡上修掉原因，助手在原对话里接着做（docs/evals/20261006-error-states.md R1–R5）。
 * 只装扩展、隔离构建、本机脚本模型；前面挡一个本机服务，按场景回 401、429 或断开连接。
 *   npx tsx scripts/acceptance/real-path/error-recovery.mts --headless
 * 失败方式：错误卡只有一行字或只有「继续原任务」；换 key 要去设置页；修好后要用户重发；没有回执。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-error-recovery`);

await mkdir(artifacts, { recursive: true });

const CASES = {
  auth: { ask: "出错恢复验收甲", answer: "甲：换 key 后答完了。" },
  busy: { ask: "出错恢复验收乙", answer: "乙：限流过后答完了。" },
  net: { ask: "出错恢复验收丙", answer: "丙：网络恢复后答完了。" },
};

const model = await startScriptedModel(Object.values(CASES).map(c => ({ match: c.ask, steps: [{ text: c.answer }] })));

// 挡在模型前面：key 不对回 401；busy 时接下来几次任务请求（带工具表）回 429；netDown 时任务请求一律直接断开。
let failNext: { kind: "busy"; count: number } | null = null;

let netDown = false;

const gate: Array<{ at: number; result: string }> = [];

const front = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);

  if (req.headers.authorization !== "Bearer good-key") {
    gate.push({ at: Date.now(), result: "401" });
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API key", type: "invalid_request_error" } }));

    return;
  }

  const task = /"tools"\s*:\s*\[\s*\{/.test(body);

  if (netDown && task) {
    gate.push({ at: Date.now(), result: "net" });
    req.socket.destroy();

    return;
  }

  if (failNext && failNext.count > 0 && task) {
    failNext.count -= 1;
    gate.push({ at: Date.now(), result: failNext.kind });
    res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Rate limit reached, please retry later" } }));

    return;
  }

  gate.push({ at: Date.now(), result: "ok" });
  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

/** 写进 result.json 的证据。 */
interface Evidence { stage?: string; storedKey?: unknown; messages?: unknown; gate?: string[] }

const evidence: Evidence = {};

let panel = "";

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(front).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "bad-key" },
  })}).then(() => true)`);

  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const text = async () => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'));
  const visible = (selector: string) => rp.evaluate(panel, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.getClientRects().length > 0; })()`);
  const waitFor = (selector: string, label: string, ms = 60_000) => until(async () => await visible(selector) || undefined, ms, label);
  const userBubbles = (ask: string) => rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].filter(el => el.textContent.includes(${JSON.stringify(ask)})).length`);

  const send = async (ask: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, ask);
    await rp.pressEnter(panel);
  };

  const recovered = async (name: keyof typeof CASES, receipt: RegExp) => {
    await until(async () => (await text()).includes(CASES[name].answer) || undefined, 60_000, `${name} answer visible`);
    await until(async () => receipt.test(String(await rp.evaluate(panel, '[...document.querySelectorAll(".error-receipt")].at(-1)?.textContent ?? ""'))) || undefined, 10_000, `${name} receipt`);
    assert.equal(await userBubbles(CASES[name].ask), 1, `${name}: the user did not have to resend`);
    assert.equal(await visible(".error-card"), false, `${name}: the error card is gone after recovery`);
  };

  // 甲：key 无效 → 卡上「去换 key」→ 底部面板测试通过才能保存 → 保存后自动接着做。
  evidence.stage = "auth";
  await send(CASES.auth.ask);
  await waitFor('.error-card [data-act="fix-key"]', "auth card with fix-key");
  await rp.screenshot(panel, join(artifacts, "auth-card.png"));
  assert.equal(await visible('.error-card [data-act="retry-anyway"]'), true, "auth card keeps retry-anyway");
  await rp.click(panel, '.error-card [data-act="fix-key"]');
  await waitFor("#key-sheet.is-open", "key sheet");
  await sleep(500); // 面板升起的动画结束后再点，否则点到的是升起前的位置
  assert.equal(await rp.evaluate(panel, 'document.querySelector("#key-sheet-save").disabled'), true, "save is disabled before a passing test");
  await rp.click(panel, "#key-sheet-input");
  await rp.typeText(panel, "still-bad");
  await rp.click(panel, "#key-sheet-test");
  await until(async () => /失败|无效/.test(String(await rp.evaluate(panel, 'document.querySelector("#key-sheet-status")?.textContent ?? ""'))) || undefined, 20_000, "bad key test fails");
  assert.equal(await rp.evaluate(panel, 'document.querySelector("#key-sheet-save").disabled'), true, "a failed test keeps save disabled");
  assert.doesNotMatch(String(await rp.evaluate(panel, 'document.querySelector("#key-sheet-status")?.textContent ?? ""')), /\{"error"/, "no raw JSON in the sheet");
  await rp.evaluate(panel, 'document.querySelector("#key-sheet-input").value = ""');
  await rp.typeText(panel, "good-key");
  await rp.click(panel, "#key-sheet-test");
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#key-sheet-save").disabled === false') || undefined, 20_000, "good key test passes");
  await rp.screenshot(panel, join(artifacts, "auth-sheet.png"));
  await rp.click(panel, "#key-sheet-save");
  await recovered("auth", /出过错.*换.*key.*从出错处继续/);
  evidence.storedKey = await rp.evaluate(panel, 'chrome.storage.local.get("inproc_cred:custom").then(v => v["inproc_cred:custom"]?.key)');
  assert.equal(evidence.storedKey, "good-key", "the new key is saved for later tasks");
  await rp.screenshot(panel, join(artifacts, "auth-final.png"));

  // 乙：限流 → 「稍后重试」倒计时后自动接着做。
  evidence.stage = "busy";
  failNext = { kind: "busy", count: 3 };
  await send(CASES.busy.ask);
  await waitFor('.error-card [data-act="later"]', "busy card with later");
  assert.equal(await visible('.error-card [data-act="pick-model"]'), true, "busy card offers another model on the card itself");
  assert.doesNotMatch(await text(), /在下方换/, "no pointer to a control that does not exist");
  await rp.screenshot(panel, join(artifacts, "busy-card.png"));
  await rp.click(panel, '.error-card [data-act="later"]');
  await until(async () => /秒后/.test(String(await rp.evaluate(panel, 'document.querySelector(\'.error-card [data-act="later"]\')?.textContent ?? ""'))) || undefined, 5_000, "countdown visible");
  await recovered("busy", /出过错.*重试.*从出错处继续/);

  // 丙：断网 → 「重试」→ 接着做。
  evidence.stage = "net";
  netDown = true;
  await send(CASES.net.ask);
  await waitFor('.error-card [data-act="retry"]', "net card with retry");
  await rp.screenshot(panel, join(artifacts, "net-card.png"));
  // 还没恢复时点「重试」：换一张新卡，仍可再点。
  await rp.click(panel, '.error-card [data-act="retry"]');
  await until(async () => await visible(".error-card.is-recovering") === false && await visible('.error-card [data-act="retry"]') || undefined, 60_000, "net card again while still down");
  assert.equal(await rp.evaluate(panel, 'document.querySelectorAll(".error-card").length'), 1, "a failed retry replaces the card instead of stacking a second one");
  netDown = false;
  await rp.click(panel, '.error-card [data-act="retry"]');
  await recovered("net", /出过错.*重试.*从出错处继续/);
  await rp.screenshot(panel, join(artifacts, "net-final.png"));

  evidence.stage = "done";
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) {
    evidence.messages = await rp.evaluate(panel, '[...document.querySelectorAll("#messages > *")].map(el => `${el.className}: ${el.textContent.slice(0, 60)}`)').catch(() => null);
    await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => undefined);
  }
} finally {
  evidence.gate = gate.map(g => g.result);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  front.closeAllConnections();
  front.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
