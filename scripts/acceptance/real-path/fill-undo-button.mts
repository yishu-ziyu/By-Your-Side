/**
 * 侧栏的「还原填写」按钮：只装扩展、隔离构建、本机脚本模型、本机练习页，真实点击。
 *   npx tsx scripts/acceptance/real-path/fill-undo-button.mts --headless
 *   1) 助手填姓名、手机号、人数后回答；回答下的主按钮是「还原填写（3 处）」。用户自己改了姓名，再点按钮：
 *      网页里手机号、人数回到原样，姓名不动；按钮灰掉写「已还原」，下面写「还原了 2 处。「姓名」你后来改过，没动。」，上面那段回答变淡。
 *      下一轮开始后，这条回答仍是“已还原”、仍变淡。
 *   2) 助手填完，用户自己点网页的提交：按钮灰掉写「已提交，收不回」，下面写为什么。
 *   3) 助手填完，页面刷新：按钮灰掉写「页面变了，收不回」。
 *   4) 助手填完、用户没点还原就开始下一轮：那条回答的按钮换回「复制」。已提交、页面变了的回答保留原状态。
 *   5) 助手只改了编辑器里的文字（没有能还原的格子）：不出还原按钮，回答下写“编辑器里的文字没还原。”。
 * “已提交”只认网页真的提交表单：2) 里是用户真实点击提交按钮、网页发出 submit 事件。
 *   另：空输入框按回车不会还原（只能点按钮）；还原后重开侧栏，只有这一轮的回答是“已还原”，更早的回答不变淡。
 * --record：录下第 1 段（填表 → 用户改一格 → 点还原）的侧栏和网页，合成左右并排的 restore.mp4，只给人看，不参与判定。
 * 后台怎样记、怎样写回由 fill-undo.mts 验收；这里只看侧栏用户看得到的样子。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-fill-undo-button`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>预约到店</title><style>body{margin:0;padding:32px 40px;font:22px/2 sans-serif;color:#222}input,select,button{font:inherit;padding:2px 8px}#note{border:1px solid #ccc;padding:4px 8px;width:420px}</style></head><body><main>
<form id="form" onsubmit="event.preventDefault(); document.getElementById('sent').hidden = false;">
<label>姓名 <input id="name"></label><br>
<label>手机号 <input id="phone"></label><br>
<label>人数 <select id="size"><option>1 人</option><option selected>2 人</option><option>3 人</option><option>4 人</option></select></label><br>
<div id="note" contenteditable="true" aria-label="备注">原备注</div>
<button id="submit" type="submit">提交预约</button>
<p id="sent" hidden>已提交</p>
</form></main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const tool = (name: string, args: Record<string, string>) => ({ tool: { name, args } });
const ASK = { note: "按钮案例六：只改备注。", chat: "按钮案例零：你好。", form: "按钮案例一：帮我把预约填好，先别提交。", submit: "按钮案例二：只填姓名。", reload: "按钮案例三：只填手机号。", left: "按钮案例四：只填人数。", next: "按钮案例五：好的。" };
const DONE = { note: "备注改好了。", chat: "你好，要我帮你做什么？", form: "填好了：4 个人，联系人王小明。还没有点提交，你核对一下。", submit: "姓名填好了。", reload: "手机号填好了。", left: "人数填好了。", next: "好的，有事再叫我。" };

const model = await startScriptedModel([
  { match: ASK.form, steps: [tool("fill", { target: "#name", value: "13812345678" }), tool("fill", { target: "#phone", value: "王小明" }), tool("select_option", { target: "#size", values: "4 人" }), { text: DONE.form }] },
  { match: ASK.submit, steps: [tool("fill", { target: "#name", value: "李四" }), { text: DONE.submit }] },
  { match: ASK.reload, steps: [tool("fill", { target: "#phone", value: "13900000000" }), { text: DONE.reload }] },
  { match: ASK.chat, steps: [{ text: DONE.chat }] },
  { match: ASK.left, steps: [tool("select_option", { target: "#size", values: "3 人" }), { text: DONE.left }] },
  { match: ASK.next, steps: [{ text: DONE.next }] },
  { match: ASK.note, steps: [tool("fill", { target: "#note", value: "新备注" }), { text: DONE.note }] },
]);

const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;

type Seen = { button: string; disabled: boolean; result: string; faded: number; row: number; inView: boolean };

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const settled = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "turn settled", 100);
  const answerOf = (done: string) => `[...document.querySelectorAll("#messages .msg.assistant")].find(m => m.textContent.includes(${JSON.stringify(done)}))`;
  const seen = async (done: string): Promise<Seen> => await rp.evaluate(panel, `(() => { const a = ${answerOf(done)}; const b = a?.querySelector(".answer-primary");
    return { button: b?.querySelector("span")?.textContent ?? "", disabled: !!b?.disabled, result: a?.querySelector(".fill-undo-result")?.textContent ?? "", faded: Number(getComputedStyle(a.querySelector("p")).opacity),
      row: Number(getComputedStyle(a.querySelector(".answer-actions")).opacity),
      // 结果行整行在对话区里、没被输入框挡住。
      inView: (() => { const line = a?.querySelector(".fill-undo-result"); if (!line) return false; const r = line.getBoundingClientRect(), box = document.querySelector("#messages").getBoundingClientRect();
        return r.height > 0 && r.top >= box.top && r.bottom <= box.bottom; })() }; })()`) as Seen;
  const waitButton = (done: string, text: string) => until(async () => { const s = await seen(done); return s.button.includes(text) ? s : undefined; }, 15_000, `button ${text}`, 100);
  const page = (expr: string) => rp.evaluate(work, expr);

  async function run(key: keyof typeof ASK, fresh = true): Promise<void> {
    await settled();

    if (fresh) {
      await rp.cdp.send("Page.navigate", { url: origin }, work);
      await until(async () => await rp.evaluate(work, 'document.readyState==="complete"') || undefined, 10_000, "page loaded");
    }
    await rp.click(panel, "#input");
    await rp.typeText(panel, ASK[key]);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `!!${answerOf(DONE[key])}?.querySelector(".answer-actions")`) || undefined, 60_000, `case ${key} answer`, 100);
    await settled();
  }

  await run("chat", false);

  // 1) 填错了，用户改过姓名，点侧栏的还原。
  const record = process.argv.includes("--record");
  const stops = record ? [await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")), await recordScreen(rp.cdp, work, join(artifacts, "page.mp4"))] : [];
  await run("form");
  const ready = await waitButton(DONE.form, "还原填写（3 处）");
  evidence.ready = ready;
  assert.ok(!ready.disabled && !ready.result && ready.faded === 1, `1: 主按钮是还原填写，可以点 ${JSON.stringify(ready)}`);
  await rp.screenshot(panel, join(artifacts, "1-ready.png"));
  if (record) await sleep(2000);

  // 空输入框按回车：以前是复制；还原会改网页，只能点按钮。
  await rp.click(panel, "#input");
  await rp.pressEnter(panel);
  await sleep(600);
  const afterEnter = { page: await page(`document.getElementById("phone").value`), button: (await seen(DONE.form)).button };
  evidence.afterEnter = afterEnter;
  assert.deepEqual(afterEnter, { page: "王小明", button: "还原填写（3 处）" }, `1: 空输入框按回车不还原 ${JSON.stringify(afterEnter)}`);

  await rp.click(work, "#name");
  for (const type of ["keyDown", "keyUp"]) await rp.cdp.send("Input.dispatchKeyEvent", { type, key: "End", code: "End", windowsVirtualKeyCode: 35 }, work);
  await rp.typeText(work, "先生");
  await rp.screenshot(work, join(artifacts, "1-page-before-restore.png"));
  if (record) await sleep(1500);
  await rp.click(panel, `.msg.assistant .answer-primary[data-action="undo-fill"]`);
  const restored = await waitButton(DONE.form, "已还原");
  await sleep(400);
  const after = await seen(DONE.form);
  evidence.restored = after;
  evidence.pageAfterRestore = JSON.parse(String(await page(`JSON.stringify({ name: document.getElementById("name").value, phone: document.getElementById("phone").value, size: document.getElementById("size").value })`)));
  await rp.screenshot(panel, join(artifacts, "1-restored.png"));
  await rp.screenshot(work, join(artifacts, "1-page-after-restore.png"));

  if (record) {
    await sleep(2000);
    const [panelVideo, pageVideo] = await Promise.all(stops.map(stop => stop()));

    // 两段同时开始录，左右并排成一段；高度对齐到侧栏。
    if (panelVideo && pageVideo) {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", pageVideo, "-i", panelVideo, "-filter_complex",
        "[0:v][1:v]scale2ref=oh*mdar:ih[page][panel];[page][panel]hstack=inputs=2,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", join(artifacts, "restore.mp4")]);
      evidence.recording = join(artifacts, "restore.mp4");
    }
  }
  assert.ok(restored.disabled, "1: 还原后按钮灰掉");
  assert.equal(after.result, "还原了 2 处。「姓名」你后来改过，没动。", "1: 结果行说清还原了几处、哪一栏没动");
  assert.ok(after.inView, `1: 结果行在视野里 ${JSON.stringify(after)}`);
  assert.ok(after.faded < 0.6, `1: 上面那段回答变淡 ${after.faded}`);
  assert.deepEqual(evidence.pageAfterRestore, { name: "13812345678先生", phone: "", size: "2 人" }, "1: 网页里只有用户没改过的栏回到原样");

  // 还原后重开侧栏：后台先补发状态、再回放历史，只有这一轮的回答是“已还原”。
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, `!!${answerOf(DONE.form)}?.querySelector(".answer-actions") && !!${answerOf(DONE.chat)}?.querySelector(".answer-actions")`) || undefined, 30_000, "history replayed", 100);
  await sleep(600);
  const reopened = { chat: await seen(DONE.chat), form: await seen(DONE.form) };
  evidence.reopened = reopened;
  assert.ok(reopened.form.button.includes("已还原") && reopened.form.faded < 0.6 && reopened.chat.faded === 1 && !reopened.chat.button.includes("还原"),
    `1: 重开侧栏后只有这一轮的回答是已还原 ${JSON.stringify(reopened)}`);

  // 2) 用户自己点了提交。
  await run("submit");
  const keep = await seen(DONE.form);
  evidence.firstAfterNextTurn = keep;
  assert.ok(keep.button.includes("已还原") && keep.faded < 0.6, `1: 下一轮开始后，还原过的回答仍是已还原、仍变淡 ${JSON.stringify(keep)}`);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, panel);
  await sleep(300);
  const unhovered = await seen(DONE.form);
  assert.equal(unhovered.row, 1, `1: 不是最新一条、鼠标也不在上面时，“已还原”那一排照样看得见 ${JSON.stringify(unhovered)}`);
  await waitButton(DONE.submit, "还原填写（1 处）");
  await rp.click(work, "#submit");
  const submitted = await waitButton(DONE.submit, "已提交，收不回");
  evidence.submitted = submitted;
  assert.ok(submitted.disabled && submitted.result.startsWith("表单已经交给网站") && submitted.faded === 1 && submitted.inView, `2: 已提交时灰掉并写原因（在视野里），回答不变淡 ${JSON.stringify(submitted)}`);
  await rp.screenshot(panel, join(artifacts, "2-submitted.png"));

  // 3) 页面刷新。
  await run("reload");
  await waitButton(DONE.reload, "还原填写（1 处）");
  await rp.cdp.send("Page.reload", {}, work);
  const changed = await waitButton(DONE.reload, "页面变了，收不回");
  evidence.pageChanged = changed;
  assert.ok(changed.disabled && changed.result.startsWith("页面已经换了") && changed.inView, `3: 页面变了时灰掉并写原因（在视野里） ${JSON.stringify(changed)}`);
  await rp.screenshot(panel, join(artifacts, "3-page-changed.png"));

  // 4) 填完没点还原就开始下一轮：可点的还原按钮换回复制；已定下来的状态留着。
  await run("left");
  await waitButton(DONE.left, "还原填写（1 处）");
  await run("next", false);
  const left = await until(async () => { const s = await seen(DONE.left); return s.button === "复制" ? s : undefined; }, 15_000, "button back to copy", 100);
  const kept = { submitted: (await seen(DONE.submit)).button, changed: (await seen(DONE.reload)).button };
  evidence.nextRound = { left, kept };
  assert.ok(!left.disabled && !left.result, `4: 没点过的还原按钮换回复制 ${JSON.stringify(left)}`);
  assert.deepEqual(kept, { submitted: "已提交，收不回", changed: "页面变了，收不回" }, "4: 已提交、页面变了的回答保留原状态");

  // 5) 只有说明、没有能还原的格子。
  await run("note");
  await until(async () => (await seen(DONE.note)).result || undefined, 15_000, "note line", 100);
  await sleep(400);
  const note = await seen(DONE.note);
  evidence.noteOnly = note;
  assert.ok(note.button === "复制" && note.result === "编辑器里的文字没还原。", `5: 只有说明时不出还原按钮，只写说明 ${JSON.stringify(note)}`);
  assert.ok(note.inView, `5: 说明行在视野里，没落在输入框下面 ${JSON.stringify(note)}`);
  await rp.screenshot(panel, join(artifacts, "5-note-only.png"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
