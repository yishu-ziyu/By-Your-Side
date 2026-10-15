/**
 * 输入框左下角「模型 · 快/深入」一个菜单（docs/evals/20261015-model-menu.md）：看得到、点得开、选了真的换档、换模型两步到位、关掉侧栏再开还记得。真实模型，只装扩展，无头，全程录侧栏。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/model-menu.mts --headless [--model=provider/id]
 * 失败方式：开关不出现或没写模型名；菜单里没有模型列表和思考开关；切思考时菜单关了；「更多模型」没在同一个菜单里打开、搜不到；Esc 不是先返回再关上；选别的模型后开关没换名字；选「深入」后助手仍用低档；选「快」后仍用高档；重开侧栏后忘了选过什么。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-model-menu`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>团队周报</title><h1>团队周报</h1><p>本周完成 12 项，延期 2 项。负责人：李雷。</p>`);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();

const evidence: JsonRecord = { model: modelArg };

let error: string | null = null;

let panel = "";

let stopVideo: (() => Promise<string | null>) | null = null;

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

const chipText = async () => String(await rp.evaluate(panel, `(() => { const c = document.querySelector("#think-chip"); return c && !c.hidden ? c.innerText.replace(/\\s+/g, " ").trim() : ""; })()`));

const ask = async (text: string) => {
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 180_000, text, 500);
};

const pick = async (label: "快" | "深入") => {
  await rp.click(panel, "#input");
  await rp.click(panel, "#think-chip");
  await sleep(350);
  await rp.screenshot(panel, join(artifacts, `menu-${label}.png`));
  await rp.click(panel, `#think-menu [data-deep="${label === "深入" ? 1 : 0}"]`);
  await sleep(300);
  evidence[`menuOpenAfter${label === "深入" ? "Deep" : "Fast"}`] = await rp.evaluate(panel, `document.querySelector("#think-menu").classList.contains("open")`);
  await rp.click(panel, "#think-chip");
  await sleep(300);
};

const openPanel = async () => {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
};

try {
  const base = `http://127.0.0.1:${siteAddress(site).port}/`;
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  await rp.cdp.send("Target.createTarget", { url: base });
  await openPanel();
  stopVideo = await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")).catch(() => null);

  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await rp.click(panel, "#input");
  await until(async () => (await chipText()) || undefined, 60_000, "输入框旁出现模型与思考强度");
  evidence.chipStart = await chipText();
  await rp.screenshot(panel, join(artifacts, "chip.png"));

  const menuState = `(() => { const m = document.querySelector("#think-menu"); const r = m.getBoundingClientRect(); const c = document.querySelector("#think-chip").getBoundingClientRect(); const level = m.classList.contains("mm-in-all") ? ".mm-all" : ".mm-main";
    return { open: m.classList.contains("open"), level: level === ".mm-all" ? "all" : "main", aboveChip: r.bottom <= c.top && c.top - r.bottom < 80, rows: [...m.querySelectorAll(level + " .mm-row[data-model]")].map(el => ({ id: el.dataset.model, name: el.querySelector(".mm-name").textContent, checked: el.getAttribute("aria-checked") === "true" })),
      effort: !!m.querySelector(".mm-main .mm-seg"), more: !!m.querySelector(".mm-main .mm-more"), barShown: getComputedStyle(document.querySelector("#composer-bar-inner")).visibility === "visible",
      focus: m.contains(document.activeElement) ? (document.activeElement.matches(".mm-search input") ? "search" : "menu") : document.activeElement?.id ?? "" }; })()`;
  type MenuState = { open: boolean; level: string; aboveChip: boolean; rows: { id: string; name: string; checked: boolean }[]; effort: boolean; more: boolean; barShown: boolean; focus: string };
  const read = async () => await rp.evaluate(panel, menuState) as MenuState; // SAFETY: menuState 返回上面这个形状。
  const escape = async () => {
    for (const type of ["keyDown", "keyUp"] as const) await rp.cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, panel);
    await sleep(350);
  };

  await rp.click(panel, "#think-chip");
  await sleep(450);
  const first = await read();
  evidence.firstLevel = first;
  await rp.screenshot(panel, join(artifacts, "menu.png"));

  if (first.more) {
    await rp.click(panel, "#think-menu .mm-more");
    await sleep(450);
    await rp.typeText(panel, "sol");
    await sleep(400);
    const all = await read();
    await rp.screenshot(panel, join(artifacts, "more.png"));
    await escape();
    const back = await read();
    await escape();
    const closed = await read();
    evidence.moreModels = { level: all.level, focus: all.focus, rows: all.rows.map((row) => row.name), allMatch: all.rows.length > 0 && all.rows.every((row) => /sol/i.test(`${row.id} ${row.name}`)), escBack: back.open && back.level === "main", escClose: !closed.open && closed.focus === "think-chip" };
  }

  // 换一个模型再换回来：两步到位，开关跟着宿主的确认换名字。
  const original = first.rows.find((row) => row.checked);
  const other = first.rows.find((row) => !row.checked);

  if (original && other) {
    await rp.click(panel, "#think-chip");
    await sleep(350);
    await rp.click(panel, `#think-menu .mm-main .mm-row[data-model="${other.id}"]`);
    evidence.switched = await until(async () => { const text = await chipText(); return text.startsWith(other.name) ? text : undefined; }, 15_000, "开关换成新模型名");
    await rp.click(panel, "#think-chip");
    await sleep(350);
    await rp.click(panel, `#think-menu .mm-main .mm-row[data-model="${original.id}"]`);
    evidence.switchedBack = await until(async () => { const text = await chipText(); return text.startsWith(original.name) ? text : undefined; }, 15_000, "开关换回原模型名");
  }

  await pick("深入");
  evidence.chipDeep = await chipText();
  await ask("这页写了什么？一句话回答。");

  await pick("快");
  evidence.chipFast = await chipText();
  await ask("负责人是谁？一句话回答。");

  // 关掉侧栏再开：还记得选过「快」以外的选择。先选回「深入」再重开。
  await pick("深入");
  await rp.cdp.send("Target.closeTarget", { targetId: (await rp.targets()).find((t) => t.url.includes("sidepanel"))!.targetId }).catch(() => undefined);
  await sleep(1000);
  await openPanel();
  await rp.click(panel, "#input");
  await until(async () => (await chipText()) || undefined, 60_000, "重开后输入框旁出现开关");
  evidence.chipReopened = await chipText();

  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  // SAFETY: 诊断记录每行是 { runId, type, data } 的 JSON。
  const lines = traces.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { runId?: string; type: string; data?: { text?: string; effort?: string } });
  const effortsOf = (text: string) => {
    const runId = lines.find((l) => l.type === "run_start" && l.data?.text?.includes(text))?.runId;

    return lines.filter((l) => l.runId === runId && l.type === "model_request").map((l) => l.data?.effort ?? "?");
  };
  evidence.effortDeep = effortsOf("这页写了什么");
  evidence.effortFast = effortsOf("负责人是谁");

  assert.match(String(evidence.chipStart), /· 快/, "一开始是「快」");
  const firstLevel = evidence.firstLevel as MenuState;
  assert.ok(firstLevel.open && firstLevel.aboveChip && firstLevel.barShown && firstLevel.focus === "menu", `菜单在开关上方打开，输入框不收起，焦点进菜单：${JSON.stringify(firstLevel)}`);
  assert.ok(firstLevel.rows.filter((row) => row.checked).length === 1 && firstLevel.effort, `第一层有模型（当前的打勾）和思考开关：${JSON.stringify(firstLevel.rows)}`);
  assert.ok(firstLevel.rows.length >= 2, `第一层至少有两个模型可选：${JSON.stringify(firstLevel.rows)}`);
  assert.ok(evidence.menuOpenAfterDeep === true && evidence.menuOpenAfterFast === true, "切思考时菜单不关");

  // ChatGPT 账号的目录有几十个模型，第一层放不下，必须有「更多模型」。
  if (modelArg.startsWith("openai-codex/")) assert.ok(firstLevel.more, "目录大时第一层最后一行是「更多模型」");
  if (firstLevel.more) assert.deepEqual({ ...(evidence.moreModels as JsonRecord), rows: undefined }, { level: "all", focus: "search", rows: undefined, allMatch: true, escBack: true, escClose: true }, `更多模型在同一个菜单里打开、能搜，Esc 先返回再关上：${JSON.stringify(evidence.moreModels)}`);
  assert.ok(evidence.switched && evidence.switchedBack, "选别的模型后开关换名字，换回来也一样");
  assert.match(String(evidence.chipDeep), /· 深入/, "选了深入，按钮写深入");
  assert.ok((evidence.effortDeep as string[]).length > 0 && (evidence.effortDeep as string[]).every((e) => e === "high"), `选深入后用高档：${JSON.stringify(evidence.effortDeep)}`);
  assert.ok((evidence.effortFast as string[]).length > 0 && (evidence.effortFast as string[]).every((e) => e === "low"), `选快后用低档：${JSON.stringify(evidence.effortFast)}`);
  assert.match(String(evidence.chipReopened), /· 深入/, "重开侧栏还记得选了深入");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
} finally {
  evidence.video = await stopVideo?.().catch(() => null) ?? null;
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
