/**
 * 导出迁移对照实验的一次运行（docs/evals/20261008-export-transfer-ab.md）：新隔离 Chrome、新记忆、新网站，说一句任务原话，判分。
 *   npx tsx scripts/probes/export-transfer/run.mts --headless --task=T1|T2|T3 --arm=knowledge|action|control --out=<目录> [--model=provider/id]
 *   --seed=<原文>：用这条原文代替本组的种子（例如学习链路里产品真实提取出的规则），R4 照此核对。
 *   --scripted=right|wrong|deny|fakename|twice|overclaim：脚本模型走对路、错路，或做对后说没生成 / 编造文件名 / 导出两遍，或做错却说全部完成，只用来证明判分器能分对错（不花钱）。
 *   --scripted=navlink：先计时点一个普通跳转链接（页面加载完、没有下载），再走对路；用来检查下载回执没有拖慢普通点击，耗时记在 navMs。--no-seed：知识组故意不种知识，证明 R4 能抓到。
 *
 * 判分器可能假通过的方式与堵法：
 * - 只看 Agent 说「已导出」→ 只认隔离下载目录里的文件，和网站自己给出的导出记录。
 * - 文件行数对但编号错（重复或缺）→ 比编号集合，不比行数；还要求无重复。
 * - 导出了好几次，挑一个对的算 → 只判最后一个下载完的文件，导出次数照记。
 * - 网站 B 用页面脚本勾「全选」不触发事件 → 每次导出时网站同时记下表头勾没勾（head）。
 * - T3 文件对但范围是靠勾选凑的 → 网站 B 只有导出范围决定内容，另查最后一次导出的 mode=page。
 * - 知识组其实没带上知识 / 对照组混进了知识 → 逐条查这次任务发给模型的请求原文；不满足就作废（INVALID），不算 PASS 也不算 FAIL。
 * - 换了模型 → 请求原文里必须有本次模型名。
 */
import { cp, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { exportDiagnosticsViaSettings, launchRealPath, requireHeadless, sleep, until } from "../../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "../../acceptance/real-path/inproc-config.mts";
import { startScriptedModel, type Rule } from "../../acceptance/real-path/scripted-model.mts";
import { PAGE_SIZE, startSite } from "./site.mts";
import { SENTENCES } from "./sentences.mts";
import { SEEDS, captureModelBodies, judge, judgeReport, lastNewCsv, seedKnowledge, toolTrail, waitDone } from "./shared.mts";

requireHeadless();
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const task = arg("task") as "T1" | "T2" | "T3";
const arm = arg("arm") as keyof typeof SEEDS;
const out = arg("out")!;
const scripted = arg("scripted") as "right" | "wrong" | "deny" | "fakename" | "twice" | "overclaim" | "navlink" | undefined;
const noSeed = process.argv.includes("--no-seed");
const seedText = arg("seed");
if (!["T1", "T2", "T3"].includes(task) || !(arm in SEEDS) || !out) throw new Error("用法见文件头");

const sentence = SENTENCES[task];
await mkdir(out, { recursive: true });
const site = await startSite(task === "T1" ? "A" : "B");

/** 脚本模型的对路和错路：一个 browser_run 程序做完，再说一句完成。 */
const PROGRAMS: Record<string, string> = {
  "T1-right": `await browser.click({target:"#select-page"}); await browser.click({target:"#select-all-200"}); await browser.click({target:"#export"}); return "ok";`,
  "T1-wrong": `await browser.click({target:"#export"}); return "ok";`,
  "T2-right": `await browser.click({target:"#export"}); return "ok";`,
  "T2-wrong": `await browser.click({target:"#select-page"}); await browser.click({target:"#export"}); return "ok";`,
  "T3-right": `await browser.js({code:"const s=document.querySelector('#scope'); s.value='page'; s.dispatchEvent(new Event('change',{bubbles:true})); true"}); await browser.click({target:"#export"}); return "ok";`,
  "T3-wrong": `await browser.click({target:"#export"}); return "ok";`,
};
/** deny / fakename / twice 都先走对路：只错在回答或多导出。 */
const program = scripted === "twice" ? PROGRAMS[`${task}-right`]!.replace('return "ok";', 'await browser.sleep({ms:1500}); await browser.js({code:"document.querySelector(\'#export\').click(); true"}); await browser.sleep({ms:1500}); return "ok";') : PROGRAMS[`${task}-${scripted === "wrong" || scripted === "overclaim" ? "wrong" : "right"}`];
const NAV = `await browser.js({code:"const a=document.createElement('a'); a.id='nav'; a.href='/?nav=1'; a.textContent='刷新列表'; document.body.prepend(a); true"}); const t0 = Date.now(); await browser.click({target:"#nav"}); const ms = Date.now() - t0; await browser.waitFor({selector:"#export",timeoutMs:5000});`;
const navProgram = scripted === "navlink" ? `${NAV} ${PROGRAMS[`${task}-right`]!.replace('return "ok";', "return { navMs: ms };")}` : null;
const closing = { deny: "目前文件尚未生成。", fakename: "已保存为 客户列表.csv。", overclaim: "已成功导出全部 200 条客户数据。" }[scripted as string] ?? "已导出。";
const scriptedModel = scripted ? await startScriptedModel([{ match: sentence, steps: [{ tool: { name: "browser_run", args: { code: navProgram ?? program!, label: "导出" } } }, { text: closing }] } satisfies Rule]) : null;
const plan = scriptedModel
  ? { providerId: "custom", modelId: "demo-model", credential: { type: "api_key" as const, key: "local-demo-no-secret" } }
  : await loadModelPlan(arg("model") ?? DEFAULT_TEST_MODEL);

const rp = await launchRealPath();
const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;
const result: Record<string, unknown> = { task, arm, scripted: scripted ?? null, noSeed, model: `${plan.providerId}/${plan.modelId}`, sentence };
let panel = "";
/** 出错时知道停在哪一步。 */
const step = (name: string) => { result.step = name; };

try {
  // 侧栏跟着标签页走：先在初始标签页打开网站，再在这里开侧栏（同 memory-used-line.mts）。
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: site.url }, work);
  await until(async () => (await rp.evaluate(work, `document.querySelectorAll("#rows tr").length === ${PAGE_SIZE}`).catch(() => false)) || undefined, 15_000, "网站打开");
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  if (scriptedModel) await rp.cdp.send("Target.closeTarget", { targetId: (await configureViaSettings(rp, panel, plan, { baseUrl: scriptedModel.baseUrl })).settingsTargetId });
  else if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  step("配置模型后");
  await sleep(3000);
  const bodies = await captureModelBodies(rp);
  await seedKnowledge(rp, noSeed ? null : seedText ?? SEEDS[arm]);

  step("种知识后");
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  step("网站打开后");
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "新对话");
  step("新对话后");

  const started = Date.now();
  await rp.click(panel, "#input");
  await rp.typeText(panel, sentence);
  await rp.pressEnter(panel);
  await sleep(1500);
  result.lastTitle = await waitDone(rp, panel, "做完");
  result.seconds = Math.round((Date.now() - started) / 1000) - 15;

  const got = await lastNewCsv(rp.dirs.downloads, new Set());
  const ids = got?.ids ?? [];
  const exports = site.events.filter((e) => e.type === "export");
  const verdicts: Record<string, string> = judge(task, ids, site.events);
  const reply = String(await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].at(-1)?.innerText ?? ""`));
  Object.assign(verdicts, judgeReport(task, ids, await readdir(rp.dirs.downloads), reply, site.events));

  // R4：这次任务发给模型的请求原文。
  // 只看主任务请求（带 browser_run 工具表）：后台判断（目标核对等）不带记忆，也可能不是同一模型。
  const mine = (await bodies.texts()).filter((b) => b.includes(sentence) && b.includes('"browser_run"'));
  // 本组那一条每次都在；别组那一条一次都不在。
  const seeded = seedText ?? SEEDS[arm];
  const withSeed = seeded ? mine.filter((b) => b.includes(seeded)).length : 0;
  const foreign = Object.values(SEEDS).filter((t): t is string => !!t && t !== seeded).some((t) => mine.some((b) => b.includes(t)));
  const sameModel = mine.length > 0 && mine.every((b) => b.includes(`"${plan.modelId}"`));
  // 第一条主任务请求必须带本组那一条；宿主续做时的请求可能另组上下文，只记条数不判。
  const seedOk = !foreign && (seeded ? !!mine[0]?.includes(seeded) : true);
  verdicts.R4 = mine.length > 0 && sameModel && seedOk ? "VALID" : "INVALID";

  Object.assign(result, {
    verdicts,
    file: got?.file ?? null, rows: ids.length, unique: new Set(ids).size, downloads: got?.newFiles ?? 0,
    exports: exports.map((e) => `${e.mode}:${e.count}${e.head ? "(全选已勾)" : ""}`),
    events: site.events.filter((e) => e.type !== "export").map((e) => `${e.type}${e.checked !== undefined ? `=${e.checked}` : ""}${e.value ? `=${e.value}` : ""}${e.page && e.type === "page" ? `=${e.page}` : ""}`),
    modelRequests: mine.length, requestsWithSeed: withSeed, foreignSeed: foreign, sameModel,
    efforts: [...new Set(mine.flatMap((b) => [...b.matchAll(/"effort"\s*:\s*"(\w+)"/g)].map((m) => m[1]!)))],
    reply,
  });
  await rp.screenshot(panel, join(out, "panel.png")).catch(() => undefined);
  await rp.screenshot(work, join(out, "page.png")).catch(() => undefined);
  // 操作记录：设置页导出的诊断记录，逐条留工具名与结果开头（下载回执在这里）。
  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(out, "diagnostics"));
  await writeFile(join(out, "traces.jsonl"), traces);
  result.tools = toolTrail(traces);
  result.navMs = Number(/"navMs":(\d+)/.exec(traces)?.[1] ?? NaN) || null;
} catch (caught) {
  result.error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) result.panelText = await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.slice(-1500)`).catch(() => null);
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ ...result, siteEvents: site.events }, null, 2));
  // 交付证据：下载目录随隔离环境删除，先整份拷出来。
  await cp(rp.dirs.downloads, join(out, "downloads"), { recursive: true }).catch(() => undefined);
  await rp.close(); await rp.remove();
  site.server.closeAllConnections(); site.server.close();
  await scriptedModel?.close();
}

console.log(JSON.stringify({ task, arm, scripted: scripted ?? null, verdicts: result.verdicts ?? null, rows: result.rows ?? null, exports: result.exports ?? null, error: String(result.error ?? "").split("\n")[0] || null }));
