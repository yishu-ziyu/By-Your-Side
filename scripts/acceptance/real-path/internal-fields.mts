import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeModelError, plainError, plainToolError } from "../../../shared/user-facing.ts";
import { launchRealPath, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

const out = join(process.cwd(), "out", "acceptance", "real-path", "internal-fields");
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><meta charset=utf-8><title>留言页</title><h1>差旅报销制度</h1><label>部门 <input id=dept></label><label>密码 <input id=pwd type=password></label>`;
const site = createServer((_q, s) => s.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
await new Promise<void>(d => site.listen(0, "127.0.0.1", d));
const url = `http://127.0.0.1:${siteAddress(site).port}/`;

const THOUGHT = "Let me do one browser_run. The answer card components: <option> for choosing.";
const FAKE_KEY = "sk-proj-FAKEFAKEFAKE1234567890abcdef";
const ASK = { work: "案例做事：填这一页。", fail: "案例失败：点不存在的。", key: "案例密钥：这句出错。", other: "案例其他：这句奇怪。" };
const done = { text: JSON.stringify({ status: "done", remaining: "", correction: "" }) };
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [done] },
  { match: '"lastReply"', steps: [done] },
  { match: ASK.work, steps: [
    { text: "", reasoning: THOUGHT, thenTool: { name: "navigate", args: { url } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "fill", args: { target: "#dept", label: "部门", value: "市场部" } } },
    { tool: { name: "fill", args: { target: "#pwd", label: "密码", value: "hunter2-secret" } } },
    { text: "填好了。", delayMs: 300 },
  ] },
  { match: ASK.fail, steps: [{ tool: { name: "js", args: { code: "nope.x()", purpose: "检查" } } }, { text: "结束。" }] },
  { match: ASK.key, steps: [{ status: 401, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}. request id req_abc123` } }) }] },
  { match: ASK.other, steps: [{ status: 400, body: JSON.stringify({ error: { message: "tool_choice is invalid at messages[3].content[0]" } }) }] },
]);

const checks: Array<{ name: string; pass: boolean; actual: unknown }> = [];
const check = (name: string, pass: boolean, actual?: unknown) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual ?? null)); };
const INTERNAL = /page-content|untrusted|\[ref=|RootWebArea|browser_run|snapshot|"target"|\{"/;

const rp = await launchRealPath({ dist: process.env.SIDEAGENT_ACCEPTANCE_DIST });
let failed = false;
try {
  const work = await rp.attach((await rp.targets()).find((t: { url: string }) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const ev = (code: string) => rp.evaluate(panel, code);
  await ev(`chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  await until(async () => await ev('document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 820, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await sleep(1_500);
  const send = async (text: string) => {
    await rp.click(panel, "#input");
    await rp.cdp.send("Input.insertText", { text }, panel);
    await sleep(200);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" }, panel);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, panel);
    await sleep(200);
  };
  const idle = () => until(async () => await ev('document.querySelector("#takeover-btn").hidden && document.querySelector("#send-btn").title!=="中止"'), 45_000, "空闲");
  const fresh = async () => { await ev('document.querySelector("#conversation-new").click()'); await sleep(1_000); };
  const openSteps = () => ev('document.querySelectorAll("details.run-steps").forEach(d=>d.open=true)');
  const expandAll = `[...document.querySelectorAll("button.chip")].forEach(c=>c.click())`;

  await ev(`(()=>{window.__seen="";const cap=()=>{window.__seen+="\\n"+document.body.innerText};new MutationObserver(cap).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true})})()`);
  await send(ASK.work);
  await until(async () => await ev('document.querySelector("details.run-steps")?.textContent.includes("正在")||false'), 15_000, "过程出现").catch(() => {});
  await openSteps();
  await idle();
  await sleep(500);
  await openSteps();
  await sleep(200);
  check("思考原文全程没有进界面", !String(await ev("window.__seen")).includes("browser_run"), null);
  check("没有思考原文块", await ev('!document.querySelector("details.thinking:not(.narration)")') === true);
  const chips = await ev(`[...document.querySelectorAll(".chip")].map(c=>({tag:c.tagName,label:c.querySelector(".chip-label")?.textContent,more:!!c.querySelector(".chip-more")}))`) as Array<{ tag: string; label: string; more: boolean }>;
  const by = (word: string) => chips.find(c => c.label?.includes(word));
  check("填「部门」能展开", by("部门")?.tag === "BUTTON" && by("部门")?.more === true, chips);
  check("填「密码」不能展开", by("密码")?.tag === "DIV" && by("密码")?.more === false, by("密码"));
  check("读页不能展开", by("读")?.tag === "DIV", chips);
  check("步骤名不露选择器", !chips.some(c => /[#@]|loc=/.test(c.label ?? "")), chips.map(c => c.label));
  await ev(`[...document.querySelectorAll("button.chip")].find(c=>c.textContent.includes("部门"))?.click()`);
  await sleep(250);
  const detail = await ev(`document.querySelector(".chip-detail:not([hidden])")?.innerText ?? ""`) as string;
  check("展开显示填入的内容", detail.includes("填入：市场部"), detail);
  await rp.screenshot(panel, join(out, "steps-expanded.png"));
  await ev(expandAll);
  await sleep(250);
  const body = await ev("document.body.innerText") as string;
  check("点开所有步骤也看不到内部字段", !INTERNAL.test(body), INTERNAL.exec(body)?.[0]);
  check("密码没有显示", !body.includes("hunter2"));

  await fresh();
  await send(ASK.fail);
  await idle();
  await sleep(500);
  await openSteps();
  await sleep(200);
  const failLabel = await ev(`[...document.querySelectorAll(".chip .act-failed")].map(e=>e.textContent).join("|")`) as string;
  check("失败原因不是写给模型的话", failLabel.includes("没做成") && !failLabel.includes("表达式"), failLabel);
  await rp.screenshot(panel, join(out, "fail-label.png"));

  await fresh();
  await ev(`(()=>{window.__copied=[];navigator.clipboard.writeText=t=>{window.__copied.push(t);return Promise.resolve()}})()`);
  await send(ASK.key);
  await idle();
  await sleep(500);
  const card = await ev(`[...document.querySelectorAll(".error-card")].at(-1)?.innerText ?? ""`) as string;
  check("错误卡没有技术详情", !card.includes("技术详情") && !(await ev('!!document.querySelector(".error-card-tech")')), card);
  check("错误卡不显示密钥和原文", !card.includes("FAKEFAKE") && !card.includes("Incorrect"), card);
  check("错误卡不露内部模型标识和 key", !card.includes("custom/fixture") && !/\bkey\b/.test(card) && card.includes("密钥无效"), card);
  await ev(`[...document.querySelectorAll(".error-card [data-act=copy-error]")].at(-1).click()`);
  await sleep(200);
  const copied = await ev("window.__copied.join('')") as string;
  check("复制到的错误信息隐藏了密钥", copied.includes("Incorrect") && copied.includes("[已隐藏]") && !copied.includes("FAKEFAKE"), copied);
  await rp.screenshot(panel, join(out, "key-card.png"));

  await fresh();
  await send(ASK.other);
  await idle();
  await sleep(500);
  const other = await ev(`[...document.querySelectorAll(".error-card")].at(-1)?.innerText ?? ""`) as string;
  check("其他模型错误也看不到服务商原文", !other.includes("tool_choice") && !other.includes("技术详情"), other);

  const entry = 'document.querySelector("#voice-diagnostics-open")';
  await rp.click(panel, "#attach-btn");
  await sleep(300);
  check("语音诊断默认不在菜单里", await ev(`${entry}?.offsetParent===null`) === true);
  await rp.screenshot(panel, join(out, "menu-default.png"));
  await ev(`document.querySelector("#attach-btn").click()`);
  await ev(`chrome.storage.local.set({sideagent_voice_diagnostics:true}).then(()=>true)`);
  await sleep(300);
  await rp.click(panel, "#attach-btn");
  await sleep(300);
  check("设置打开后才出现", await ev(`${entry}?.offsetParent!==null`) === true);
  await rp.click(panel, "#voice-diagnostics-open");
  await sleep(400);
  const diag = await ev(`document.querySelector(".voice-record")?.innerText ?? ""`) as string;
  check("诊断字段是白话", diag.includes("麦克风收到") && diag.includes("导出记录") && !/C0|C1|JSON/.test(diag), diag);
  await rp.screenshot(panel, join(out, "voice-diagnostics.png"));

  const settings = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` })).targetId);
  await sleep(1_500);
  check("设置里有语音诊断开关且读到已打开", await rp.evaluate(settings, 'document.querySelector("#voice-diagnostics")?.checked') === true);

  check("Agent 忙碌的英文报错不会原样显示", plainError("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.", "") === "");
  check("产品写好的中文提示照常显示", plainError("先在「模型与语音」里连接模型。", "") === "先在「模型与语音」里连接模型。");
  check("账号登录的报错提示重新登录", describeModelError("模型请求最终失败（openai-codex/gpt-6-luna）：401 unauthorized")?.title === "ChatGPT 登录已失效");
  check("写给模型的失败句不再原样显示", plainToolError("脚本无法作为只读表达式执行，或读取过程发生异常。") === "没做成" && plainToolError("坐标处对象已替换，操作未执行。") === "页面变了" && plainToolError("ref @2 量不到位置，结果未知。") === "结果未知");
} catch (error) {
  failed = true;
  console.log("FAIL 运行中断", String(error));
} finally {
  await rp.close?.();
  site.close();
  await model.close?.();
}
const pass = !failed && checks.every(c => c.pass);
await writeFile(join(out, "result.json"), JSON.stringify({ status: pass ? "PASS" : "FAIL", checks }, null, 2));
console.log(`${checks.filter(c => c.pass).length} PASS ${checks.filter(c => !c.pass).length} FAIL`);
process.exit(pass ? 0 : 1);
