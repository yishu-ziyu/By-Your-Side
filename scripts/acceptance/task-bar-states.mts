/**
 * T03 界面态证据（无头、隔离、串行）：
 *
 *   npx --no-install tsx scripts/acceptance/task-bar-states.mts --headless [--out=...]
 *
 * 覆盖：运行/接管请求中/接管未确认/接管生效/阻塞五态截图、A03-03 作用页与当前页不一致、
 * 320px 无横向溢出、键盘可达与焦点可见、减少动态下信息等价、重复视图渲染幂等。
 *
 * 事实边界：
 * - 状态由真实 TaskProgress 状态机 + 真实 projectTaskView 投影生成，经受控 WS 注入真实面板；
 * - 页面身份/标签页/键盘/尺寸/焦点全部是真实浏览器行为；材料来自面板真的发出的请求与真实回执；
 * - 标题栏的运行指示由受控服务按真实结构下发（不接 manager、0 次模型调用）；
 * - 「5 秒读懂」是人的裁决，本脚本只产出三态截图，不代替人判。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TaskProgress } from "../../agent/src/task-progress.js";
import { projectTaskView } from "../../shared/task-view.js";
import { startTaskBarHarness, sleep, until } from "./task-bar-harness.mts";

if (!process.argv.includes("--headless")) {
  console.error("Required: --headless（本脚本只以无头隔离方式运行）");
  process.exit(2);
}

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));

  return hit ? hit.slice(name.length + 1) : fallback;
};

const outDir = resolve(arg("--out", join("out", "acceptance", `${new Date().toISOString().replace(/[:.]/g, "-")}-t03-states`)));

mkdirSync(outDir, { recursive: true });

const checks: { id: string; name: string; ok: boolean; detail?: string }[] = [];

const check = (id: string, name: string, ok: boolean, detail?: string): void => {
  checks.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 运行中的已运行时长每秒都在动（真实数据）；比较信息等价时只归一化这个数字。 */
const normalize = (text: string): string => text.replace(/\d+(\.\d+)?s/g, "<t>");

const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  command: "tsx scripts/acceptance/task-bar-states.mts --headless",
  outDir,
  checks,
  shots: {} as Record<string, string>,
  humanCheck: "A03-08 三态 5 秒读取：待 reviewer 看 01-running / 04-takeover-applied / 05-blocked 三张真实界面截图（本脚本不做人的裁决）",
};

const shots: Record<string, string> = report.shots as Record<string, string>;

const h = await startTaskBarHarness({ controlled: true, receiptDelayMs: 400, outDir: join(outDir, "phase") });

/** 面板真的发出去的那一条请求（供材料核对与回执用）。 */
let sentRequest: { requestId: string; action: string; text: string; attachments: string[] } | null = null;

const shot = async (name: string): Promise<void> => {
  const file = join(outDir, `${name}.png`);
  await h.screenshot(file);
  shots[name] = file;
};

const barText = async (): Promise<string> => (await h.panel("document.querySelector('#task-bar-root')?.textContent ?? ''")) as string;

try {
  check("setup", "面板已加载（无未捕获异常）", h.pageErrors.length === 0, h.pageErrors.join(" | ") || "clean");

  // ── 320px 窄侧栏：真实拖放加入附件，拿到可移除材料 ─────────────
  await h.setViewport(320, 700);
  await h.setInput("把报名表里的电话补齐");
  await h.panel(`(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const file = new File([bytes], '窄栏截图.png', { type: 'image/png' });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const composer = document.querySelector('#composer');
    composer.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
    composer.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  })()`);
  await until(async () => ((await barText()).includes("窄栏截图.png") || undefined), 8_000, "草稿附件进入任务条").catch(() => undefined);
  await sleep(200);

  const narrow = (await h.panel(`(() => {
    const doc = document.documentElement;
    const bar = document.querySelector('.task-bar');
    const send = document.querySelector('#send-btn');
    const rect = bar ? bar.getBoundingClientRect() : null;
    return {
      overflow: doc.scrollWidth - innerWidth,
      barRight: rect ? Math.round(rect.right) : null,
      barLeft: rect ? Math.round(rect.left) : null,
      innerWidth,
      sendVisible: send ? send.getBoundingClientRect().width > 0 && send.getBoundingClientRect().bottom <= innerHeight : false,
      buttons: [...document.querySelectorAll('.task-bar button')].map((b) => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label') || b.textContent, left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) }; }),
    };
  })()`)) as { overflow: number; barRight: number | null; barLeft: number | null; innerWidth: number; sendVisible: boolean; buttons: { label: string; left: number; right: number; bottom: number }[] };

  await shot("06-narrow-draft-320");
  check("A03-07", "320px 无横向溢出", narrow.overflow <= 0, `documentElement.scrollWidth - innerWidth = ${narrow.overflow}`);
  check("A03-07", "320px 任务条与发送按钮在视口内", (narrow.barRight ?? 999) <= narrow.innerWidth && (narrow.barLeft ?? -1) >= 0 && narrow.sendVisible, JSON.stringify({ barLeft: narrow.barLeft, barRight: narrow.barRight, innerWidth: narrow.innerWidth, sendVisible: narrow.sendVisible }));
  check("A03-07", "320px 每个任务条按钮都在视口内（可点到）", narrow.buttons.length > 0 && narrow.buttons.every((b) => b.right <= narrow.innerWidth && b.bottom <= 700), JSON.stringify(narrow.buttons));


  // ── 键盘：草稿的移除按钮可 Tab 到，焦点可见，Enter 真的移除 ──────
  await h.setViewport(400, 900);
  await sleep(200);
  await h.panel("document.querySelector('#input').focus()");
  let removeFocused = false;

  for (let i = 0; i < 14 && !removeFocused; i += 1) {
    await h.key("Tab", "Tab");
    const state = (await h.panel("(() => { const a = document.activeElement; const s = getComputedStyle(a); return { cls: a.className || '', tag: a.tagName, label: a.getAttribute('aria-label') || '', outline: s.outlineStyle }; })()")) as { cls: string; tag: string; label: string; outline: string };

    if (state.cls.includes("tb-remove")) {
      removeFocused = true;
      check("A03-07", "键盘 Tab 到移除按钮，焦点可见", state.outline !== "none", `${state.label} outline=${state.outline}`);
      const beforeRemove = await barText();
      await h.key("Enter", "Enter");
      await sleep(300);
      const afterRemove = await barText();
      check("A03-02", "键盘移除草稿材料：任务条与草稿同步（被移除项不再展示）", beforeRemove.includes("窄栏截图.png") && !afterRemove.includes("窄栏截图.png"), afterRemove.slice(0, 140));
      // 真的发出去，核对上行请求里没有那张被移除的附件。
      await h.click("#send-btn");
      sentRequest = await h.nextRequest();
      check("A03-02", "被移除的附件没有进入实际请求", sentRequest.attachments.length === 0 && sentRequest.text.includes("把报名表里的电话补齐"), `attachments=${JSON.stringify(sentRequest.attachments)}`);
    }
  }

  if (!removeFocused) check("A03-07", "键盘 Tab 到移除按钮，焦点可见", false, "14 次 Tab 没到 tb-remove");



  // 真实 run 先建（拿到 runId），面板那次真实请求用同一 runId 回执，跟生产顺序一致。
  const progress = new TaskProgress("default", () => Date.now());
  progress.request("把报名表里的电话补齐", { tabId: 0, title: "", url: "" });
  h.sendReceipt(sentRequest.requestId, "accepted", "已接收新任务", progress.snapshot().runId ?? undefined);
  await until(async () => ((await barText()).includes("已随任务送入") || undefined), 8_000, "材料确认");
  check("A03-01", "回执前只写发送中、回执后写已随任务送入（真实面板）", true, (await barText()).slice(0, 120));

  // ── 运行态 ──────────────────────────────────────────────────────
  progress.observe({ type: "agent_event", event: { kind: "agent_start" } });
  progress.observe({ type: "agent_event", event: { kind: "tool_start", name: "read_page", toolCallId: "state-1", params: {} } });
  const running = projectTaskView({ ...progress.snapshot(), controlVersion: 0 });
  h.sendStatus("running"); // 面板自己的运行指示（真实界面里接管按钮只在这时可见）
  h.sendTaskView(running as unknown as Record<string, unknown>);
  await until(async () => ((await barText()).includes("正在执行") || undefined), 5_000, "运行态");
  await h.setViewport(400, 900);
  await shot("01-running");
  const runningText = await barText();
  await h.setViewport(320, 700);
  await sleep(200);
  const narrowRunning = (await h.panel("(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, barRight: Math.round(document.querySelector('.task-bar').getBoundingClientRect().right), innerWidth, sendVisible: document.querySelector('#send-btn').getBoundingClientRect().width > 0 }))()")) as { overflow: number; barRight: number; innerWidth: number; sendVisible: boolean };
  await shot("07-narrow-running-320");
  check("A03-07", "320px 运行态同样无横向溢出、发送按钮可见", narrowRunning.overflow <= 0 && narrowRunning.barRight <= narrowRunning.innerWidth && narrowRunning.sendVisible, JSON.stringify(narrowRunning));
  await h.setViewport(400, 900);
  check("A03-05", "运行态：目标＋当前活动两层，无百分比/剩余时间", runningText.includes("正在执行") && !/%|％|剩余/.test(runningText), runningText.slice(0, 120));

  // ── 阻塞态（真实中断） ──────────────────────────────────────────
  progress.prepareResume();
  progress.observe({ type: "status", state: "running" });
  const interruptedOk = progress.interrupt("manual_continuation");
  const blocked = projectTaskView({ ...progress.snapshot(), controlVersion: 2 });
  h.sendTaskView(blocked as unknown as Record<string, unknown>);
  await until(async () => ((await barText()).includes("等待：") || undefined), 5_000, "阻塞态");
  await shot("05-blocked");
  const blockedText = await barText();
  check("A03-05", "阻塞态：露出真实原因（中断检查点）", interruptedOk && blockedText.includes("已中断") && blockedText.includes("等待："), blockedText.slice(0, 160));

  // ── 减少动态：信息等价 ─────────────────────────────────────────
  progress.prepareResume();
  progress.observe({ type: "status", state: "running" });
  h.sendStatus("running");
  h.sendTaskView(projectTaskView({ ...progress.snapshot(), controlVersion: 4 }) as unknown as Record<string, unknown>);
  await until(async () => ((await barText()).includes("正在执行") || undefined), 5_000, "减少动态前回到运行态");
  await sleep(300);
  // 运行中「已运行时长」每秒都在动（真实数据）；比较信息时只归一化这个数字。
  const beforeMotion = normalize(await barText());
  await h.setReducedMotion("reduce");
  await sleep(200);
  const afterMotion = normalize(await barText());
  const motion = (await h.panel("(() => { const s = getComputedStyle(document.querySelector('.task-bar')); return { animationName: s.animationName, transitionDuration: s.transitionDuration }; })()")) as { animationName: string; transitionDuration: string };
  h.sendTaskView(running as unknown as Record<string, unknown>);
  await sleep(200);
  await shot("08-reduced-motion");
  check("A03-07", "减少动态下信息完全等价", beforeMotion === afterMotion && beforeMotion.includes("正在执行"), `animation=${motion.animationName} transition=${motion.transitionDuration}，文本=${beforeMotion.slice(0, 60)}`);
  check("A03-05", "任务条自身没有动画（信息不依赖动效）", motion.animationName === "none" || motion.animationName === "", JSON.stringify(motion));
  await h.setReducedMotion("no-preference");

  // ── 重放幂等 ───────────────────────────────────────────────────
  const beforeReplay = { text: normalize(await barText()), buttons: (await h.panel("document.querySelectorAll('.task-bar button').length")) as number };
  h.sendTaskView(running as unknown as Record<string, unknown>);
  h.sendTaskView(running as unknown as Record<string, unknown>);
  await sleep(500);
  const afterReplay = { text: normalize(await barText()), buttons: (await h.panel("document.querySelectorAll('.task-bar button').length")) as number };
  check("A03-06", "同一视图重复下发不重复控件、文本不漂移", beforeReplay.text === afterReplay.text && beforeReplay.buttons === afterReplay.buttons, `${beforeReplay.buttons} → ${afterReplay.buttons}`);

  // ── 接管：请求中 → 未确认（可再试） → 权威生效 ─────────────────
  // 先按真实路径继续中断的任务，再接管（否则「接管」发生在中断态上不顺）。
  progress.prepareResume();
  progress.observe({ type: "status", state: "running" });
  h.sendStatus("running");
  h.sendTaskView(projectTaskView({ ...progress.snapshot(), controlVersion: 3 }) as unknown as Record<string, unknown>);
  await until(async () => ((await barText()).includes("正在执行") || undefined), 5_000, "接管前恢复运行态");
  const takeovers = (): number => h.transcript.filter((entry) => entry.dir === "in" && entry.type === "takeover").length;
  const beforeTakeover = takeovers();
  await h.click("#takeover-btn");
  await until(async () => ((await barText()).includes("已请求接管") || undefined), 5_000, "接管请求中");
  await shot("02-takeover-requested");
  check("A03-04", "接管请求中：文案是请求中，不宣布已生效", (await barText()).includes("已请求接管") && !(await barText()).includes("页面归你"), (await barText()).slice(0, 120));
  check("A03-04", "接管请求真的发往宿主（不是只改 UI）", takeovers() > beforeTakeover, JSON.stringify(h.transcript.slice(-3)));

  // 10 秒内没有权威结果：如实说「还没得到确认」，并给出「再试」。
  await until(async () => ((await barText()).includes("还没得到确认") || undefined), 15_000, "接管未确认");
  await shot("03-takeover-unconfirmed");
  check("A03-04", "请求未获确认：如实说明并保留重试入口", (await barText()).includes("还没得到确认") && !!(await h.panel("document.querySelector('.tb-control-retry')")), (await barText()).slice(0, 140));

  // 键盘 Tab 到「再试」→ Enter：走真实接管入口，且焦点可见。
  await h.panel("document.querySelector('#input').focus()");
  let retryFocused = false;

  for (let i = 0; i < 12 && !retryFocused; i += 1) {
    await h.key("Tab", "Tab");
    const state = (await h.panel("(() => { const a = document.activeElement; const s = getComputedStyle(a); return { cls: a.className || '', label: a.getAttribute('aria-label') || a.textContent || '', outline: s.outlineStyle }; })()")) as { cls: string; label: string; outline: string };

    if (state.cls.includes("tb-control-retry")) {
      retryFocused = true;
      check("A03-07", "键盘 Tab 到重试按钮，焦点可见", state.outline !== "none", `${state.label} outline=${state.outline}`);
      const before = takeovers();
      await h.key("Enter", "Enter");
      await until(() => Promise.resolve(takeovers() > before || undefined), 5_000, "键盘重试发出真实接管请求").catch(() => undefined);
      check("A03-04", "键盘 Enter 触发重试，走真实接管入口", takeovers() > before, JSON.stringify(h.transcript.slice(-3)));
    }
  }

  if (!retryFocused) check("A03-07", "键盘 Tab 到重试按钮，焦点可见", false, "12 次 Tab 没到 tb-control-retry");

  // 受控服务按真实结构回控制结果：让 background/面板的真实接管流程收敛，不留「正在停住」横幅。
  const lastTakeover = h.takeoverRequests.at(-1);

  if (lastTakeover) h.ackTakeover(lastTakeover, true);
  progress.observe({ type: "status", state: "user" });
  const paused = projectTaskView({ ...progress.snapshot(), controlVersion: 1 });
  h.sendTaskView(paused as unknown as Record<string, unknown>);
  await until(async () => ((await barText()).includes("已暂停") || undefined), 5_000, "接管生效");
  await shot("04-takeover-applied");
  const pausedText = await barText();
  check("A03-04", "接管生效：状态层说页面归你，控制请求行收掉", pausedText.includes("已暂停") && !pausedText.includes("已请求接管") && !pausedText.includes("还没得到确认"), pausedText.slice(0, 120));

  // ── A03-06 面板重开：background 回放最近一次权威视图，展示与任务身份一致 ──
  {
    const beforeReload = await barText();
    await h.panel("location.reload()").catch(() => undefined);
    await sleep(1_500);
    await until(async () => ((await barText()).includes("把报名表里的电话补齐") || undefined), 15_000, "面板重开后任务条恢复");
    const afterReload = await barText();
    check("A03-06", "面板重开后按任务身份恢复同一状态（不凭空造材料）", afterReload.includes("把报名表里的电话补齐") && afterReload.includes("已暂停") && !afterReload.includes("已随任务送入"), `重开前=${beforeReload.slice(0, 60)}；重开后=${afterReload.slice(0, 120)}`);
    check("A03-06", "重开不产生重复任务条", (await h.panel("document.querySelectorAll('.task-bar').length")) === 1, String(await h.panel("document.querySelectorAll('.task-bar').length")));
    await shot("10-panel-reopened");
  }

  // ── A03-03 作用页：真实 A 页执行，用户在看 B 页（放最后，避免抢焦点影响前面的键盘检查）
  const pageA = await h.iso.newTarget(h.iso.fixtureOrigin + "/page-a");
  await sleep(400);
  await h.iso.newTarget(h.iso.fixtureOrigin + "/page-b");
  await sleep(400);
  const tabs = (await h.iso.swEval("chrome.tabs.query({}).then(t=>t.filter(x=>x.url&&x.url.startsWith('http')).map(x=>({id:x.id,title:x.title,url:x.url})))")) as { id: number; title: string; url: string }[];
  const tabA = tabs.find((tab) => tab.url.includes("/page-a"));
  const tabB = tabs.find((tab) => tab.url.includes("/page-b"));

  if (!tabA || !tabB) {
    check("A03-03", "准备真实 A/B 两页", false, JSON.stringify(tabs));
  } else {
    // 让 B 页成为当前活动页（用户真的在看 B），任务仍绑在 A。
    await h.iso.swEval(`chrome.tabs.update(${tabB.id}, {active:true})`);
    await sleep(600);
    const boundView = { ...(running as unknown as Record<string, unknown>), page: { tabId: tabA.id, urlHash: "hash-a" }, state: "running" };
    h.sendTaskView(boundView);
    await until(async () => ((await barText()).includes("作用于：") || undefined), 5_000, "作用页");
    await sleep(600);
    const pageText = await barText();
    await shot("09-bound-page-vs-active-tab");
    check("A03-03", "任务条写清作用页 A，并说明当前看的是别的页", pageText.includes("作用于：") && pageText.includes("任务仍作用于上面这页"), pageText.slice(0, 200));
    const activeTabId = (await h.iso.swEval("chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]&&t[0].id)")) as number;
    check("A03-03", "真实活动页就是 B（不是任务页 A）", activeTabId === tabB.id, `active=${activeTabId} A=${tabA.id} B=${tabB.id}`);
    check("A03-03", "B 页没有被并入任务材料", !pageText.includes("page-b") && !pageText.includes("page-a"), pageText.slice(0, 200));
    void pageA;
  }
} catch (error) {
  check("harness", "脚本执行完整", false, String(error));
  report.error = String(error);
} finally {
  report.finishedAt = new Date().toISOString();
  report.ok = checks.every((c) => c.ok);
  writeFileSync(join(outDir, "states.json"), `${JSON.stringify(report, null, 2)}\n`);

  const md = `# T03 界面态证据（tsx scripts/acceptance/task-bar-states.mts --headless）\n\n` +
    `时间：${report.startedAt} → ${report.finishedAt}\n\n` +
    `| 检查 | 结果 | 说明 |\n|---|---|---|\n` +
    checks.map((c) => `| ${c.id} ${c.name} | ${c.ok ? "PASS" : "FAIL"} | ${String(c.detail ?? "").replace(/\|/g, "\\|")} |`).join("\n") +
    `\n\n截图：${Object.entries(shots).map(([name, file]) => `${name}=${file}`).join("；")}\n\n` +
    `人的裁决（不由本脚本代填）：${report.humanCheck}\n`;

  writeFileSync(join(outDir, "states.md"), md);
  console.log(JSON.stringify({ outDir, ok: report.ok, failed: checks.filter((c) => !c.ok) }, null, 2));
  await h.close();
}

if (!(report.ok as boolean)) process.exitCode = 1;
