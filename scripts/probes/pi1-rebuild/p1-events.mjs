/** P1：watchEvents 事件覆盖 + 文字延迟（扩展标签页）。用法：node p1-events.mjs --headless → out/pi1-rebuild/p1-result.json */
import { openTab, save, shutdown } from "./driver.mjs";

const WANT = ["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start", "compaction_start"];

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) });

const maxGap = (ts) => Math.max(0, ...ts.slice(1).map((t, i) => t - ts[i]));

try {
  const page = await openTab();

  await page.call("open", `p1-${Date.now()}`);
  await page.call("watch");
  await page.call("tapOn");
  const main = await page.call("waitSubmission", (await page.call("submit", "First call the page_title tool once. Then write about 300 words of plain prose about the history of the page title in web browsers, mentioning the title you got. Do not call any other tool.")).submissionId);
  const rec = await page.call("record");
  // 只为看到 auto_retry_start 与 compaction_start：下一次模型请求注入 503，再手动压缩一次。
  await page.call("failNext", 1);
  const retry = await page.call("waitSubmission", (await page.call("submit", "Reply with just OK.")).submissionId);
  const compaction = await page.call("compact");
  const all = (await page.call("record")).rows;
  const transcript = await page.call("transcript");
  await page.call("close");
  const seen = [...new Set(all.map((r) => r.type))];
  const changeTypes = [...new Set(all.flatMap((r) => r.changes ?? []))];
  // 延迟：消费端每个让文字变长的事件，减去服务商送来其中第一个（最老）新字符的时间。
  const at = (len) => rec.provider.find((p) => p.len > len)?.t;
  const reveals = rec.rows.flatMap((r, i, rows) => (r.textLen > (rows[i - 1]?.textLen ?? 0) ? [{ ...r, from: rows[i - 1]?.textLen ?? 0 }] : []));
  const latency = reveals.map((r) => r.t - at(r.from));
  const lastMsg = reveals.at(-1).msg;
  const finalReveals = reveals.flatMap((r) => (r.msg === lastMsg ? [r.t] : []));
  const finalStart = reveals.find((r) => r.msg === lastMsg).from;

  const result = {
    pass: stats(latency).p95 <= 150,
    statuses: { main, retry, compaction },
    eventTypesSeen: seen, changeTypesSeen: changeTypes, missing: WANT.filter((w) => !seen.includes(w)),
    latencyMs: { firstNewChar: stats(latency), lastNewChar: stats(reveals.map((r) => r.t - at(r.textLen - 1))) },
    maxGapMs: { consumer: maxGap(finalReveals), provider: maxGap(rec.provider.flatMap((p) => (p.len > finalStart ? [p.t] : []))) },
    counts: { textRevealEvents: reveals.length, providerChunks: rec.provider.length, chars: rec.consumerText.length, textMatches: rec.consumerText === rec.providerText },
    transcript, rows: all, provider: rec.provider, text: rec.consumerText,
  };

  save("p1-result.json", result);
  console.log("P1", result.pass ? "PASS" : "FAIL", { missing: result.missing, latencyMs: result.latencyMs, maxGapMs: result.maxGapMs, counts: result.counts, statuses: result.statuses });
} catch (e) {
  console.error("失败：", e.message);
  process.exitCode = 1;
} finally {
  await shutdown();
}
