/**
 * 回答里写成 ```mermaid 代码块的图，侧栏画成图；代码收在「Mermaid 代码」里，要复制还在。侧栏不认识的图种照旧显示代码。
 * 只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/mermaid-diagram.mts --headless
 *   a) flowchart（带分组）画成了图，图里有节点文字。
 *   b) 图下面有「Mermaid 代码」，展开是原来的代码。
 *   c) timeline（用户说「在mermaid中呈现」时真模型写出的那种）画成了图，图里有事件文字。
 *   d) sequenceDiagram 画成了图。
 *   e) zenuml（侧栏不认识）照旧是一段代码。
 *   f) 以 --- 配置头开头的 flowchart 画成了图。
 *   g) 带配置头的 zenuml 后面紧跟一张图：zenuml 仍是代码，后一张图（配置头后有空行、多行 %%{init}%%）画成了图。
 * 失败方式：renderAnswerHtml 不经 withMermaidDiagrams，a、b 失败；只认流程图时 c、d 失败；图种不跳过配置头时 f 失败；配置头匹配跨出代码块或不认多行指令时 g 失败。
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

时间线：

\`\`\`mermaid
timeline
    title 10月25日：历史上的今天
    1415 : 阿金库尔战役，英格兰击败法国
    1971 : 联合国大会通过第2758号决议
    2001 : Windows XP 正式发布
\`\`\`

时序：

\`\`\`mermaid
sequenceDiagram
  用户->>助手: 打开页面
\`\`\`

带配置头的流程图：

\`\`\`mermaid
---
title: 配置头
---
flowchart LR
  P1["配置头节点甲"] --> P2["配置头节点乙"]
\`\`\`

另一种图：

\`\`\`mermaid
---
title: 不认识
---
zenuml
  用户.打开页面()
\`\`\`

\`\`\`mermaid
---
title: 多行指令
---

%%{init: {
  "theme": "base"
}}%%
flowchart LR
  Q1["多行指令节点"] --> Q2["空行之后节点"]
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
  type Seen = { svgs: string[]; code: string | null; pres: string[] };
  const read = `(() => { const a = [...document.querySelectorAll(".msg.assistant")].at(-1); return { svgs: [...a.querySelectorAll(".gc-diagram svg")].map(s => s.textContent), code: a.querySelector(".gc-diagram-code")?.textContent ?? null, pres: [...a.querySelectorAll("pre code")].filter(c => !c.closest(".gc-diagram-code")).map(c => c.className + ":" + c.textContent.trim()) }; })()`;
  const seen = await until(async () => {
    const state = await rp.evaluate(panel, read) as Seen;
    return state.svgs.length >= 5 ? state : null;
  }, 15_000, "图画出来").catch(async () => await rp.evaluate(panel, read) as Seen);
  await rp.screenshot(panel, join(out, "answer.png"));
  await rp.evaluate(panel, `(() => { const figures = [...document.querySelectorAll(".msg.assistant .gc-diagram")]; figures.find(f => f.textContent.includes("阿金库尔") || f.querySelector("svg")?.textContent.includes("阿金库尔"))?.scrollIntoView({ block: "start" }); return true; })()`);
  await rp.screenshot(panel, join(out, "timeline.png"));
  const drawn = (text: string) => seen.svgs.some(svg => svg.includes(text));
  check("a flowchart 画成了图，图里有节点文字", drawn("迁都平安京") && drawn("苏联原子弹"), seen.svgs.map(s => s.slice(0, 60)));
  check("b 图下面收着原来的 Mermaid 代码", !!seen.code && seen.code.includes("Mermaid 代码") && seen.code.includes("flowchart TB"), seen.code?.slice(0, 120) ?? null);
  check("c timeline 画成了图，图里有事件文字", drawn("阿金库尔战役") && drawn("Windows XP"), seen.svgs.map(s => s.slice(0, 60)));
  check("d sequenceDiagram 画成了图", drawn("打开页面"), seen.svgs.map(s => s.slice(0, 60)));
  check("f 带 --- 配置头的 flowchart 画成了图", drawn("配置头节点甲") && drawn("配置头节点乙"), seen.svgs.map(s => s.slice(0, 60)));
  check("e zenuml 照旧是一段代码", seen.pres.some(p => p.includes("zenuml")) && seen.svgs.length === 5, { pres: seen.pres, svgs: seen.svgs.length });
  check("g 不认识的图带配置头不吞掉后一张图，多行指令、空行后的图画成了图", drawn("多行指令节点") && drawn("空行之后节点") && !seen.pres.some(p => p.includes("多行指令")), { svgs: seen.svgs.map(s => s.slice(0, 60)), pres: seen.pres });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
