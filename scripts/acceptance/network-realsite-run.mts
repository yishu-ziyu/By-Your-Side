#!/usr/bin/env node
/**
 * `network` 真实路径验收：真实站点、真实扩展构建、真实 CDP Network 记录。
 * 依据 docs/evals/20260911-network.md。
 *
 * 流程：open_tab(about:blank) → navigate(真实页) → snapshot → network
 *      → 从记录里取出页面自己调用过的接口 URL → fetch 它 → 校验拿到数据。
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchIsolatedExtension, sleep } from "./isolated-extension.mts";

const PAGE = "https://www.bilibili.com/video/BV1GJ411x7h7/";
const API_PREFIX = "https://api.bilibili.com/";

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  const iso = await launchIsolatedExtension();
  const outDir = iso.outDir;
  const report: Record<string, unknown> = { ok: false, page: PAGE, outDir, checks, network: null, fetch: null, filter: null, clear: null };
  try {
    const opened = await iso.tool("open_tab", { url: "about:blank" });
    check("open_tab about:blank", opened?.ok === true && opened?.data?.tabId != null, `tabId ${opened?.data?.tabId}`);

    const navigated = await iso.tool("navigate", { url: PAGE });
    check("navigate 真实页面（navigate 内部先 attach 再改地址）", navigated?.ok === true && navigated?.data?.readiness !== "timeout",
      `${navigated?.data?.title ?? navigated?.error}（${navigated?.data?.readiness}）`);

    // 给页面自己的脚本时间发请求。
    await sleep(4_000);
    const snapshot = await iso.tool("snapshot", {});
    check("snapshot 正常（观察页面不影响记录）", snapshot?.ok === true && typeof snapshot?.data?.text === "string");
    await sleep(1_500);

    const listed = await iso.tool("network", { limit: 60, types: "all" });
    const listData = listed?.data ?? {};
    const listText: string = listData.text ?? "";
    await writeFile(join(outDir, "network-all.txt"), listText);
    report.network = { ok: listed?.ok, total: listData.total, matched: listData.matched, shown: listData.shown, dropped: listData.dropped };
    check("network 返回记录（被动采集生效）", listed?.ok === true && (listData.total ?? 0) > 0, `total ${listData.total}, matched ${listData.matched}, shown ${listData.shown}`);
    check("记录里有页面自己的 api.bilibili.com 调用", listText.includes(API_PREFIX), listText.includes(API_PREFIX) ? "找到 api.bilibili.com" : listText.slice(0, 200));
    check("记录带请求方法/状态/类型/耗时结构", /(pending|failed|\d{3}) (GET|POST) https:\/\//.test(listText) && /— (xhr|fetch)\b/.test(listText));

    // 默认过滤只看 xhr/fetch；document/script 不应出现。
    const defaultList = await iso.tool("network", { limit: 60 });
    const defaultText: string = defaultList?.data?.text ?? "";
    report.filter = { total: defaultList?.data?.total, matched: defaultList?.data?.matched, shown: defaultList?.data?.shown };
    const types = [...defaultText.matchAll(/— ([a-z]+)/g)].map((m) => m[1]);
    check("默认过滤只看 xhr/fetch", defaultList?.ok === true && types.length > 0 && types.every((t) => t === "xhr" || t === "fetch"), `types: ${[...new Set(types)].join(",")}`);
    const urlFiltered = await iso.tool("network", { urlContains: "api.bilibili.com", limit: 20 });
    const urlText: string = urlFiltered?.data?.text ?? "";
    check("urlContains 过滤", urlFiltered?.ok === true && (urlFiltered?.data?.shown ?? 0) > 0 && urlText.split("\n").filter((l) => /^\d+\./.test(l)).every((l) => l.includes("api.bilibili.com")),
      `shown ${urlFiltered?.data?.shown}`);

    // 从模型可见文本里取页面自己调用过的接口，再用 fetch 取数据（串起第一步）。
    const candidates = [...new Set([...listText.matchAll(new RegExp(`${API_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s]+`, "g"))].map((m) => m[0]))].slice(0, 4);
    report.fetch = { candidates };
    let fetched: any;
    for (const candidate of candidates) {
      const attempt = await iso.tool("fetch", { url: candidate });
      const data = attempt?.data;
      let parsed: any;
      try {
        parsed = data?.text ? JSON.parse(data.text) : undefined;
      } catch {
        parsed = undefined;
      }
      report.fetch = { ...(report.fetch as object), attempted: candidate, ok: attempt?.ok, status: data?.status, bytes: data?.bytes, parsedCode: parsed?.code };
      if (attempt?.ok === true && data?.status === 200 && parsed && parsed.code === 0) {
        fetched = { attempt, candidate, parsed };
        break;
      }
    }
    check("fetch 页面自己调用过的接口能取到数据", Boolean(fetched),
      fetched ? `${fetched.candidate} → HTTP ${fetched.attempt.data.status}，${fetched.attempt.data.bytes}B，code ${fetched.parsed.code}` : `试了 ${(report.fetch as any).candidates?.length ?? 0} 个候选均失败`);

    const cleared = await iso.tool("network", { clear: true });
    const clearedText: string = cleared?.data?.text ?? "";
    const afterClear = await iso.tool("network", { limit: 5 });
    report.clear = { clearedText, afterTotal: afterClear?.data?.total, afterText: afterClear?.data?.text?.slice(0, 160) };
    check("clear 清空缓冲并写清回执", cleared?.ok === true && /buffer cleared/i.test(clearedText), clearedText);
    check("clear 后读到的是空/新记录，不混旧条目", (afterClear?.data?.total ?? -1) <= 5, `total ${afterClear?.data?.total}`);

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
