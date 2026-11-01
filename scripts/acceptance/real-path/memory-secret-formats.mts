import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-memory-secret-formats`);
await mkdir(out, { recursive: true });
const examples = [
  { id: "normal", ask: "请记住我坐飞机喜欢靠窗。", evidence: "坐飞机喜欢靠窗", text: "坐飞机喜欢靠窗" },
  { id: "card", ask: "请记住我的号码是 4111 1111 1111 1111。", evidence: "4111 1111 1111 1111", text: "号码：4111 1111 1111 1111" },
  { id: "id", ask: "请记住我的号码是 11010519491231002X。", evidence: "11010519491231002X", text: "号码：11010519491231002X" },
];
const model = await startScriptedModel(examples.flatMap(({ id, ask, evidence, text }) => [
  { match: `"userMessage":"${ask}`, steps: [{ text: JSON.stringify({ action: "save", text, evidence, scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: true, dateIsTheTask: false } }) }] },
  { match: ask, steps: [{ text: `${id} 已处理。` }] },
]));
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: unknown }> = [];
const check = (name: string, pass: boolean, actual: unknown) => { checks.push({ name, pass, actual }); console.log(pass ? "PASS" : "FAIL", name, JSON.stringify(actual)); };
const readMemories = `new Promise(resolve => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => resolve(null); r.onsuccess = () => {
  const db = r.result; if (!db.objectStoreNames.contains("kv")) { db.close(); resolve(null); return; }
  const q = db.transaction("kv").objectStore("kv").get("memories"); q.onsuccess = () => { db.close(); resolve(q.result ?? null); }; q.onerror = () => { db.close(); resolve(null); };
}; })`;
try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const memories = async () => {
    const raw = await rp.evaluate(panel, readMemories) as string | null;
    return raw ? (JSON.parse(raw).entries ?? []).filter((e: { status?: string }) => e.status === "active").map((e: { text: string }) => e.text) as string[] : [];
  };
  for (const { id, ask, evidence, text } of examples) {
    await rp.click(panel, "#input"); await rp.typeText(panel, ask); await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(`${id} 已处理。`)}))`), 60_000, `${id} 收到回答`);
    await until(async () => await rp.evaluate(panel, ready), 60_000, `${id} 结束`);
    if (id === "normal") await until(async () => (await memories()).includes(text), 30_000, "正常偏好已记住");
    else await sleep(3500);
    const list = await memories();
    const stored = list.some(entry => entry.includes(evidence));
    const decisionRequested = model.requests.some(r => r.rule === `"userMessage":"${ask}`);
    check(id === "normal" ? "正常偏好可以记住" : `${id} 格式号码不进记忆`, id === "normal" ? stored : !stored, { stored, decisionRequested, activeCount: list.length });
  }
} catch (error) { check("流程完成", false, String(error)); }
finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}
console.log("证据：", out);
if (checks.length !== examples.length || checks.some(c => !c.pass)) process.exitCode = 1;
