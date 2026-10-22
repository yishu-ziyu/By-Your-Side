/**
 * 回答里不露标签页编号：模型把工具结果里的「tab 29979739」「新标签页 29979731」抄进正文和卡片出处时，用户看到的文字里没有这些数。
 * 只装扩展、隔离构建、本机脚本模型。
 *   npx tsx scripts/acceptance/real-path/tab-id-hidden.mts --headless
 *   a) 正文、卡片出处、表格格子里都看不到标签页编号（包括正开着的那一页的真实编号）。
 *   b) 卡片上「切到…看」按钮仍带着那一页的编号，点了真的切过去。
 *   c) 普通的大数（播放量 1234567）照常显示。
 * 失败方式：去掉 renderMarkdown 外面的 hideTabIdsInHtml，a 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-tab-id-hidden`);

await mkdir(out, { recursive: true });

const ASK = "编号测试：把结果给我";
let workTab = 0;

const answer = () => `已在新标签页 ${workTab} 打开（tab 29979731），视频共 1234567 次播放。页面在新标签页 ${workTab} 里（编号 ${workTab}）。
<card title="打开的标签页">
<table cols="编号|网址"><tr cells="${workTab}|https://example.com/" /></table>
<button action="tab" target="${workTab}">切到练习页看</button>
<source>维基百科「10月22日」条目 · tab 29979739</source>
</card>`;

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = (await rp.targets()).find(t => t.url === "about:blank")!;
  const panel = await rp.attach(await rp.openSidePanel());
  workTab = await rp.evaluate(panel, `chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === "about:blank")?.id ?? 0)`) as number;
  // 脚本模型的回复要带上这一页的真实编号：拿到编号后再起模型。
  const live = await startScriptedModel([{ match: ASK, steps: [{ text: answer() }] }]);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: live.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector(".msg.assistant .gen-card .gc-foot")`) || undefined, 60_000, "回答和卡片出现");
  await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  const seen = await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll(".msg.assistant")].at(-1); return { text: a.innerText, foot: a.querySelector(".gc-foot")?.innerText ?? "", button: a.querySelector("[data-card-tab]")?.getAttribute("data-card-tab") ?? null }; })()`) as { text: string; foot: string; button: string | null };
  await rp.screenshot(panel, join(out, "answer.png"));
  const leaked = ["29979731", "29979739", String(workTab)].filter(n => seen.text.includes(n));
  check("a 正文、卡片出处和表格里都看不到标签页编号", leaked.length === 0 && seen.foot.includes("维基百科"), { leaked, foot: seen.foot });
  check("c 普通的大数照常显示", seen.text.includes("1234567"), null);
  const husks = seen.text.match(/[（(]\s*(?:tab|标签页|标签)?\s*[)）]/gi) ?? [];
  check("d 去掉编号后不留「（tab）」「（）」这样的空括号", husks.length === 0, { husks });
  check("e 去掉编号后不留空格和「（编号 ）」", seen.text.includes("页面在新标签页里") && !/（编号\s*）/.test(seen.text), { text: seen.text.slice(0, 160) });
  check("b 「切到…看」按钮仍带着那一页的编号", seen.button === String(workTab), { button: seen.button, workTab });
  await rp.evaluate(panel, `chrome.tabs.create({ url: "about:blank#other", active: true }).then(() => true)`);
  await rp.click(panel, ".msg.assistant [data-card-tab]");
  const active = await until(async () => { const id = await rp.evaluate(panel, `chrome.tabs.query({ active: true, currentWindow: true }).then(t => t[0]?.id ?? 0)`) as number; return id === workTab ? id : null; }, 10_000, "切到那一页");
  check("b 点按钮真的切到那一页", active === workTab, { active, workTab, work: work.targetId });
  await live.close();
} catch (error) {
  check("流程完成", false, String(error));
  const panelTarget = (await rp.targets()).find(t => t.url.includes("sidepanel.html"));
  if (panelTarget) { const s = await rp.attach(panelTarget.targetId); await rp.screenshot(s, join(out, "failure.png")).catch(() => {}); await writeFile(join(out, "failure.html"), String(await rp.evaluate(s, `document.querySelector("#messages")?.innerHTML ?? ""`).catch(e => String(e)))); }
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
