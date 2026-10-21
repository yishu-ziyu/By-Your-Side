/**
 * 回答里写成 ```mermaid 代码块的流程图，侧栏画成图；代码收在「Mermaid 代码」里，要复制还在。画不了的图种照旧显示代码。
 * 只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/mermaid-diagram.mts --headless
 *   a) flowchart（带分组）画成了图，图里有节点文字。
 *   b) 图下面有「Mermaid 代码」，展开是原来的代码。
 *   c) sequenceDiagram（侧栏画不了）照旧是一段代码。
 * 失败方式：renderAnswerHtml 不经 withMermaidDiagrams，a、b 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-mermaid-diagram`);

await mkdir(out, { recursive: true });

const ASK = "图测试：在mermaid中呈现";
const ANSWER = `按时间线串起来了：

\`\`\`mermaid
flowchart TB
  subgraph S1["古代"]
    A1["794年<br/>迁都平安京"]
  end
  subgraph S2["20世纪"]
    B1["1949年<br/>苏联原子弹"]
  end
  A1 --> B1
\`\`\`

另一种图：

\`\`\`mermaid
sequenceDiagram
  用户->>助手: 打开页面
\`\`\`
`;

const model = await startScriptedModel([{ match: ASK, steps: [{ text: ANSWER }] }]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("另一种图"))`) || undefined, 60_000, "回答出现");
  await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  const seen = await until(async () => {
    const state = await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll(".msg.assistant")].at(-1); const svg = a.querySelector(".gc-diagram svg"); return { svg: !!svg, nodes: svg ? svg.textContent : "", code: a.querySelector(".gc-diagram-code")?.textContent ?? null, pres: [...a.querySelectorAll("pre code")].map(c => c.className + ":" + c.textContent.trim().split("\\n")[0]) }; })()`) as { svg: boolean; nodes: string; code: string | null; pres: string[] };
    return state.svg ? state : null;
  }, 15_000, "图画出来").catch(async () => await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll(".msg.assistant")].at(-1); return { svg: false, nodes: "", code: a.querySelector(".gc-diagram-code")?.textContent ?? null, pres: [...a.querySelectorAll("pre code")].map(c => c.className + ":" + c.textContent.trim().split("\\n")[0]) }; })()`) as { svg: boolean; nodes: string; code: string | null; pres: string[] });
  await rp.screenshot(panel, join(out, "answer.png"));
  check("a flowchart 画成了图，图里有节点文字", seen.svg && seen.nodes.includes("迁都平安京") && seen.nodes.includes("苏联原子弹"), { svg: seen.svg, nodes: seen.nodes.slice(0, 120) });
  check("b 图下面收着原来的 Mermaid 代码", !!seen.code && seen.code.includes("Mermaid 代码") && seen.code.includes("flowchart TB"), seen.code?.slice(0, 120) ?? null);
  check("c sequenceDiagram 照旧是一段代码", seen.pres.some(p => p.includes("sequenceDiagram")), seen.pres);
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
