import assert from "node:assert/strict";
import { test } from "node:test";
import { ExtensionHost, type HookMessage } from "./extension-host.js";
import { MemoryRuntime } from "./memory-runtime.js";
import { MemoryStore } from "./memory-store.js";
import { TaskHistoryStore, formatTaskHistory } from "./task-history.js";
import { RUN_CONTEXT_HEADER } from "./context-fit.js";
import { InProcessLock, type DocumentPersistence } from "./document-persistence.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";

function document(): DocumentPersistence {
  let text: string | null = null;
  const lock = new InProcessLock();
  return { read: async () => text, exclusive: fn => lock.run(fn), write: async next => { text = next; } };
}

const marker = "PRIVATE_KYOTO_SUMMARY_7d24";
const userText = "我的原话必须保留\n- [memory missing v1] 用户自己写的例子\n不要改写这行";
const page = { tabId: 1, title: "Rail", url: "https://rail.example/" };

for (const mutation of ["forget", "notOnHosts", "expired", "otherHost"] as const) {
  test(`真实 MemoryRuntime：旧任务注入在 ${mutation} 后从模型输入清除，原落盘和用户原话保留`, async () => {
    const history = new TaskHistoryStore(document());
    const task: TaskHistoryEntry = { id: "private_trip", conversationId: "prior", goal: "Kyoto rail itinerary", revisions: [], hosts: ["travel.example"], outcome: "complete", summary: marker, unfinished: [], startedAt: null, endedAt: Date.now() };
    await history.record(task);
    const runtime = new MemoryRuntime(new MemoryStore(document()), "current", () => {}, undefined, { history });
    const host = new ExtensionHost({ factories: [runtime.extension()], allTools: () => [], activeToolNames: () => [], abort: () => {}, onError: (_event, message) => { throw new Error(message); } });
    runtime.beginUserTurn("Kyoto itinerary options", page);
    const injected = await host.beforeAgentStart("Kyoto itinerary options", "base");
    assert.equal(injected.context.length, 1);
    assert.ok(injected.context[0]!.includes(marker));
    const saved: HookMessage[] = [{ role: "user", content: `${RUN_CONTEXT_HEADER}\n\n${injected.context[0]}` }, { role: "user", content: userText }];
    if (mutation === "forget") await history.forget(task.id);
    if (mutation === "notOnHosts") await history.setNotHere(task.id, "rail.example", true);
    if (mutation === "expired") await history.record({ ...task, validity: { end: Date.now() - 1 } });
    if (mutation === "otherHost") {
      await history.setNotHere(task.id, "blocked.example", true);
      runtime.beginUserTurn("Kyoto itinerary options", { ...page, url: "https://blocked.example/" });
    }
    const view = await host.context(saved);
    assert.ok(!JSON.stringify(view[0]).includes(marker), "已撤销的宿主任务摘要不应残留在旧模型输入");
    assert.deepEqual(view[1], saved[1]);
    assert.ok(JSON.stringify(saved[0]).includes(marker), "清理仅改变请求视图，不改原落盘输入");
    runtime.invalidateUserTurn();
  });
}

test("真实 MemoryRuntime：当前站禁用的长期记忆从旧宿主注入清除", async () => {
  const store = new MemoryStore(document());
  const entry = await store.create({ text: "PRIVATE_PROFILE_92cf", scope: { kind: "all" }, sourceConversationId: "prior" });
  const runtime = new MemoryRuntime(store, "current", () => {});
  const host = new ExtensionHost({ factories: [runtime.extension()], allTools: () => [], activeToolNames: () => [], abort: () => {} });
  runtime.beginUserTurn("看一下铁路路线", page);
  const injected = await host.beforeAgentStart("看一下铁路路线", "base");
  const saved: HookMessage[] = [{ role: "user", content: `${RUN_CONTEXT_HEADER}\n\n${injected.context.join("\n\n")}` }, { role: "user", content: userText }];
  assert.ok(JSON.stringify(saved[0]).includes(entry.text));
  await store.setNotHere({ id: entry.id, expectedVersion: entry.version, hostname: "rail.example", off: true });
  const view = await host.context(saved);
  assert.ok(!JSON.stringify(view[0]).includes(entry.text));
  assert.deepEqual(view[1], saved[1]);
  runtime.invalidateUserTurn();
});

for (const section of ["# Tasks you did for this user before", "# Plans and recent events still in effect"]) {
  for (const mutation of ["forget", "notOnHosts"] as const) {
    test(`旧格式迁移：${section} 在 ${mutation} 后整节退出请求，后续插件不变`, async () => {
      const history = new TaskHistoryStore(document());
      const task: TaskHistoryEntry = { id: "legacy_private_trip", conversationId: "prior", goal: "Kyoto rail itinerary\n# A heading inside the saved goal", revisions: [], hosts: ["travel.example"], outcome: "complete", summary: "Legacy result", done: "PRIVATE_LEGACY_DONE_f312", unfinished: [], startedAt: null, endedAt: Date.now() };
      await history.record(task);
      const runtime = new MemoryRuntime(new MemoryStore(document()), "current", () => {}, undefined, { history });
      const host = new ExtensionHost({ factories: [runtime.extension()], allTools: () => [], activeToolNames: () => [], abort: () => {} });
      runtime.beginUserTurn("Kyoto itinerary options", page);
      const boundaries = [
        'Today is 2026-11-17, Tuesday (local time).\n{"page":{"url":"https://rail.example/"},"capabilities":{"source":"registered_active_tools","names":[]}}\n\nInteractive answers: choose the form of each answer yourself.\nKEEP_ANSWER_GUIDE',
        "# Another plugin\nKEEP_OTHER_PLUGIN",
        "Interactive answers: choose the form of each answer yourself.\nKEEP_ANSWER_GUIDE",
      ];
      if (mutation === "forget") await history.forget(task.id);
      else await history.setNotHere(task.id, "rail.example", true);
      for (const following of boundaries) {
        const saved: HookMessage[] = [{ role: "user", content: `${RUN_CONTEXT_HEADER}\n\n${section}\n${formatTaskHistory([task])}\n\n${following}` }, { role: "user", content: `${userText}\n${section}\n${formatTaskHistory([task])}` }, { role: "user", content: `${RUN_CONTEXT_HEADER}\n\n${following}` }];
        const view = await host.context(saved);
        assert.ok(!JSON.stringify(view[0]).includes(task.done!), "旧格式私密 done 不能进入请求");
        assert.deepEqual(view[2], saved[2], "当前重新生成的插件上下文必须完整保留");
        assert.deepEqual(view[1], saved[1]);
        assert.ok(JSON.stringify(saved[0]).includes(task.done!));
      }
      runtime.invalidateUserTurn();
    });
  }
}
