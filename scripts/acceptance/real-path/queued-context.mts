/**
 * 上一件还在做时说的下一句，另开一件排队去做：轮到它时要接得上这个会话前面说过、查到的东西，
 * 不能回「把文字发来」。用户只靠说话时没法再发一遍。
 * 只装扩展、隔离构建、本机脚本模型；脚本模型只证明程序那一层（前文有没有进到新任务），不证明真模型会怎么用它。
 *   npx tsx scripts/acceptance/real-path/queued-context.mts --headless
 *   1) 第一件做完，回答里有一个只在这里出现的词。
 *   2) 第二件被拖住；这时打字说「把刚才那个例子整理成要点」，被判成另开一件，排进队列在自己的会话里做。
 *   3) 另开那件的回答带回侧栏：脚本模型只有在它的上下文里看到第一件的回答时，才回「整理要点：沿用上一轮的青柠协议」。
 * 失败方式：排队执行时不带发起会话的前文，3 只看到「好的。」。
 * 语音入口（agent/src/conversation-manager.ts 语音计划里的排队）进的是同一个队列和执行，这里不另跑语音。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-queued-context`);

await mkdir(out, { recursive: true });

const FIRST = "查一个例子";
const FIRST_ANSWER = "青柠协议：这是上一轮查到的例子。";
const HOLD = "第二件慢慢做";
const ASK = "把刚才那个例子整理成要点";
const RECALLED = "整理要点：沿用上一轮的青柠协议";

const model = await startScriptedModel([
  // 「运行中这句是不是另一件事」的判断：请求内容是 {currentTask, message} 的 JSON。
  { match: `"message":"${ASK}`, steps: [{ text: '{"kind":"separate"}' }] },
  // 只有对话记录里带着第一件的回答时才会挑中这一条：用户这句本身不匹配任何规则，才轮到看记录；排在前面，免得记录里第一件的原话先挑中第一件。
  { match: `"text":"${FIRST_ANSWER.slice(0, 4)}`, steps: [{ text: RECALLED }] },
  { match: FIRST, steps: [{ text: FIRST_ANSWER }] },
  { match: HOLD, steps: [{ text: "好的，我慢慢整理。", delayMs: 90_000 }] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
let panel = "";

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  const text = () => rp.evaluate(panel, `document.querySelector("#messages").textContent`) as Promise<string>;
  const say = async (line: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, line); await rp.pressEnter(panel); };

  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await say(FIRST);
  await until(async () => (await text()).includes(FIRST_ANSWER) || undefined, 60_000, "第一件的回答");
  await until(async () => await rp.evaluate(panel, ready), 60_000, "第一件结束");
  await sleep(2_000);

  await say(HOLD);
  await until(async () => model.requests.some(r => r.rule === HOLD && r.tools) || undefined, 30_000, "第二件开始并被拖住");
  await sleep(1_000);
  await say(ASK);
  await until(async () => model.requests.some(r => r.rule?.startsWith('"message"')) || undefined, 30_000, "判断这句是不是另一件事");
  await until(async () => /整理要点|好的。|青柠协议：/.test((await text()).split(ASK).slice(1).join(ASK)) || undefined, 60_000, "另开那件交回回答");
  await sleep(2_000);
  await rp.screenshot(panel, join(out, "panel.png"));

  const after = (await text()).split(ASK).slice(1).join(ASK);
  check("这句被判成另开一件", model.requests.some(r => r.rule?.startsWith('"message"')), { rules: model.requests.map(r => r.rule) });
  check("另开那件的回答用上了前一轮的回答", after.includes(RECALLED), { after: after.slice(0, 600) });
  check("没有让用户把文字发来", !/发来|发给我|贴给我|粘贴/.test(after), { after: after.slice(0, 600) });
} catch (error) {
  check("流程完成", false, String(error));
  await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks, requests: model.requests as unknown as Json }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
