import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-fill-undo-user-edit`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>资料填写</title></head><body><form>
<label>姓名 <input id="name"></label>
<label>邮箱 <input id="email"></label>
</form></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const tool = (name: string, args: Record<string, string>) => ({ tool: { name, args } });
const ASK = {
  fill: "请填写姓名",
  clear: "请清空姓名",
  again: "请再填一次姓名",
  undo: "请撤回上一次填写",
  mail: "请填写邮箱",
};
const DONE = {
  fill: "姓名已填成测试用户A。",
  clear: "姓名已清空。",
  again: "姓名再次填成测试用户A。",
  undo: "撤回这步停住了。",
  mail: "邮箱已填好。",
};
const USER = "用户新改值";
const toolNotes: string[] = [];
let seenTools = 0;

const model = await startScriptedModel([
  { match: ASK.fill, steps: [tool("fill", { target: "#name", value: "测试用户A" }), { text: DONE.fill }] },
  { match: ASK.again, steps: [tool("fill", { target: "#name", value: "测试用户A" }), { text: DONE.again }] },
  { match: ASK.clear, steps: [tool("fill", { target: "#name", value: "" }), { text: DONE.clear }] },
  { match: ASK.undo, steps: [tool("click", { target: "#name" }), tool("fill", { target: "#name", value: "" }), tool("type_text", { text: "键盘值" }), { text: DONE.undo }] },
  { match: ASK.mail, steps: [tool("fill", { target: "#email", value: "a@b.co" }), { text: DONE.mail }] },
], undefined, payload => {
  const tools = (payload.messages ?? []).flatMap(message => message.role === "tool" ? [typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")] : []);

  if (tools.length > seenTools) {
    toolNotes.push(...tools.slice(seenTools));
    seenTools = tools.length;
  }
});

const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new") && document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const settled = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "turn settled", 100);
  const answerOf = (done: string) => `[...document.querySelectorAll("#messages .msg.assistant")].filter(m => m.textContent.includes(${JSON.stringify(done)})).at(-1)`;
  const say = async (text: string, done: string) => {
    await settled();
    const before = Number(await rp.evaluate(panel, 'document.querySelectorAll("#messages .msg.user").length'));
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => Number(await rp.evaluate(panel, 'document.querySelectorAll("#messages .msg.user").length')) > before || undefined, 15_000, "user bubble");
    await until(async () => await rp.evaluate(panel, `!![...document.querySelectorAll("#messages .msg.assistant")].filter(m => m.textContent.includes(${JSON.stringify(done)})).at(-1)?.querySelector(".answer-actions")`) || undefined, 60_000, `answer ${done}`, 100);
    await settled();
  };
  const edit = async (id: string, value: string) => rp.evaluate(work, `(() => { const el = document.getElementById(${JSON.stringify(id)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; })()`);
  const field = (id: string) => rp.evaluate(work, `document.getElementById(${JSON.stringify(id)}).value`);
  const load = async () => {
    await rp.cdp.send("Page.navigate", { url: origin }, work);
    await until(async () => await rp.evaluate(work, 'document.readyState==="complete" && !!document.getElementById("name")') || undefined, 10_000, "page loaded");
  };

  await load();
  await say(ASK.mail, DONE.mail);
  assert.equal(await field("email"), "a@b.co", "邮箱先被填写");
  assert.equal(await edit("email", "user@edit.test"), "user@edit.test", "用户改写邮箱");
  const answer = answerOf(DONE.mail);
  await until(async () => {
    const text = await rp.evaluate(panel, `(() => { const a = ${answer}; const card = (() => { for (let n = a?.previousElementSibling; n && !n.matches(".msg.user"); n = n.previousElementSibling) if (n.matches("details.plan-card")) return n; return null; })(); return card?.querySelector(".plan-undo")?.textContent ?? ""; })()`);

    return text === "恢复这 1 处填写" ? text : undefined;
  }, 15_000, "restore button", 100);
  await rp.evaluate(panel, `(() => { const a = ${answer}; for (let n = a?.previousElementSibling; n && !n.matches(".msg.user"); n = n.previousElementSibling) { const u = n.matches("details.plan-card") && n.querySelector(".plan-undo"); if (u) { u.setAttribute("data-probe", "undo"); return true; } } return false; })()`);
  await rp.click(panel, `[data-probe="undo"]`);
  const restored = await until(async () => {
    const text = await rp.evaluate(panel, `(() => { const a = ${answer}; for (let n = a?.previousElementSibling; n && !n.matches(".msg.user"); n = n.previousElementSibling) if (n.matches("details.plan-card")) { const line = n.nextElementSibling?.matches(".fill-undo-result") ? n.nextElementSibling.textContent : ""; return line || undefined; } return undefined; })()`);

    return typeof text === "string" && text.includes("你后来改过") ? text : undefined;
  }, 15_000, "user changed restore", 100);
  const email = await field("email");
  evidence.restore = { restored, email };
  assert.equal(email, "user@edit.test", "点恢复这处填写时，用户改过的邮箱保持不动");
  assert.match(String(restored), /你后来改过/, `恢复结果要说明没动 ${restored}`);

  await say(ASK.again, DONE.again);
  assert.equal(await field("name"), "测试用户A", "第一次填写写进姓名");
  await say(ASK.clear, DONE.clear);
  assert.equal(await field("name"), "", "用户没改过时，可以写回填写前的空白");
  await say(ASK.fill, DONE.fill);
  assert.equal(await field("name"), "测试用户A", "助手仍可覆盖自己刚写下的值");
  assert.equal(await edit("name", USER), USER, "用户改写姓名");
  await say(ASK.undo, DONE.undo);
  const afterUndo = await field("name");
  const refusal = toolNotes.filter(text => text.includes("没有写入"));
  evidence.afterUndo = { value: afterUndo, refusal };
  assert.equal(afterUndo, USER, `撤回填写不能清掉用户后来改的姓名 ${afterUndo}`);
  assert.ok(refusal.filter(text => text.includes("姓名")).length >= 2, `填写和键盘输入都要被拒绝 ${JSON.stringify(refusal)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  evidence.toolNotes = toolNotes;
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
