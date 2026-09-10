#!/usr/bin/env node
/**
 * 批量翻页真实路径验收：真实站点、真实扩展构建、真实网络。
 * 依据 docs/evals/20260911-fetch-pages.md。
 *
 * 做法：隔离实例里跑生产 fetch（扩展侧），agent 侧用生产 createBrowserTools
 * 的 fetch 工具执行 pages 批量；下载目录用 SIDEAGENT_DOWNLOADS_DIR 指向临时目录。
 */
import { readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchIsolatedExtension } from "./isolated-extension.mts";
import { createBrowserTools } from "../../agent/src/tools.js";

const API = "https://api.github.com/repos/microsoft/vscode/issues?per_page=5&page={page}";

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  const iso = await launchIsolatedExtension();
  const downloads = join(iso.outDir, "downloads");
  process.env.SIDEAGENT_DOWNLOADS_DIR = downloads;
  const report: Record<string, unknown> = { ok: false, api: API, outDir: iso.outDir, checks, batch: null, notFound: null, guard: null };
  try {
    const rpc = {
      call: async (name: string, params: Record<string, unknown>) => {
        const message = await iso.tool(name, params);
        if (message?.ok !== true) throw new Error(String(message?.error ?? `${name} failed`));
        return message.data;
      },
    };
    const tools = createBrowserTools(rpc as any, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, assertCall: () => {} });
    const fetchTool = tools.find((tool) => tool.name === "fetch")!;
    const run = async (params: Record<string, unknown>) => {
      const result: any = await (fetchTool.execute as any)("acceptance-1", params);
      return { text: result.content.map((part: any) => part.text).join("\n"), details: result.details };
    };

    const started = Date.now();
    const batch = await run({ url: API, pages: { from: 1, to: 3 }, savePath: "harness-issues.json" });
    const elapsedMs = Date.now() - started;
    await writeFile(join(iso.outDir, "batch-receipt.txt"), batch.text);
    report.batch = { elapsedMs, contextChars: batch.text.length, details: batch.details, text: batch.text };

    const files = readdirSync(downloads).sort();
    check("三页各落盘一个文件", JSON.stringify(files) === JSON.stringify(["harness-issues-p1.json", "harness-issues-p2.json", "harness-issues-p3.json"]), files.join(","));

    const pages = files.map((file) => JSON.parse(readFileSync(join(downloads, file), "utf8")) as Array<{ number: number }>);
    const sizes = pages.map((page) => page.length);
    const numbers = pages.map((page) => new Set(page.map((issue) => issue.number)));
    const disjoint = numbers[0]!.size === 5 && [...numbers[0]!].every((number) => !numbers[1]!.has(number) && !numbers[2]!.has(number)) && [...numbers[1]!].every((number) => !numbers[2]!.has(number));
    check("每页 5 条且三页内容不重复（真的是不同页）", sizes.every((size) => size === 5) && disjoint, `sizes ${sizes.join("/")}, disjoint ${disjoint}`);

    check("回执写明批量成功与每页路径", batch.text.includes("Batch fetch 3/3 pages (page 1..3)") && batch.text.includes("harness-issues-p1.json") && batch.text.includes("harness-issues-p3.json"));
    check("只给第一页预览（不把三页正文拉回上下文）", (batch.text.match(/Preview:/g) ?? []).length === 1 && batch.text.length < 1_500, `Preview ${(batch.text.match(/Preview:/g) ?? []).length} 次，回执 ${batch.text.length} 字符`);
    check("回执过不可信边界", batch.text.includes("<page-content untrusted"));

    const missing = await run({ url: "https://api.github.com/repos/microsoft/vscode/definitely-missing-endpoint?page={page}", pages: { from: 1, to: 2 }, savePath: "harness-missing.json" });
    report.notFound = { text: missing.text, details: missing.details };
    const missingFiles = readdirSync(downloads).filter((file) => file.startsWith("harness-missing"));
    check("真实 404 不吞：逐页标 (not ok) 且不冒充数据", missing.text.includes("(not ok)") && missing.text.split("\n").filter((line) => /^\d+\./.test(line)).every((line) => line.includes("(not ok)")), `失败页 ${missingFiles.length} 个文件、details.failed=${missing.details.failed}`);

    const hitsBefore = iso.fixtureHits();
    const guarded = await run({ url: `${iso.fixtureOrigin}/api?page={page}`, pages: { from: 1, to: 2 }, savePath: "harness-private.json" });
    report.guard = { text: guarded.text, details: guarded.details, hitsBefore, hitsAfter: iso.fixtureHits() };
    check("批量里私网守卫仍拒绝且不发请求", guarded.text.includes("拒绝本地/私网") && iso.fixtureHits() === hitsBefore, `hits ${hitsBefore} → ${iso.fixtureHits()}`);

    report.ok = checks.every((item) => item.ok);
  } catch (error) {
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(error);
  } finally {
    await writeFile(join(iso.outDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`evidence ${iso.outDir}`);
    if (outPath) await writeFile(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
    await iso.close();
  }
  process.exit(report.ok === true ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
