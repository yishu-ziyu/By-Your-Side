#!/usr/bin/env node
/**
 * `fetch` 真实站点前后对比（隔离实例，不碰用户浏览器）。
 * 依据 docs/evals/20260911-fetch-real-site.md。
 *
 * 做法：headless Chrome for Testing 加载真实构建的扩展 → 通过生产
 * onMessage → executeToolCall 路径调 open_tab / fetch / snapshot；
 * fetch 走真实网络，snapshot 走真实 CDP AX 树。
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchIsolatedExtension, sleep } from "./isolated-extension.mts";
import { formatFetchReply, type FetchReply } from "../../agent/src/fetch-result.js";
import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";

type RealCase = {
  name: string;
  page: string;
  api: string;
  /** 从 fetch 的 JSON 里取「页面上也显示」的字段，证明两份材料是同一份数据。 */
  wanted: (json: any) => string[];
  requireMatches: number;
};

const CASES: RealCase[] = [
  {
    name: "bilibili-video",
    page: "https://www.bilibili.com/video/BV1GJ411x7h7/",
    api: "https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7",
    wanted: (json) => [json?.data?.title, json?.data?.owner?.name].filter((v) => typeof v === "string" && v.length > 2),
    requireMatches: 2,
  },
  {
    name: "hacker-news",
    page: "https://news.ycombinator.com/",
    api: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10",
    wanted: (json) => (Array.isArray(json?.hits) ? json.hits.slice(0, 5).map((hit: any) => hit?.title).filter((v: unknown) => typeof v === "string" && v.length > 4) : []),
    requireMatches: 3,
  },
];

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function normalize(text: string): string {
  return text.replace(/[\u00a0\u2000-\u200f\u2028-\u202f]/g, " ").replace(/\s+/g, " ").trim();
}

function matchReport(text: string, wanted: string[]): { matched: string[]; missing: string[] } {
  const hay = normalize(text);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const want of wanted) {
    (hay.includes(normalize(want)) ? matched : missing).push(want);
  }
  return { matched, missing };
}

async function main(): Promise<void> {
  const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  const only = process.argv.find((a) => a.startsWith("--case="))?.slice(7);
  const cases = only ? CASES.filter((c) => c.name === only) : CASES;
  if (cases.length === 0) throw new Error(`未知 case：${only}`);

  const iso = await launchIsolatedExtension();
  const downloadsDir = join(iso.outDir, "downloads");
  const outDir = iso.outDir;
  const report: Record<string, unknown> = { ok: false, outDir, cases: [], checks, guard: null, downloadsDir };
  try {
    check("生产 executeToolCall 路径可达（__saCall 已挂上真实 uplink.handleRaw）", true, "isolated-extension 已确认");

    for (const realCase of cases) {
      const record: Record<string, unknown> = { name: realCase.name, page: realCase.page, api: realCase.api };
      report.cases.push(record);
      const opened = await iso.tool("open_tab", { url: realCase.page });
      record.openTab = { tabId: opened?.data?.tabId, readiness: opened?.data?.readiness, waitMs: opened?.data?.waitMs };
      check(`${realCase.name}: 打开真实页面`, opened?.ok === true, `${opened?.data?.url ?? opened?.error}`);

      const fetchStart = Date.now();
      const fetched = await iso.tool("fetch", { url: realCase.api });
      const fetchMs = Date.now() - fetchStart;
      const reply = fetched?.data as FetchReply | undefined;
      if (fetched?.ok !== true || !reply) {
        record.fetch = { ok: false, error: fetched?.error };
        check(`${realCase.name}: fetch 公开接口`, false, String(fetched?.error ?? "no data"));
        continue;
      }
      const modelFetchText = formatFetchReply(reply, undefined, downloadsDir);
      record.fetch = {
        ms: fetchMs,
        status: reply.status,
        contentType: reply.contentType,
        bytes: reply.bytes,
        truncated: reply.truncated,
        rawChars: reply.text.length,
        contextChars: modelFetchText.length,
      };
      check(`${realCase.name}: fetch 公开接口`, reply.ok === true,
        `HTTP ${reply.status} ${reply.bytes}B、请求 ${fetchMs}ms、进上下文 ${modelFetchText.length} 字符`);

      let json: any;
      try {
        json = JSON.parse(reply.text);
      } catch (error) {
        check(`${realCase.name}: 接口返回可解析 JSON`, false, String(error));
        continue;
      }
      const wanted = realCase.wanted(json);
      record.wanted = wanted;

      // 页面客户端渲染可能有延迟：轮询 snapshot 直到出现目标字段。
      let snapshot: any;
      let snapshotMs = 0;
      let snapshotAttempts = 0;
      let match = { matched: [] as string[], missing: wanted };
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        snapshotAttempts += 1;
        const started = Date.now();
        snapshot = await iso.tool("snapshot", {});
        snapshotMs = Date.now() - started;
        if (snapshot?.ok !== true || typeof snapshot?.data?.text !== "string") {
          await sleep(800);
          continue;
        }
        match = matchReport(snapshot.data.text, wanted);
        if (match.matched.length >= realCase.requireMatches) break;
        await sleep(800);
      }
      if (snapshot?.ok !== true || typeof snapshot?.data?.text !== "string") {
        record.snapshot = { ok: false, error: snapshot?.error };
        check(`${realCase.name}: 同页 snapshot`, false, String(snapshot?.error ?? "no text"));
        continue;
      }
      const snapshotText: string = snapshot.data.text;
      await writeFile(join(outDir, `snapshot-${realCase.name}.txt`), snapshotText);
      await writeFile(join(outDir, `api-${realCase.name}.json`), reply.text);
      const modelSnapshotText = wrapPageContent(redactCredentialText(snapshotText), { tabId: snapshot.data.tabId });
      record.snapshot = {
        ms: snapshotMs,
        attempts: snapshotAttempts,
        rawChars: snapshotText.length,
        contextChars: modelSnapshotText.length,
        matches: match,
      };
      check(`${realCase.name}: 同页 snapshot 含 fetch 的字段（同一份数据）`, match.matched.length >= realCase.requireMatches,
        `匹配 ${match.matched.length}/${wanted.length}${match.missing.length ? `，缺：${match.missing.slice(0, 3).join(" | ")}` : ""}`);
      check(`${realCase.name}: fetch 上下文占用低于 snapshot`,
        modelFetchText.length < modelSnapshotText.length,
        `fetch ${modelFetchText.length} vs snapshot ${modelSnapshotText.length} 字符（原始 ${reply.text.length} vs ${snapshotText.length}，snapshot 第 ${snapshotAttempts} 次）`);
      record.compare = {
        fetchContextChars: modelFetchText.length,
        snapshotContextChars: modelSnapshotText.length,
        savedChars: modelSnapshotText.length - modelFetchText.length,
        ratio: Number((modelSnapshotText.length / Math.max(1, modelFetchText.length)).toFixed(2)),
        fetchMs,
        snapshotMs,
      };
      console.log(`  ${realCase.name}: fetch ${fetchMs}ms / snapshot ${snapshotMs}ms；上下文 fetch ${modelFetchText.length} vs snapshot ${modelSnapshotText.length} 字符`);
    }

    const guardBefore = iso.fixtureHits();
    const guard = await iso.tool("fetch", { url: `${iso.fixtureOrigin}/private-probe` });
    const guardError = String(guard?.error ?? "");
    report.guard = { ok: guard?.ok, error: guardError, hitsBefore: guardBefore, hitsAfter: iso.fixtureHits() };
    check("真实扩展路径拒绝回环地址", guard?.ok === false && /拒绝本地\/私网/.test(guardError), guardError);
    check("拒绝前没有向回环地址发出请求", iso.fixtureHits() === guardBefore, `hits ${guardBefore} → ${iso.fixtureHits()}`);

    report.ok = checks.every((c) => c.ok);
  } catch (error) {
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(error);
  } finally {
    await writeFile(join(outDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`evidence ${outDir}`);
    if (outPath) await writeFile(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
    await iso.close();
  }
  process.exit(report.ok === true ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
