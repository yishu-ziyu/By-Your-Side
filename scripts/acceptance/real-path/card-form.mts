/**
 * 助手问用户时的表单卡（docs/evals/20261019-card-form.md R1–R3）。
 *   npx tsx scripts/acceptance/real-path/card-form.mts --headless
 * 脚本模型写一张订票前确认卡：车次是两个选项（预填一个、带出处）、乘客是文字框、备注选填，外加一栏“密码”（不该画）。
 * 清空必填栏看按钮变灰并标出；改值后重开侧栏看值还在；点「按这个订」看侧栏出现那句用户的话、模型收到它、表单变只读；再重开仍是已发送。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-card-form`);

await mkdir(artifacts, { recursive: true });

const TASK = "帮我订明天去杭州的票";

const SENT = "车次：G7301 06:52；乘客：2 位成人";

const ANSWER = `订票前确认两件事：
<card title="订票前确认">
<field id="train" label="车次" options="G7301 06:52|G7503 07:30" value="G7503 07:30" from="9 点前到西湖边" />
<field id="people" label="乘客" value="1 位成人" />
<field id="note" label="备注" optional />
<field id="pwd" label="12306 密码" />
<button action="submit" primary>按这个订</button>
</card>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>12306</title><h1>上海虹桥→杭州东</h1><p>G7301 06:52；G7503 07:30</p>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const asked: string[] = [];

const model = await startScriptedModel([
  { match: TASK, steps: [{ text: ANSWER, chunkDelayMs: 30 }] },
  { match: "车次：", steps: [{ text: "好的，按 G7301 订两位。" }] },
], undefined, (payload) => {
  const users = (payload.messages ?? []).filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : (m.content ?? []).map(p => p.text ?? "").join(""));

  if (payload.tools?.length) asked.push(...users.filter(t => t.includes("车次：")));
});

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let panelSession = "";

type Seen = { labels: string[]; chips: Array<{ text: string; on: boolean }>; from: string; people: string; missing: string[]; button: { text: string; disabled: boolean } | null; locked: boolean; cardText: string };

const SEEN = `(() => {
  const card = document.querySelector("#messages .gen-card");
  const field = id => card?.querySelector('.gc-field[data-gc-field="' + id + '"]');
  const button = card?.querySelector("[data-card-submit]");
  return {
    labels: [...(card?.querySelectorAll(".gc-field-head .k") ?? [])].map(k => k.textContent),
    chips: [...(field("train")?.querySelectorAll(".gc-chip") ?? [])].map(c => ({ text: c.textContent, on: c.getAttribute("aria-checked") === "true" })),
    from: field("train")?.querySelector(".from")?.textContent ?? "",
    people: field("people")?.querySelector(".gc-text")?.value ?? "",
    missing: [...(card?.querySelectorAll(".gc-field.gc-missing") ?? [])].map(f => f.dataset.gcField),
    button: button ? { text: button.textContent, disabled: button.disabled } : null,
    locked: [...(card?.querySelectorAll(".gc-text, .gc-chip") ?? [])].every(c => c.disabled),
    cardText: card?.innerText ?? "",
  };
})()`;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panelTarget = await rp.openSidePanel();
  const panel = await rp.attach(panelTarget);
  panelSession = panel;
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  const settled = async () => await until(async () => await rp.evaluate(panel, `!!document.querySelector("#messages .msg.assistant .answer-actions") && !!document.querySelector("#messages .gen-card [data-card-submit]") && !document.querySelector("#messages .msg.assistant.streaming")`).catch(() => false) || undefined, 60_000, "回答写完");
  await settled();
  await sleep(500);
  const seen = async () => await rp.evaluate(panel, SEEN) as Seen;
  const tap = async (selector: string) => {
    await rp.evaluate(panel, `document.querySelector(${JSON.stringify("#messages " + selector)})?.scrollIntoView({ block: "center" }), true`);
    await sleep(100);
    await rp.click(panel, `#messages ${selector}`);
  };

  // R1：三栏画出来，密码栏不画；车次是选项、预填的那个选中、出处在名字旁；乘客是文字框带预填值。
  const first = await seen();
  evidence.first = first;
  await rp.screenshot(panel, join(artifacts, "1-drawn.png"));
  assert.deepEqual(first.labels, ["车次", "乘客", "备注"], `R1: fields drawn, password field dropped: ${JSON.stringify(first.labels)}`);
  assert.ok(!first.cardText.includes("密码"), "R1: no password field anywhere");
  assert.deepEqual(first.chips, [{ text: "G7301 06:52", on: false }, { text: "G7503 07:30", on: true }], "R1: options drawn with the prefilled one picked");
  assert.ok(first.from.includes("9 点前到西湖边"), `R1: source shown: ${first.from}`);
  assert.equal(first.people, "1 位成人", "R1: text box prefilled");
  assert.deepEqual(first.button, { text: "按这个订", disabled: false }, "R1: submit button ready");

  // R2（反）：清空必填的乘客，按钮不能点，乘客标出来；选填的备注空着不算。
  await tap('.gc-field[data-gc-field="people"] .gc-text');
  await rp.evaluate(panel, `document.querySelector('#messages .gc-field[data-gc-field="people"] .gc-text').select(), true`);
  for (const type of ["keyDown", "keyUp"]) await rp.cdp.send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, panel);
  await sleep(200);
  const empty = await seen();
  evidence.empty = empty;
  await rp.screenshot(panel, join(artifacts, "2-missing.png"));
  assert.deepEqual(empty.missing, ["people"], `R2: only the empty required field is marked: ${JSON.stringify(empty.missing)}`);
  assert.equal(empty.button?.disabled, true, "R2: submit disabled while a required field is empty");

  // 改成 2 位成人、改选 G7301。
  await rp.typeText(panel, "2 位成人");
  await tap(".gen-card .gc-title");
  await tap('.gc-chip[data-gc-option="G7301 06:52"]');
  await sleep(300);
  const edited = await seen();
  assert.equal(edited.people, "2 位成人", "edited people");
  assert.deepEqual(edited.chips.map(c => c.on), [true, false], "picked G7301");
  assert.equal(edited.button?.disabled, false, "R2: submit enabled again");

  // R3：没发出去就重开侧栏，改过的值还在。
  await rp.cdp.send("Page.reload", {}, panel);
  await settled();
  await sleep(1_000);
  const reopened = await seen();
  evidence.reopened = reopened;
  assert.equal(reopened.people, "2 位成人", "R3: edited text kept after reopening");
  assert.deepEqual(reopened.chips.map(c => c.on), [true, false], "R3: picked option kept after reopening");

  // 另一个窗口也开着侧栏（在后台，不抢前台）：发出表单不该串到那边。
  const otherWindow = Number(await rp.evaluate(panel, `chrome.windows.create({ url: "about:blank", focused: false }).then(w => w.id)`));
  await rp.evaluate(panel, `chrome.sidePanel.open({ windowId: ${otherWindow} }).then(() => true)`, { userGesture: true });
  await sleep(1_500);
  const panels = await until(async () => { const ts = (await rp.targets()).filter(t => t.type === "page" && t.url.includes("/sidepanel.html")); return ts.length >= 2 ? ts : undefined; }, 15_000, "第二个侧栏");
  const otherPanel = await rp.attach(panels.find(t => t.targetId !== panelTarget)!.targetId);
  await until(async () => await rp.evaluate(otherPanel, 'document.readyState === "complete" && !!document.querySelector("#messages")') || undefined, 15_000, "第二个侧栏就绪");

  // R2：点「按这个订」，侧栏出现那句话，模型收到它，表单变只读、按钮写已发送。
  await tap("[data-card-submit]");
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].some(m => m.textContent.includes(${JSON.stringify(SENT)}))`) || undefined, 10_000, "R2: user message shown");
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].some(m => m.textContent.includes("好的，按 G7301 订两位"))`) || undefined, 60_000, "R2: follow-up answered");
  const sent = await seen();
  evidence.sent = sent;
  evidence.asked = asked;
  await rp.screenshot(panel, join(artifacts, "3-sent.png"));
  assert.ok(asked.some(t => t.includes(SENT)), `R2: model received the form message: ${JSON.stringify(asked)}`);
  assert.deepEqual(sent.button, { text: "已发送", disabled: true }, `R2: button shows sent: ${JSON.stringify(sent.button)}`);
  assert.ok(sent.locked, "R2: fields read-only after sending");
  // 两个窗口显示的是同一个会话：那边的同一张表单也要变成已发送、只读，不能再发一次。
  const other = await until(async () => { const b = await rp.evaluate(otherPanel, SEEN) as Seen; return b.button?.text === "已发送" ? b : undefined; }, 10_000, "另一个窗口的表单变成已发送").catch(async () => await rp.evaluate(otherPanel, SEEN) as Seen);
  evidence.other = other;
  assert.deepEqual(other.button, { text: "已发送", disabled: true }, `two windows: the other panel's form shows sent: ${JSON.stringify(other.button)}`);
  assert.ok(other.locked, "two windows: the other panel's form is read-only");

  // R3：发出后重开，仍是已发送、只读。
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector("#messages .gen-card [data-card-submit]")`).catch(() => false) || undefined, 30_000, "重开后表单回放");
  await sleep(1_000);
  const replay = await seen();
  evidence.replay = replay;
  assert.deepEqual(replay.button, { text: "已发送", disabled: true }, `R3: still sent after reopening: ${JSON.stringify(replay.button)}`);
  assert.ok(replay.locked && replay.people === "2 位成人", "R3: still read-only with the sent values");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panelSession) {
    evidence.failedPanel = await rp.evaluate(panelSession, `(document.querySelector("#messages")?.innerText ?? "no #messages: " + location.href).slice(-1500)`).catch((e) => String(e));
    await rp.screenshot(panelSession, join(artifacts, "failed.png")).catch(() => undefined);
  }
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
