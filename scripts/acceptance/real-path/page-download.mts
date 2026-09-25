/**
 * 页面下载（C3）的用户路径：只装扩展、agent 跑在扩展里，用户在真侧栏里请它下载页面提供的文件。
 *
 * --case=complete：「季度报表」完整下完；--case=broken：「项目归档」服务器发一部分后断开，Chrome 记为下载中断。
 * 练习页来自仓库夹具服务器（downloads.html）；这个 Chrome 配置目录的下载文件夹指到临时目录，不碰用户真实的下载文件夹。
 * 判定独立于产品：文件夹里实际落下的文件与字节、Chrome 下载记录（chrome.downloads.search），
 * 以及侧栏最后怎么说；回答措辞是否如实由人看截图判断，脚本只拦明显的「失败却说下好了」。
 *
 *   npx tsx scripts/acceptance/real-path/page-download.mts --headless --case=complete|broken [--model=provider/id]
 *
 * 验收文件：docs/evals/20260926-page-download.md
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DOWNLOAD_FIXTURES, startFixtureServer } from "../fixture-server.mjs";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const which = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7) ?? "complete";

if (which !== "complete" && which !== "broken") throw new Error("--case 只能是 complete 或 broken");

const INSTRUCTION = which === "complete" ? "帮我把这个页面上的季度报表下载下来" : "帮我把这个页面上的项目归档下载下来";

const TASK_LIMIT_MS = 4 * 60_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-page-download-${which}`);

await mkdir(artifacts, { recursive: true });

// 默认用日常主力模型；--model=provider/id 可换。
const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ?? "stepfun/step-3.7-flash";

const plan = await loadModelPlan(modelArg);

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    pill: q("#tab-title-text")?.textContent?.trim() ?? null,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: [...document.querySelectorAll(".msg.user")].map((el) => el.innerText.trim()),
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
    transcript: q("#messages")?.innerText ?? "",
  };
})()`;

type PanelState = { connected: boolean; ready: boolean; pill: string | null; busy: boolean; userMessages: string[]; replies: number; transcript: string };

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

type Evidence = { [key: string]: Json };

type Verdict = { status: "yes" | "no"; evidence: Evidence };

const verdicts: Record<string, Verdict> = {};

const verdict = (pass: boolean, evidence: Evidence): Verdict => ({ status: pass ? "yes" : "no", evidence });

const result: Evidence & { verdicts: Record<string, Verdict> } = { case: `page-download-${which}`, startedAt: startedAt.toISOString(), model: modelArg, instruction: INSTRUCTION, verdicts };

const fixture = await startFixtureServer();

const rp = await launchRealPath({ withoutNativeHost: true });

let panel: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, page);
  await rp.cdp.send("Page.navigate", { url: `${fixture.origin}/downloads.html` }, page);
  await until(async () => ((await rp.evaluate(page, `!!document.querySelector("#archive")`).catch(() => false)) ? true : undefined), 15_000, "练习页加载");

  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const panelSession = panel;
  // 与设置页写入的格式相同，background 会把它推给扩展内 agent。
  await rp.evaluate(panelSession, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await until(async () => {
    const state: PanelState = await rp.evaluate(panelSession, PANEL_STATE);

    return state.connected && state.ready && state.pill?.includes("资料下载") ? state : undefined;
  }, 60_000, "侧栏会话就绪并认出练习页", 500);

  const began = Date.now();
  await rp.click(panelSession, "#input");
  await rp.typeText(panelSession, INSTRUCTION);
  await rp.pressEnter(panelSession);
  // SAFETY: PANEL_STATE 是本文件写的页面脚本，返回 PanelState。
  await until(async () => ((await rp.evaluate(panelSession, PANEL_STATE)) as PanelState).userMessages.some((t) => t.includes(INSTRUCTION)), 15_000, "指令进入对话");
  let idle = 0;
  await until(async () => {
    const state: PanelState = await rp.evaluate(panelSession, PANEL_STATE);
    idle = !state.busy && state.replies > 0 ? idle + 1 : 0;

    return idle >= 6 ? true : undefined;
  }, TASK_LIMIT_MS, "任务结束", 500);
  result.taskSeconds = Math.round((Date.now() - began) / 1000);

  await rp.screenshot(page, join(artifacts, "page.png"));
  await rp.screenshot(panelSession, join(artifacts, "panel.png"));
  const final: PanelState = await rp.evaluate(panelSession, PANEL_STATE);
  await writeFile(join(artifacts, "panel-transcript.txt"), final.transcript);
  const reply = final.transcript.slice(final.transcript.lastIndexOf(INSTRUCTION) + INSTRUCTION.length).trim();
  result.reply = reply;

  // Chrome 自己的下载记录：从扩展 service worker 读，不经产品代码。
  const worker = await until(() => rp.serviceWorker(), 10_000, "扩展 service worker");
  const workerSession = await rp.attach(worker.targetId);
  // SAFETY: chrome.downloads.search 返回 DownloadItem[]；这里只取可序列化字段。
  const items = await rp.evaluate(workerSession, `chrome.downloads.search({}).then((all) => all.map((d) => ({ url: d.url, filename: d.filename, state: d.state, error: d.error ?? null, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, exists: d.exists })))`) as Array<{ url: string; filename: string; state: string; error: string | null; bytesReceived: number; totalBytes: number; exists: boolean }>;
  const files = await readdir(rp.dirs.downloads);
  result.chromeDownloads = items;
  result.downloadFolder = files;

  const target = which === "complete" ? DOWNLOAD_FIXTURES.complete : DOWNLOAD_FIXTURES.broken;
  const item = items.find((d) => d.url === `${fixture.origin}${target.path}`);
  verdicts.clickedTheRightFile = verdict(!!item && items.every((d) => d.url === item.url), { items });

  if (which === "complete") {
    const saved = files.includes(DOWNLOAD_FIXTURES.complete.filename)
      ? await readFile(join(rp.dirs.downloads, DOWNLOAD_FIXTURES.complete.filename), "utf8")
      : null;

    verdicts.chromeReportsComplete = verdict(item?.state === "complete", { item });
    verdicts.fileLandedWithExactContent = verdict(saved === DOWNLOAD_FIXTURES.complete.body, { files, saved });
    // 机器只拦明显说反的：说下载失败或没下完。
    verdicts.replyDoesNotClaimFailure = verdict(!/失败|没有下载|未能下载|中断/.test(reply), { reply: reply.slice(0, 600) });
  } else {
    const whole = files.includes(DOWNLOAD_FIXTURES.broken.filename);
    verdicts.chromeReportsInterrupted = verdict(item?.state === "interrupted" && !!item.error, { item });
    verdicts.noCompleteFileSaved = verdict(!whole, { files });
    verdicts.replySaysItFailed = verdict(/失败|中断|没有?(成功|下载完|下完|完成)|未(能|完成)/.test(reply), { reply: reply.slice(0, 600) });
  }
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);

  if (panel) {
    await rp.screenshot(panel, join(artifacts, "panel-failed.png")).catch(() => {});
    // SAFETY: PANEL_STATE 返回 PanelState；读失败时只用到 transcript 字段。
    await writeFile(join(artifacts, "panel-transcript.txt"), ((await rp.evaluate(panel, PANEL_STATE).catch(() => ({ transcript: "" }))) as PanelState).transcript).catch(() => {});
  }
} finally {
  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  const closed = await rp.close();
  verdicts.noLocalHost = verdict((closed?.hostPids ?? []).length === 0, closed ?? {});
  await fixture.close();
}

result.finishedAt = new Date().toISOString();

result.ok = !result.error && Object.values(verdicts).every((v) => v.status === "yes");

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

console.log(`\n结果：${result.ok ? "通过" : "未通过"}  用时：${String(result.taskSeconds ?? "-")} 秒  产物：${artifacts}`);

for (const [name, v] of Object.entries(verdicts)) console.log(`  ${v.status.padEnd(4)} ${name}  ${JSON.stringify(v.evidence).slice(0, 300)}`);

if (result.error) console.log(`  错误：${String(result.error).split("\n")[0]}`);

process.exit(result.ok ? 0 : 1);
