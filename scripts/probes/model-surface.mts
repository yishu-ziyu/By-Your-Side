// 读数（不是验收）：真实扩展第一条主任务请求里发给模型的工具数、工具定义总字符数、系统提示词字符数。
// 只装扩展、脚本模型记下请求原样；用法：npx tsx scripts/probes/model-surface.mts --headless [输出 json 路径]。
import { writeFileSync } from "node:fs";
import { launchRealPath, requireHeadless, until } from "../acceptance/real-path/harness.mts";
import { configureViaSettings } from "../acceptance/real-path/inproc-config.mts";
import { startScriptedModel } from "../acceptance/real-path/scripted-model.mts";

requireHeadless();

type Payload = { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> };

const requests: Payload[] = [];

const model = await startScriptedModel([{ match: "工具面读数", steps: [{ text: "读数完成。" }] }], undefined, p => requests.push(p));

const rp = await launchRealPath();

let ok = false;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled===false`)) || undefined, 20000, "侧栏就绪");
  await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "k" } }, { baseUrl: model.baseUrl });
  await rp.click(panel, "#input"); await rp.typeText(panel, "工具面读数：说一句话"); await rp.pressEnter(panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector('#messages')?.innerText.includes('读数完成')`)) || undefined, 60000, "回答");
  const main = requests.find(r => r.tools?.length)!;
  const system = main.messages?.find(m => m.role === "system")?.content;
  const systemText = Array.isArray(system) ? JSON.stringify(system) : String(system ?? "");
  const names = main.tools!.map(t => t.function?.name ?? "?").sort();
  const result = { toolCount: names.length, toolSchemaChars: JSON.stringify(main.tools).length, systemPromptChars: systemText.length, names };
  console.log(JSON.stringify(result));

  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ ...result, systemPrompt: systemText }, null, 2));
  ok = true;
} catch (e) { console.error(e); } finally { await rp.close(); await rp.remove(); await model.close(); }

process.exitCode = ok ? 0 : 1;
