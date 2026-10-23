/**
 * 真扩展 + 隔离 Chrome + 脚本模型：把做过的事存成「/ 技能」再用一次。
 * 判定：回答下方「存成技能」和用户消息上「存成技能」打开的编辑器里，预填的都是用户的原话，不是助手的回答；
 * 保存后输入框敲 / 能找到它，选中后原话放进输入框，发出去的是同一句原话。
 * 失败方式：命令菜单把回答全文当成技能，下次运行等于把旧回答当新请求发出去。
 *   npx tsx scripts/acceptance/real-path/save-skill.mts --headless
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-save-skill`);
await mkdir(out, { recursive: true });
const TASK = "把这页的要点整理成三条";
const ANSWER = "整理好了：第一条、第二条、第三条。";
const seen: string[] = [];
const textOf = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => typeof part?.text === "string" ? part.text : "").join("") : "";
const model = await startScriptedModel([{ match: TASK, steps: [{ text: ANSWER }] }], undefined, payload => {
  const last = [...(payload.messages ?? [])].reverse().find(m => m.role === "user");
  if (last && textOf(last.content).includes(TASK)) seen.push(textOf(last.content));
});
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const idle = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")';
  await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");
  await rp.click(panel, "#input"); await rp.typeText(panel, TASK); await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, `document.querySelector(".msg.assistant")?.textContent.includes(${JSON.stringify(ANSWER)}) && ${idle}`), 30_000, "回答写完");
  const editorBody = '(document.querySelector(".pskill-form textarea")?.value ?? null)';
  const sheetOpen = '!document.querySelector(".pskill-shade").hidden';

  // 回答下方的命令菜单。
  await rp.evaluate(panel, 'document.querySelector(".msg.assistant").dispatchEvent(new CustomEvent("answer-command", { bubbles: true })), true');
  await until(() => rp.evaluate(panel, '[...document.querySelectorAll(".answer-command-item")].some(r => r.textContent.includes("存成技能"))'), 5_000, "命令菜单");
  await rp.evaluate(panel, '[...document.querySelectorAll(".answer-command-item")].find(r => r.textContent.includes("存成技能")).click(), true');
  await until(() => rp.evaluate(panel, `${editorBody} !== null`), 5_000, "技能编辑器");
  const fromAnswer = await rp.evaluate(panel, editorBody);
  check("回答下方「存成技能」预填用户原话", fromAnswer === TASK, fromAnswer as Json);
  await rp.screenshot(panel, join(out, "1-editor.png"));
  await rp.evaluate(panel, 'document.querySelector(".pskill-form .pskill-btn.primary").click(), true');
  await until(() => rp.evaluate(panel, `!(${sheetOpen}) || ${editorBody} === null`), 5_000, "保存后离开编辑器");
  await rp.evaluate(panel, `(${sheetOpen}) && document.querySelector(".pskill-shade").click(), true`);

  // 用户消息上的入口。
  await rp.evaluate(panel, 'document.querySelector(".msg.user .pskill-save").click(), true');
  await until(() => rp.evaluate(panel, `${sheetOpen} && ${editorBody} !== null`), 5_000, "消息上的编辑器");
  const fromBubble = await rp.evaluate(panel, editorBody);
  check("用户消息上「存成技能」预填用户原话", fromBubble === TASK, fromBubble as Json);
  await rp.evaluate(panel, 'document.querySelector(".pskill-shade").click(), true');

  // 敲 / 找到并运行。
  await rp.evaluate(panel, 'document.querySelector("#input").focus(), true');
  await rp.typeText(panel, "/");
  const name = TASK.slice(0, 12);
  await until(() => rp.evaluate(panel, `[...document.querySelectorAll(".pskill-item .pskill-name")].some(n => n.textContent === ${JSON.stringify(name)})`), 5_000, "/ 菜单里有新技能");
  await rp.screenshot(panel, join(out, "2-slash.png"));
  await rp.evaluate(panel, `[...document.querySelectorAll(".pskill-item")].find(i => i.querySelector(".pskill-name")?.textContent === ${JSON.stringify(name)}).click(), true`);
  // 没有澄清问题的技能把原话放进输入框，用户看过再发。
  await until(() => rp.evaluate(panel, `document.querySelector("#input").value === ${JSON.stringify(TASK)}`), 5_000, "技能放进输入框");
  await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, `document.querySelectorAll(".msg.user").length >= 2 && ${idle}`), 30_000, "技能发出并答完");
  const users = await rp.evaluate(panel, '[...document.querySelectorAll(".msg.user .user-msg-text")].map(e => e.textContent)') as string[];
  check("运行技能发出的是原话", users.at(-1) === TASK && seen.length >= 2, { users, modelSaw: seen.length } as Json);
  await rp.screenshot(panel, join(out, "3-ran.png"));
} catch (error) { check("流程完成", false, String(error)); }
finally { await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2)); await rp.close(); await rp.remove(); await model.close(); }
console.log(`证据：${out}`);
if (!checks.length || checks.some(c => !c.pass)) process.exitCode = 1;
