/**
 * 模型把 <diagram> 和它的 <cite> 直接写在正文里、没包进 <card> 时，侧栏照样画成结构图、点方块看原文，不把图的代码和原文当正文堆出来。
 * 回答原文取自一次真模型回放（用户说「在mermaid中呈现」），逐段流式输出。只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/diagram-outside-card.mts --headless
 *   a) 结构图画成了图，图里有节点文字。
 *   b) 图下有「点方块看原文」，原文不显示在正文里。
 *   c) 正文里没有 flowchart 代码。
 * 失败方式：splitAnswer 只认卡片里的 <diagram>，a、b、c 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-diagram-outside-card`);

await mkdir(out, { recursive: true });

const ASK = "图测试：卡片外的结构图";
const ANSWER = "10月25日的历史事件，按年代串起来是这样：\n\n<diagram>\nflowchart TB\n  A[\"1415<br/>阿金库尔战役\"]\n  B[\"1915<br/>孙中山与宋庆龄结婚\"]\n  C[\"1938<br/>武汉会战结束\"]\n  D[\"1945<br/>台湾举行受降典礼\"]\n  E[\"1950<br/>志愿军入朝作战\"]\n  F[\"1971<br/>联合国大会通过2758号决议\"]\n  A --> B --> C --> D --> E --> F\n</diagram>\n<cite node=\"A\" from=\"大事记·19世纪以前\">英格兰国王亨利五世率领的步兵和弓兵部队在阿金库尔战役中打败法国骑兵部队。</cite>\n<cite node=\"B\" from=\"大事记·20世纪\">孙中山和宋庆龄在日本东京登记结婚。</cite>\n<cite node=\"C\" from=\"大事记·20世纪\">武汉沦陷，武汉会战因此结束。</cite>\n<cite node=\"D\" from=\"大事记·20世纪\">在台日军依照盟军最高统帅麦克阿瑟发布的《一般命令第一号》向同盟国授权的代表蒋介石委派的代表何应钦委派的受降代表陈仪投降，是以于台北公会堂举行台湾地区的受降典礼。</cite>\n<cite node=\"E\" from=\"大事记·20世纪\">中国人民志愿军出国作战参加朝鲜战争，并同朝鲜人民军于同日发动抗美援朝第一次战役。</cite>\n<cite node=\"F\" from=\"大事记·20世纪\">联合国大会通过联合国大会2758号决议，由中华人民共和国取代中华民国的中国席次。</cite>\n\n来源：[维基百科「10月25日」](https://zh.wikipedia.org/wiki/10%E6%9C%8825%E6%97%A5)";

const model = await startScriptedModel([{ match: ASK, steps: [{ text: ANSWER, chunkDelayMs: 15 }] }]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.evaluate(panel, `(() => { window.__diagramFrames = []; const watch = () => { window.__diagramFrames.push(document.querySelectorAll('.msg.assistant .gc-diagram svg').length); requestAnimationFrame(watch); }; requestAnimationFrame(watch); return true; })()`);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("维基百科"))`) || undefined, 60_000, "回答出现");
  await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  type Seen = { svg: string; hint: boolean; text: string };
  const read = `(() => { const a = [...document.querySelectorAll(".msg.assistant")].at(-1); return { svg: a.querySelector(".gc-diagram svg")?.textContent ?? "", hint: !!a.querySelector(".gc-diagram-hint"), text: a.innerText }; })()`;
  const seen = await until(async () => { const s = await rp.evaluate(panel, read) as Seen; return s.svg ? s : null; }, 15_000, "图画出来").catch(async () => await rp.evaluate(panel, read) as Seen);
  await rp.screenshot(panel, join(out, "answer.png"));
  check("a 结构图画成了图，图里有节点文字", seen.svg.includes("阿金库尔战役") && seen.svg.includes("联合国大会通过2758号决议"), seen.svg.slice(0, 120));
  check("b 图下有「点方块看原文」，原文不在正文里", seen.hint && !seen.text.includes("亨利五世"), { hint: seen.hint, text: seen.text.slice(0, 200) });
  check("c 正文里没有 flowchart 代码", !/flowchart|-->/.test(seen.text), seen.text.slice(0, 200));
  const frames = await rp.evaluate(panel, "window.__diagramFrames") as number[];
  const first = frames.findIndex(n => n > 0);
  check("d 图画出后不会在引用输出期间消失", first >= 0 && frames.slice(first).every(n => n > 0), { first, frames: frames.length });
  await rp.evaluate(panel, `document.querySelector('.msg.assistant .gc-diagram svg [data-id="A"]')?.scrollIntoView({ block: 'center', behavior: 'instant' }), true`);
  await rp.click(panel, '.msg.assistant .gc-diagram svg [data-id="A"] rect');
  const quote = await until(async () => await rp.evaluate(panel, `document.querySelector('.gc-quote:not([hidden])')?.textContent ?? ''`) as string || null, 3000, "点方块显示原文");
  check("e 点方块能看到对应原文", quote.includes("亨利五世"), quote);
  await rp.evaluate(panel, `document.querySelector('.gc-quote:not([hidden])')?.scrollIntoView({ block: 'center', behavior: 'instant' }), true`);
  await rp.screenshot(panel, join(out, "quote.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
