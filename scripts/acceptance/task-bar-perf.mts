/**
 * T03 指标采样：首次本地反馈 P95 ≤150ms（50 次）＋ 权威事件到 UI 帧 P95 ≤200ms（50 次）。
 *
 *   npx --no-install tsx scripts/acceptance/task-bar-perf.mts --headless [--out=out/acceptance/<时间戳>-t03]
 *
 * 串行、无头、隔离（独立 profile 与随机扩展 ID，不碰用户日常 Chrome/扩展）。两相分开跑：
 * - A 相：真实面板真实点击，WS 端是受控服务（回执延迟固定），量「点击→下一帧出现本地状态」；
 *   同一轮里检查受控延迟窗口内不出现「已接收」。
 * - B 相：真实 ConversationManager（runtime 为脚本桩，无模型调用）驱动 50 次真实投影，
 *   量「面板监听器收到 task_view→对应 UI 帧」；传输时间单列。
 *
 * 结论只描述本次样本；两相都不代表所有网站或总体可靠性。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startTaskBarHarness, sleep, until } from "./task-bar-harness.mts";

const HEADLESS = process.argv.includes("--headless");

if (!HEADLESS) {
  console.error("Required: --headless（本脚本只以无头隔离方式运行）");
  process.exit(2);
}

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));

  return hit ? hit.slice(name.length + 1) : fallback;
};

const SAMPLES = Number(arg("--samples", "50"));

const PHASE = arg("--phase", "both") as "a" | "b" | "both";

const RECEIPT_DELAY_MS = 700;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const outDir = resolve(arg("--out", join("out", "acceptance", `${stamp}-t03`)));

mkdirSync(outDir, { recursive: true });

/** nearest-rank 百分位；样本 <1 时返回 null，不把缺样本当 0。 */
function percentile(values: number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);

  if (!sorted.length) return null;

  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

const median = (values: number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);

  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const round = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

const report: Record<string, any> = {
  startedAt: new Date().toISOString(),
  command: "tsx scripts/acceptance/task-bar-perf.mts --headless",
  samplesPerPhase: SAMPLES,
  boundary: {
    phaseA: "真实 panel（extension/dist 构建）+ 真实 background + 受控 WS 服务（不接 manager，回执延迟固定 700ms）；动作=CDP 真实点击发送按钮",
    phaseB: "真实 ConversationManager + 真实 projectTaskView + 真实 WS/background/panel；runtime 为脚本桩（0 次模型调用）；事件由脚本喂给 manager 的观察链路",
    frame: "下一帧 = task_view 到达面板监听器后，DOM 变更触发的第一次 requestAnimationFrame（Panel.capture 之外的页面内测量）",
  },
  firstLocalFeedback: { samples: [], failures: [] },
  authoritativeToFrame: { samples: [], failures: [] },
};

// ── A 相：点击→本地反馈 ────────────────────────────────────────────
if (PHASE === "a" || PHASE === "both") {
  const h = await startTaskBarHarness({ controlled: true, receiptDelayMs: RECEIPT_DELAY_MS, outDir: join(outDir, "phase-a") });
  report.environmentA = { outDir: h.outDir, receiptDelayMs: RECEIPT_DELAY_MS };

  try {
    await h.panel("globalThis.__tbProbe.clicks.length = 0");

    for (let i = 1; i <= SAMPLES; i += 1) {
      await h.setInput(`第 ${i} 次：看一下这个页面的要点`);
      const clickIndex = (await h.panel("globalThis.__tbProbe.clicks.length")) as number;
      await h.click("#send-btn");

      const request = await Promise.race([
        h.nextRequest(),
        sleep(5_000).then(() => { throw new Error(`第 ${i} 次点击没有产生 task_action`); }),
      ]).catch(async (error) => {
        report.firstLocalFeedback.diagnostics = {
          index: i,
          sendButton: await h.panel("document.querySelector('#send-btn')?.className"),
          sendTitle: await h.panel("document.querySelector('#send-btn')?.title"),
          inputValue: await h.panel("document.querySelector('#input')?.value"),
          outgoing: await h.panel("JSON.stringify((globalThis.__tbProbe.outgoing ?? []).slice(-4))"),
          clicks: await h.panel("JSON.stringify((globalThis.__tbProbe.allClicks ?? []).slice(-6))"),
          received: h.receivedRequests,
          pageErrors: h.pageErrors.slice(-3),
        };
        throw error;
      }).catch((error) => {
        report.firstLocalFeedback.failures.push(String(error));
        console.error("A 相中断：", String(error), JSON.stringify(report.firstLocalFeedback.diagnostics));

        return null;
      });

      if (!request) break;
      // 受控服务延迟回执：这段窗口里只允许「发送中」。
      await sleep(Math.min(150, RECEIPT_DELAY_MS - 100));

      const duringWindow = await h.panel(`(() => {
        const bar = document.querySelector('#task-bar-root');
        return { text: bar ? bar.textContent : null, matStatus: bar ? (bar.querySelector('.tb-mat-status')?.textContent ?? null) : null };
      })()`);

      const timer = setTimeout(() => h.sendReceipt(request.requestId, "accepted", "已接收新任务"), RECEIPT_DELAY_MS);

      try {
        // 等这一条的受控回执真的落到界面上（既不能提前写已接收，也不能停在上一条的状态）。
        await until(async () => {
          const text = (await h.panel("document.querySelector('#task-bar-root')?.textContent ?? ''")) as string;

          return text.includes("已随任务送入") && !text.includes("发送中") ? text : undefined;
        }, 4_000, `第 ${i} 次回执升级`);
      } catch (error) {
        report.firstLocalFeedback.failures.push(`第 ${i} 次：${String(error)}`);
      } finally {
        clearTimeout(timer);
      }

      await sleep(80); // 让本地反馈帧稳定后再采下一次
      const click = (await h.panel(`(() => { const c = globalThis.__tbProbe.clicks[${clickIndex}]; return c ? { at: c.at, renderedAt: c.renderedAt, frameAt: c.frameAt, statusText: c.statusText, barHidden: c.barHidden } : null; })()`)) as { at: number; renderedAt: number | null; frameAt: number | null; statusText: string | null; barHidden: boolean | null } | null;

      if (!click || click.frameAt === null) {
        report.firstLocalFeedback.failures.push(`第 ${i} 次：探针没拿到点击帧时间`);
        continue;
      }

      const sample = {
        index: i,
        ms: round(click.frameAt - click.at),
        renderMs: click.renderedAt === null ? null : round(click.renderedAt - click.at),
        statusTextAtFrame: click.statusText,
        duringWindow: duringWindow?.matStatus ?? null,
      };

      report.firstLocalFeedback.samples.push(sample);

      if (!/发送中|尚未确认接收/.test(String(sample.statusTextAtFrame))) {
        report.firstLocalFeedback.failures.push(`第 ${i} 次下一帧文案不是发送中：${String(sample.statusTextAtFrame)}`);
      }

      if (/已接收/.test(String(sample.statusTextAtFrame)) || /已接收/.test(String(sample.duringWindow))) {
        report.firstLocalFeedback.failures.push(`第 ${i} 次在回执前出现「已接收」`);
      }
    }

    const values = report.firstLocalFeedback.samples.map((s: { ms: number }) => s.ms);
    report.firstLocalFeedback.n = values.length;
    report.firstLocalFeedback.medianMs = round(median(values));
    report.firstLocalFeedback.p95Ms = round(percentile(values, 0.95));
    report.firstLocalFeedback.maxMs = round(values.length ? Math.max(...values) : null);
    report.firstLocalFeedback.pass = values.length === SAMPLES && report.firstLocalFeedback.failures.length === 0 && (report.firstLocalFeedback.p95Ms ?? Infinity) <= 150;
  } finally {
    await h.close();
  }
}

// ── B 相：权威事件→UI 帧 ───────────────────────────────────────────
if (PHASE === "b" || PHASE === "both") {
  const h = await startTaskBarHarness({ controlled: false, outDir: join(outDir, "phase-b") });
  report.environmentB = { outDir: h.outDir, modelCalls: 0 };

  try {
    await h.panel("globalThis.__tbProbe.views.length = 0; globalThis.__tbProbe.observing = true;");
    // 先让面板看到一个真实起点视图（goal 来自真实 requirement，由面板发送时带上页面上下文）。
    await h.setInput("T03 指标 B 相：真实投影计时");
    await h.click("#send-btn");

    const startView = await until(async () => {
      const view = (await h.panel("globalThis.__tbProbe.views.at(-1) ?? null")) as { goal: string | null; state: string } | null;

      return view ?? undefined;
    }, 10_000, "B 相起点视图").catch((error) => {
      report.authoritativeToFrame.failures.push(`B 相起点视图缺失：${String(error)}`);

      return null;
    });

    report.authoritativeToFrame.startView = startView ?? null;
    // 真实 run 开始（runtime 桩按产品事件格式报告），让状态层进入 running：指标量的就是这种常态。
    h.emitRuntime({ type: "agent_event", conversationId: "default", event: { kind: "agent_start" } });
    await sleep(300);
    report.authoritativeToFrame.runningView = await h.panel("globalThis.__tbProbe.views.at(-1) ?? null");
    await h.panel("globalThis.__tbProbe.views.length = 0;");
    let attempts = 0;

    while (report.authoritativeToFrame.samples.length < SAMPLES && attempts < SAMPLES * 4) {
      attempts += 1;
      const before = (await h.panel("globalThis.__tbProbe.views.length")) as number;
      h.emitRuntime({
        type: "agent_event",
        conversationId: "default",
        event: { kind: "tool_start", name: "read_page", toolCallId: `perf-${attempts}`, params: {} },
      });
      let view: { receivedAt: number; renderedAt: number | null; frameAt: number | null };

      try {
        view = await until(async () => {
          const picked = await h.panel(`(() => { const v = globalThis.__tbProbe.views[${before}]; return v && v.frameAt !== null ? { receivedAt: v.receivedAt, renderedAt: v.renderedAt, frameAt: v.frameAt, state: v.state } : null; })()`);

          return picked ?? undefined;
        }, 5_000, "视图帧");
      } catch (error) {
        report.authoritativeToFrame.failures.push(`第 ${report.authoritativeToFrame.samples.length + 1} 次：${String(error)}`);
        continue;
      }

      report.authoritativeToFrame.samples.push({
        index: report.authoritativeToFrame.samples.length + 1,
        receivedToRenderMs: round(view.renderedAt! - view.receivedAt),
        ms: round(view.frameAt! - view.receivedAt),
        state: String((view as { state?: string }).state ?? ""),
      });
      // 收掉这次工具，保持下一步与真实工具序列一致（也会产生一个不计入本轮的视图）。
      h.emitRuntime({ type: "agent_event", conversationId: "default", event: { kind: "tool_end", name: "read_page", toolCallId: `perf-${attempts}`, isError: false, executionFact: "executed" } });
      await sleep(30);
    }

    const values = report.authoritativeToFrame.samples.map((s: { ms: number }) => s.ms);
    report.authoritativeToFrame.n = values.length;
    report.authoritativeToFrame.medianMs = round(median(values));
    report.authoritativeToFrame.p95Ms = round(percentile(values, 0.95));
    report.authoritativeToFrame.maxMs = round(values.length ? Math.max(...values) : null);
    report.authoritativeToFrame.pass = values.length === SAMPLES && report.authoritativeToFrame.failures.length === 0 && (report.authoritativeToFrame.p95Ms ?? Infinity) <= 200;
  } finally {
    await h.close();
  }
}

report.finishedAt = new Date().toISOString();

report.ok = [
  PHASE === "b" ? true : report.firstLocalFeedback.pass === true,
  PHASE === "a" ? true : report.authoritativeToFrame.pass === true,
].every(Boolean);

writeFileSync(join(outDir, "perf.json"), `${JSON.stringify(report, null, 2)}\n`);

const line = (label: string, block: any): string => `| ${label} | ${block.n ?? 0}/50 | ${block.medianMs ?? "-"}ms | P95 ${block.p95Ms ?? "-"}ms | max ${block.maxMs ?? "-"}ms | ${block.pass ? "PASS" : "FAIL"} |`;

const md = `# T03 指标采样（tsx scripts/acceptance/task-bar-perf.mts --headless）

时间：${report.startedAt} → ${report.finishedAt}

| 指标 | 样本 | 中位 | P95 | 最大 | 判定 |
|---|---:|---|---|---|---|
${line("首次本地反馈（点击→下一帧本地状态）", report.firstLocalFeedback)}
${line("权威事件→UI 帧（面板收到 task_view→对应帧）", report.authoritativeToFrame)}

- A 相边界：${report.boundary.phaseA}
- B 相边界：${report.boundary.phaseB}
- 帧口径：${report.boundary.frame}
- A 相失败项：${report.firstLocalFeedback.failures.length ? report.firstLocalFeedback.failures.join("；") : "无"}
- B 相失败项：${report.authoritativeToFrame.failures.length ? report.authoritativeToFrame.failures.join("；") : "无"}
- 缺口：传输段（WS→background）与渲染段分开记录，不合并成单次模型等待；本采样不覆盖真实站点网络与模型耗时。
`;

writeFileSync(join(outDir, "perf.md"), md);

console.log(JSON.stringify({
  outDir,
  firstLocalFeedback: { n: report.firstLocalFeedback.n, p95Ms: report.firstLocalFeedback.p95Ms, pass: report.firstLocalFeedback.pass, failures: report.firstLocalFeedback.failures },
  authoritativeToFrame: { n: report.authoritativeToFrame.n, p95Ms: report.authoritativeToFrame.p95Ms, pass: report.authoritativeToFrame.pass, failures: report.authoritativeToFrame.failures },
  ok: report.ok,
}, null, 2));

if (!report.ok) process.exitCode = 1;
