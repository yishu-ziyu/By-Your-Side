/** P2：offscreen 文档在慢工具中途被关掉，重建后 resume()。用法：node p2-offscreen.mjs --headless → out/pi1-rebuild/p2-result.json */
import { openOffscreen, save, serviceWorker, shutdown, sleep, waitFor } from "./driver.mjs";

const PROMPT = "Call slow_lookup with key \"alpha\" and ms 8000, then tell me the code word. If the tool returns an error, reply exactly TOOL FAILED and do not call any tool again.";

try {
  const db = `p2-${Date.now()}`;
  const sw = await serviceWorker();

  await sw.call("create");
  const first = await openOffscreen();

  await first.call("open", db);
  await first.call("watch");
  const { submissionId } = await first.call("submit", PROMPT);
  await waitFor(async () => (await first.call("count", "slow_lookup")) >= 1, 60_000, "slow_lookup 开始执行");
  await sleep(1500);
  const eventsBeforeClose = [...new Set((await first.call("record")).rows.map((r) => r.type))];
  await sw.call("close");
  const closedHasDocument = await sw.call("has");
  await sw.call("create");
  const second = await openOffscreen(first.targetId);
  const execsBeforeResume = await second.call("count", "slow_lookup");
  const resumed = await second.call("resume", db);
  const status = await second.call("waitSubmission", submissionId);
  const transcript = await second.call("transcript");
  const execsAfter = await second.call("count", "slow_lookup");
  await second.call("close");
  const msgs = transcript.flatMap((e) => e.model);
  const result = msgs.find((m) => m.role === "toolResult" && m.toolName === "slow_lookup");
  const last = msgs.at(-1);

  const checks = {
    transcriptSurvived: resumed.transcriptAtOpen.some((e) => e.kind === "pi.user") && resumed.transcriptAtOpen.some((e) => e.model.some((m) => m.parts.some((p) => p.startsWith("toolCall:slow_lookup")))),
    interruptedResult: result?.isError === true && /interrupt|abort/i.test(result.parts.join(" ")),
    notReExecuted: execsBeforeResume === 1 && execsAfter === 1,
    finishedWithAnswer: status === "done" && last?.role === "assistant" && last.parts.some((p) => p.startsWith("text:")),
  };

  const out = { pass: Object.values(checks).every(Boolean), checks, targetTypes: { first: first.type, second: second.type }, closedHasDocument, execsBeforeResume, execsAfter, status, eventsBeforeClose, resumed, transcript };

  save("p2-result.json", out);
  console.log("P2", out.pass ? "PASS" : "FAIL", checks, { targetTypes: out.targetTypes, closedHasDocument, execsBeforeResume, execsAfter, status, pendingAtOpen: resumed.pendingAtOpen, toolResult: result, last });
} catch (e) {
  console.error("失败：", e.message);
  process.exitCode = 1;
} finally {
  await shutdown();
}
