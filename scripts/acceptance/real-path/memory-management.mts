/**
 * 记忆入口有名字、抽屉能搜（docs/evals/20261006-memory-management.md R1、R5）。
 * 只装扩展、隔离构建、本机脚本模型；记忆和过往任务直接写进扩展自己的 IndexedDB（库名、键与 memory-used-line.mts 相同）。
 *   npx tsx scripts/acceptance/real-path/memory-management.mts --headless
 * 失败方式：顶栏只有图标没有字；抽屉没有搜索框；搜索后组头还写过滤前的条数；没有匹配的组还占着位置；什么都搜不到时一片空白。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-memory-management`);

await mkdir(artifacts, { recursive: true });

const NOW = Date.now();

const memory = (id: string, text: string, kind: "profile" | "method") => ({ id, factId: id, version: 1, text, scope: { kind: "all" }, sourceConversationId: "seed", createdAt: NOW - 60_000, updatedAt: NOW - 60_000, kind, status: "active", sourceQuote: text, useCount: 0, formatVersion: 3 });

const MEMORIES = [
  memory("m-email", "我的邮箱是 lei@example.com", "profile"),
  memory("m-lang", "回答一律用中文", "profile"),
  memory("m-race", "10 月 20 日要跑杭州马拉松", "profile"),
  memory("m-form", "填表前先截图给我核对", "method"),
];

const TASKS = [
  { id: "t-hotel", conversationId: "seed", goal: "订马拉松前一晚的酒店", revisions: [], hosts: ["hotel.example"], outcome: "complete", summary: "订好了马拉松起点附近的酒店", unfinished: [], startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000 },
  { id: "t-shoes", conversationId: "seed", goal: "比较三双跑鞋的价格", revisions: [], hosts: ["shop.example"], outcome: "complete", summary: "列出了三双跑鞋的价格", unfinished: [], startedAt: NOW - 7_200_000, endedAt: NOW - 7_000_000 },
];

const model = await startScriptedModel([]);

const rp = await launchRealPath();

let error: string | null = null;

/** 写进 result.json 的证据。 */
interface Evidence { stage?: string; entryText?: string; search?: unknown; nothing?: unknown; cleared?: unknown }

const evidence: Evidence = {};

let panel = "";

const idbOpen = `async () => {
  const exists = (await indexedDB.databases()).some((d) => d.name === "sideagent-memory");
  return await new Promise((res, rej) => {
    const r = exists ? indexedDB.open("sideagent-memory") : indexedDB.open("sideagent-memory", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("kv")) r.result.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}`;

try {
  // 先写好记忆和过往任务，再配模型：助手核心启动时读到的就是这份。
  const ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "扩展页");

  for (const [key, value] of [["memories", { format: 3, rev: 1, entries: MEMORIES }], ["tasks", { format: 1, tasks: TASKS }]] as const) {
    await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(${JSON.stringify(`${JSON.stringify(value)}\n`)}, ${JSON.stringify(key)});
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); db.close(); return true; })()`);
  }

  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  // R1：顶栏入口写着「记忆」，不只是一个图标。
  evidence.stage = "R1";
  evidence.entryText = String(await rp.evaluate(panel, 'document.querySelector("#memory-open")?.innerText.trim() ?? ""'));
  assert.equal(evidence.entryText, "记忆", "the top bar entry is labeled 记忆");
  await rp.screenshot(panel, join(artifacts, "R1-topbar.png"));

  // R5：抽屉能搜，组头计数跟着搜索结果走，空组隐藏，搜不到时说清楚。
  evidence.stage = "R5";
  await rp.click(panel, "#memory-open");
  await until(async () => await rp.evaluate(panel, 'document.querySelectorAll("#memory-body .memory-row:not(.past-task)").length === 4 && document.querySelectorAll("#memory-body .past-task").length === 2') || undefined, 20_000, "drawer lists the seeded memories and tasks");
  await sleep(400);

  // SAFETY: 页面里这段脚本返回的字段与下面的类型一一对应。
  const view = () => rp.evaluate(panel, `(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const rows = [...document.querySelectorAll("#memory-body .memory-row")].filter(shown);
    return {
      title: document.querySelector("#memory-title")?.textContent ?? "",
      memories: rows.filter((r) => !r.classList.contains("past-task")).map((r) => r.querySelector(".memory-row-text")?.textContent ?? ""),
      tasks: rows.filter((r) => r.classList.contains("past-task")).map((r) => r.querySelector(".memory-row-text")?.textContent ?? ""),
      methodGroup: shown(document.querySelector('#memory-body [data-memory-group="method"]')),
      tasksHead: document.querySelector("#memory-body .past-tasks-head h3")?.textContent ?? "",
      tasksShown: shown(document.querySelector("#memory-body .past-tasks")),
      nothing: [...document.querySelectorAll("#memory-body .memory-search-empty")].filter(shown).map((el) => el.textContent),
    };
  })()`) as Promise<{ title: string; memories: string[]; tasks: string[]; methodGroup: boolean; tasksHead: string; tasksShown: boolean; nothing: string[] }>;

  const search = async (query: string) => {
    await rp.evaluate(panel, `(() => { const input = document.querySelector("#memory-search"); input.focus(); input.select(); return true; })()`);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, panel);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, panel);

    if (query) await rp.typeText(panel, query);
    await sleep(300);

    return view();
  };

  const found = await search("马拉松");
  evidence.search = found;
  await rp.screenshot(panel, join(artifacts, "R5-search.png"));
  assert.deepEqual(found.memories, ["10 月 20 日要跑杭州马拉松"], "only the matching memory stays");
  assert.deepEqual(found.tasks, ["订马拉松前一晚的酒店"], "only the matching past task stays");
  assert.equal(found.methodGroup, false, "a group with no match is hidden");
  assert.match(found.title, /找到 2 条/, "the title counts the matches, not the total");
  assert.match(found.tasksHead, /过往任务 · 1/, "the past-tasks heading counts the matches");
  assert.equal(await rp.evaluate(panel, 'document.activeElement?.id'), "memory-search", "typing keeps focus in the search box");

  const nothing = await search("不存在的词");
  evidence.nothing = nothing;
  assert.equal(nothing.memories.length + nothing.tasks.length, 0, "nothing matches");
  assert.equal(nothing.nothing.length, 1, "says that nothing was found");
  assert.equal(nothing.tasksShown, false, "the empty past-tasks section is hidden while searching");

  const cleared = await search("");
  evidence.cleared = cleared;
  assert.equal(cleared.memories.length, 4, "clearing the search brings every memory back");
  assert.equal(cleared.tasks.length, 2, "clearing the search brings every task back");
  assert.equal(cleared.methodGroup, true, "the method group is back");
  assert.match(cleared.title, /记忆 · 4/, "the title shows the total again");
  evidence.stage = "done";
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => undefined);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
