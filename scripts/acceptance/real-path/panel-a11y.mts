import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-panel-a11y`);
await mkdir(artifacts, { recursive: true });
const AXE = readFileSync(join(REPO, "node_modules/axe-core/axe.min.js"), "utf8");

const LONG = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段：西湖的步行路线沿着湖岸展开，从断桥出发往孤山走，再折回白堤，全程大约一个半小时。`).join("\n\n");
const CHART = `杭州回深圳最合适的是 7 月 18 日的 JD5290。
<ui title="杭州到深圳的航班">
root = Col([title, Row([IconButton("minus", @Set($people, @Clamp($people - 1, 1, 9)), "减少"), Text("人数 " + $people, "md"), IconButton("plus", @Set($people, @Clamp($people + 1, 1, 9)), "增加")], 3), total, chart, live])
$people = 2
title = Title("杭州到深圳的航班", "lg")
total = Text("合计 " + ($people * 680) + " 元", "md", null, "semibold")
chart = Chart("bar", [{key: "JD5290", value: 680}, {key: "GJ8627", value: 540}], "key", ["value"], "currency")
live = Button("查 JD5290 实时状态", @ToAssistant("查 JD5290 实时状态"))
</ui>`;
const model = await startScriptedModel([
  { match: "慢慢讲", steps: [{ text: LONG, chunkDelayMs: 400 }] },
  { match: "航班", steps: [{ text: CHART }] },
]);

type Hit = { rule: string; impact: string | null; help: string; target: string; html: string; box: { x: number; y: number; w: number; h: number } | null; where: "panel" | "frame" };
type Scan = { state: string; scheme: "light" | "dark"; hits: Hit[]; shot: string; ran: boolean };
const scans: Scan[] = [];
const rp = await launchRealPath();
let error: string | null = null;
let keyboard: { reached: Record<string, boolean>; order: string[] } | null = null;
let panel = "";

const AXE_RUN = `axe.run(document, { resultTypes: ["violations"] }).then(r => r.violations.flatMap(v => v.nodes.map(n => {
  const el = document.querySelector(n.target[0]);
  const b = el?.getBoundingClientRect();
  return { rule: v.id, impact: v.impact ?? null, help: v.help, target: String(n.target[0]), html: n.html.slice(0, 160), box: b && b.width ? { x: b.x, y: b.y, w: b.width, h: b.height } : null };
})))`;

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.disabled===false') || undefined, 60_000, "侧栏就绪");

  const frameSession = async () => {
    const frame = (await rp.targets()).findLast(t => t.type === "iframe" && t.url.includes("answer-ui.html"));
    return frame ? rp.attach(frame.targetId) : null;
  };
  const scheme = async (value: "light" | "dark", sessions: string[]) => {
    for (const s of sessions) await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] }, s);
    await sleep(400);
  };
  const scan = async (state: string, value: "light" | "dark") => {
    const frame = await frameSession();
    await scheme(value, [panel, ...(frame ? [frame] : [])]);
    const run = async (session: string, where: Hit["where"]) => {
      if (!(await rp.evaluate(session, "typeof axe !== 'undefined'"))) await rp.evaluate(session, `${AXE}; true`, { timeoutMs: 60_000 });
      return ((await rp.evaluate(session, AXE_RUN, { timeoutMs: 60_000 })) as Omit<Hit, "where">[]).map(h => ({ ...h, where }));
    };
    const hits = await run(panel, "panel");
    if (frame) {
      const offset = await rp.evaluate(panel, `(() => { const r = [...document.querySelectorAll("iframe.gc-app-iframe")].at(-1)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y } : { x: 0, y: 0 }; })()`) as { x: number; y: number };
      hits.push(...(await run(frame, "frame")).map(h => ({ ...h, box: h.box ? { ...h.box, x: h.box.x + offset.x, y: h.box.y + offset.y } : null })));
    }
    const shot = `${scans.length + 1}-${state}-${value}.png`;
    await rp.evaluate(panel, `(() => { for (const [i, h] of ${JSON.stringify(hits.map(h => h.box))}.entries()) { if (!h) continue; const d = document.createElement("div"); d.className = "a11y-mark"; d.style.cssText = \`position:fixed;left:\${h.x}px;top:\${h.y}px;width:\${h.w}px;height:\${h.h}px;outline:2px solid #e5484d;z-index:2147483647;pointer-events:none;font:11px/1 system-ui;color:#fff\`; const t = document.createElement("span"); t.textContent = String(i + 1); t.style.cssText = "position:absolute;left:-2px;top:-14px;background:#e5484d;padding:1px 3px"; d.append(t); document.body.append(d); } return true; })()`);
    await rp.screenshot(panel, join(artifacts, shot));
    await rp.evaluate(panel, `(document.querySelectorAll(".a11y-mark").forEach(m => m.remove()), true)`);
    scans.push({ state, scheme: value, hits, shot, ran: true });
  };
  const ask = async (text: string) => {
    await rp.evaluate(panel, `(() => { const el = document.querySelector("#input"); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await rp.click(panel, "#send-btn");
  };

  for (const value of ["light", "dark"] as const) await scan("空侧栏", value);

  const order: string[] = [];
  await rp.evaluate(panel, "(document.activeElement?.blur(), document.body.focus(), true)");
  for (let i = 0; i < 30; i++) {
    for (const type of ["keyDown", "keyUp"] as const) await rp.cdp.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, panel);
    order.push(String(await rp.evaluate(panel, `(() => { const e = document.activeElement; return e ? (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.getAttribute("aria-label") ? "[" + e.getAttribute("aria-label") + "]" : "")) : "none"; })()`)));
  }
  keyboard = { reached: Object.fromEntries(["#input", "#send-btn", "#conversation-new"].map(id => [id, order.includes(id)])), order };

  await ask("慢慢讲西湖怎么走");
  await until(async () => (String(await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText ?? ""'))).includes("第 2 段") || undefined, 30_000, "回答开始出字");
  const streaming = async () => !(String(await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText ?? ""'))).includes("第 12 段");
  for (const value of ["light", "dark"] as const) {
    assert.ok(await streaming(), "检查时回答还在写");
    await scan("正在回答", value);
  }
  await until(async () => !(await streaming()) && await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "长回答写完");

  await rp.click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#messages")?.innerText.includes("西湖")') || undefined, 60_000, "新会话就绪");
  await ask("航班");
  await until(async () => (await rp.evaluate(panel, '!!document.querySelector("iframe.gc-app-iframe")')) || undefined, 60_000, "回答里出现界面");
  await until(async () => { const f = await frameSession(); return f && await rp.evaluate(f, 'document.querySelectorAll("figure.iui-chart svg").length > 0') || undefined; }, 30_000, "图表画出来");
  await sleep(800);
  for (const value of ["light", "dark"] as const) await scan("带卡片和图表的回答", value);
} catch (caught) {
  await rp.screenshot(panel, join(artifacts, "failed.png")).catch(() => undefined);
  error = caught instanceof Error ? caught.message : String(caught);
} finally {
  await rp.close(); await rp.remove(); await model.close?.();
}

const rules = new Map<string, { help: string; impact: string | null; where: Set<string> }>();
for (const s of scans) for (const h of s.hits) {
  const r = rules.get(h.rule) ?? { help: h.help, impact: h.impact, where: new Set<string>() };
  r.where.add(`${s.state}·${s.scheme === "light" ? "浅色" : "深色"}`);
  rules.set(h.rule, r);
}
const report = [
  `# 侧栏无障碍检查`,
  ``,
  `axe-core ${JSON.parse(readFileSync(join(REPO, "node_modules/axe-core/package.json"), "utf8")).version}。查了 ${scans.length}/6 种情况，共 ${scans.reduce((n, s) => n + s.hits.length, 0)} 处，涉及 ${rules.size} 条规则。只出报告，不判失败。${error ? `\n\n运行中断：${error}` : ""}`,
  ``,
  `## 按规则`,
  ``,
  `| 规则 | 严重度 | 说明 | 出现在 |`,
  `|---|---|---|---|`,
  ...[...rules].map(([id, r]) => `| ${id} | ${r.impact ?? "-"} | ${r.help} | ${[...r.where].join("、")} |`),
  ``,
  `## 键盘`,
  ``,
  keyboard ? `连按 Tab 30 次：${Object.entries(keyboard.reached).map(([k, v]) => `${k} ${v ? "能到" : "到不了"}`).join("，")}。顺序：${[...new Set(keyboard.order)].join(" → ")}` : "没跑到",
  ``,
  ...scans.flatMap(s => [`## ${s.state}·${s.scheme === "light" ? "浅色" : "深色"}（截图 ${s.shot}，红框编号对应下表）`, ``, `| # | 规则 | 元素 | 位置 |`, `|---|---|---|---|`,
    ...s.hits.map((h, i) => `| ${i + 1} | ${h.rule} | \`${h.target.replace(/\|/g, "\\|")}\`${h.where === "frame" ? "（回答内界面）" : ""} | ${h.box ? `${Math.round(h.box.x)},${Math.round(h.box.y)} ${Math.round(h.box.w)}×${Math.round(h.box.h)}` : "不可见"} |`), ``]),
].join("\n");
await writeFile(join(artifacts, "report.md"), report);
await writeFile(join(artifacts, "evidence.json"), JSON.stringify({ error, keyboard, scans }, null, 2));
console.log(`报告：${join(artifacts, "report.md")}`);
assert.equal(error, null, error ?? "");
assert.equal(scans.filter(s => s.ran).length, 6, "六种情况都查到");
