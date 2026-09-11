#!/usr/bin/env node
/**
 * 合并工具（tabs / mark）真实扩展路径验收：真扩展构建 + 隔离 headless Chrome。
 * 走的是生产 ToolRpc → 扩展 executeToolCall → handlers，不是模拟桩。
 * 依据 docs/evals/20260911-fast-and-lean.md 的 B3。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchIsolatedExtension, sleep } from "./isolated-extension.mts";
import { ToolRpc, type ToolCallFrame } from "../../agent/src/rpc.js";
import { createBrowserTools } from "../../agent/src/tools.js";

const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "/tmp/sideagent-merged-tools";
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const iso = await launchIsolatedExtension();
  const report: Record<string, unknown> = { ok: false, outDir: iso.outDir, checks };
  const cid = `merged-${Date.now()}`;
  const rpc = new ToolRpc((frame: ToolCallFrame) => {
    void iso.swEval(
      `globalThis.__saCall(${JSON.stringify(frame.id)}, ${JSON.stringify(frame.name)}, ${JSON.stringify(frame.params)}, ${JSON.stringify(frame.sessionId ?? "main")}, ${JSON.stringify(frame.programId ?? null)}, ${JSON.stringify(cid)})`,
      60_000,
    ).then((reply: { ok?: boolean; data?: unknown; error?: string }) => {
      rpc.handleResult(frame.id, reply?.ok === true, reply?.data, reply?.error);
    }, (error) => rpc.handleResult(frame.id, false, undefined, String(error)));
  });
  const tools = createBrowserTools(rpc);
  const run = (name: string, params: Record<string, unknown>) =>
    (tools.find((t) => t.name === name)!.execute(`merge-${name}-${Math.random().toString(36).slice(2, 7)}`, params, undefined, undefined, {} as never)) as Promise<{ content: { text: string }[] }>;

  try {
    const opened = await run("tabs", { action: "open", url: iso.fixtureOrigin });
    const tabId = Number(/tab (\d+)/.exec(opened.content[0].text)?.[1]);
    check("tabs open 打开并声明工作页", Number.isFinite(tabId), opened.content[0].text.slice(0, 120));

    const list = await run("tabs", { action: "list" });
    check("tabs list 列出页面", list.content[0].text.includes(String(tabId)) && list.content[0].text.includes("isolated probe"), list.content[0].text.slice(0, 120));

    await iso.swEval(`chrome.tabs.update(${tabId},{active:true}).catch(()=>{})`);
    const active = await run("tabs", { action: "active" });
    check("tabs active 返回被激活的页面", active.content[0].text.includes(`[${tabId}]`), active.content[0].text.slice(0, 120));

    const second = await run("tabs", { action: "open", url: iso.fixtureOrigin });
    const secondId = Number(/tab (\d+)/.exec(second.content[0].text)?.[1]);
    const switched = await run("tabs", { action: "switch", tabId });
    check("tabs switch 切回旧页", switched.content[0].text.includes(String(tabId)), switched.content[0].text.slice(0, 80));

    // 标注：画一个 → 页面出现 mark 画布 → clear 清掉。
    const marked = await run("mark", { target: "p", label: "验收" });
    await sleep(500);
    // 标注画布挂在页面 DOM 上（closed shadow，外部只能看到 host 本身）。
    const marksAfterDraw = await iso.swEval(
      `chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>({host:!!document.querySelector('[data-sideagent-overlay="marks"]'),rects:document.querySelector('[data-sideagent-overlay="marks"]')?1:0})}).then(r=>r[0].result)`,
    ) as { host: boolean; rects: number };
    check("mark 画标注（合并后仍走 mark RPC）", marked.content[0].text.includes("Marked"), marked.content[0].text.slice(0, 80));
    check("标注画布真的挂到页面上", marksAfterDraw?.host === true, `host ${marksAfterDraw?.host}`);

    const cleared = await run("mark", { clear: true });
    await sleep(400);
    const marksAfterClear = await iso.swEval(
      `chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>document.querySelectorAll('[data-sideagent-overlay="marks"] .mark').length}).then(r=>r[0].result)`,
    ) as number;
    check("mark clear 清除全部标注", cleared.content[0].text.includes("cleared") && marksAfterClear === 0, `visible mark nodes ${marksAfterClear}`);

    const closed = await run("tabs", { action: "close", tabId: secondId });
    const remaining = await iso.swEval(`chrome.tabs.query({}).then(ts=>ts.filter(t=>t.id===${secondId}).map(t=>t.id))`) as number[];
    check("tabs close 真的关掉页面", closed.content[0].text.includes("closed") && remaining.length === 0, `remaining ${JSON.stringify(remaining)}`);

    await run("tabs", { action: "close", tabId });
    report.ok = checks.every((c) => c.ok);
  } catch (error) {
    report.error = String(error);
    console.log(`ERROR ${String(error)}`);
  } finally {
    await iso.close();
    await writeFile(join(OUT, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, out: OUT }));
  }
}

await main();
