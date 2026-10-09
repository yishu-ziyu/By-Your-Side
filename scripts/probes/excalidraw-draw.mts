/**
 * 一次性测量（不提交）：用户一句话让助手在 excalidraw.com 上画流程图，今天表现如何。
 *
 *   npx tsx scripts/probes/excalidraw-draw.mts --headless [--model=provider/id]
 *   npx tsx scripts/probes/excalidraw-draw.mts --daily   # 用户日常 Chrome（9222），需用户本人同意
 *
 * --daily：只新开一个 Excalidraw 标签页，用已装的日常扩展和用户已选的模型；不改设置、不重载扩展、不读凭据，
 * 结束时不关这个标签页，留给用户看。
 *
 * 隔离无头 Chrome 只装扩展，真实模型（默认 DEFAULT_TEST_MODEL）。两轮同一会话：先画图，再把第二步改红。
 * 每轮记：首个工具/首个页面操作耗时、整轮耗时、全部工具调用（取自设置页导出的诊断记录）、模型请求数；
 * 结果从 Excalidraw 存在 localStorage「excalidraw」里的元素读出。证据写到 out/acceptance/excalidraw-probe/<时间>/。
 * 不打印、不保存任何密钥。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, attachDailyChrome, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, sleep, until, watchInproc, type InprocRequest } from "../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "../acceptance/real-path/inproc-config.mts";

const daily = process.argv.includes("--daily");

if (!daily) requireHeadless();

const modelArg = process.argv.find((a) => a.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;
const TURN_LIMIT_MS = 5 * 60_000;
const startedAt = new Date();
const out = join(REPO, "out/acceptance/excalidraw-probe", startedAt.toISOString().replace(/[:.]/g, "-"));
await mkdir(out, { recursive: true });

const PROMPTS = [
  { id: "draw", text: "在这个画板上画一个登录流程图：输入账号 → 输入密码 → 点登录 → 进入首页，每一步一个方框，用箭头连起来。" },
  { id: "recolor", text: "把第二步改成红色。" },
];

const PROVIDER_HOSTS: Record<string, string> = { stepfun: "api.stepfun.com", "zai-coding-cn": "open.bigmodel.cn", "opencode-go": "opencode.ai", "openai-codex": "chatgpt.com", "kimi-coding": "api.kimi.com", "minimax-cn": "api.minimaxi.com" };
const isModelCall = (r: InprocRequest) => r.method === "POST" && Object.values(PROVIDER_HOSTS).includes(new URL(r.url).host);

/** 会改动页面的工具（「首个页面操作」按这些算）。 */
const PAGE_ACTIONS = new Set(["click", "double_click", "drag", "type_text", "press_key", "fill", "js", "browser_run", "cdp", "page_operation", "scroll", "hover", "upload_file"]);

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    running: q("#status-pill")?.classList.contains("running") ?? false,
    stopping: q("#send-btn")?.classList.contains("stopping") ?? false,
    streaming: !!q(".msg.assistant.streaming, .msg.assistant[data-revealing]"),
    inputValue: q("#input")?.value ?? null,
    userMessages: document.querySelectorAll(".msg.user").length,
    answers: [...document.querySelectorAll("#messages .msg.assistant")].map((el) => el.innerText.trim()).filter(Boolean),
    chips: [...document.querySelectorAll("#messages .chip")].map((el) => el.innerText.trim().replace(/\\s+/g, " ")),
    errors: [...document.querySelectorAll("#messages .msg.error")].map((el) => el.innerText.trim()),
    notices: [...document.querySelectorAll("#messages .msg.notice")].map((el) => el.innerText.trim()),
  };
})()`;

type PanelState = { connected: boolean; running: boolean; stopping: boolean; streaming: boolean; inputValue: string | null; userMessages: number; answers: string[]; chips: string[]; errors: string[]; notices: string[] };

type SceneElement = { id: string; type: string; x: number; y: number; w: number; h: number; strokeColor: string; backgroundColor: string; text: string | null; containerId: string | null; startBinding: string | null; endBinding: string | null };

const READ_SCENE = `(() => {
  const raw = localStorage.getItem("excalidraw");
  if (!raw) return null;
  return JSON.parse(raw).filter((e) => !e.isDeleted).map((e) => ({
    id: e.id, type: e.type, x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height),
    strokeColor: e.strokeColor, backgroundColor: e.backgroundColor,
    text: e.type === "text" ? (e.originalText ?? e.text) : null, containerId: e.containerId ?? null,
    startBinding: e.startBinding?.elementId ?? null, endBinding: e.endBinding?.elementId ?? null,
  }));
})()`;

/** 红色系：色相在 0–20° 或 340–360°，饱和度够、不是近白。 */
function isReddish(color: string): boolean {
  const c = color.trim().toLowerCase();

  if (c === "red") return true;
  const m = c.match(/^#([0-9a-f]{6})$/) ?? c.match(/^#([0-9a-f]{3})$/);

  if (!m) return false;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;

  if (d === 0 || l > 0.95) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;

  return s > 0.3 && (h <= 20 || h >= 340);
}

function summarizeScene(scene: SceneElement[] | null) {
  if (!scene) return { stored: false };
  const count = (types: string[]) => scene.filter((e) => types.includes(e.type)).length;
  const shapes = scene.filter((e) => ["rectangle", "ellipse", "diamond"].includes(e.type));
  const texts = scene.filter((e) => e.type === "text");

  /** 文字所在的方框：先看 containerId，再看文字中心落在哪个方框里。 */
  const shapeOf = (t: SceneElement) => shapes.find((s) => s.id === t.containerId) ?? shapes.find((s) => t.x + t.w / 2 >= s.x && t.x + t.w / 2 <= s.x + s.w && t.y + t.h / 2 >= s.y && t.y + t.h / 2 <= s.y + s.h);
  const password = texts.filter((t) => t.text?.includes("输入密码")).map((t) => {
    const shape = shapeOf(t);

    return { textColor: t.strokeColor, textRed: isReddish(t.strokeColor), shape: shape ? { type: shape.type, strokeColor: shape.strokeColor, backgroundColor: shape.backgroundColor, red: isReddish(shape.strokeColor) || isReddish(shape.backgroundColor) } : null };
  });

  return {
    stored: true,
    total: scene.length,
    byType: Object.fromEntries([...new Set(scene.map((e) => e.type))].map((t) => [t, scene.filter((e) => e.type === t).length])),
    boxes: count(["rectangle", "ellipse", "diamond"]),
    arrows: count(["arrow", "line"]),
    boundArrows: scene.filter((e) => e.type === "arrow" && e.startBinding && e.endBinding).length,
    texts: texts.map((t) => t.text),
    textsInBoxes: texts.filter((t) => shapeOf(t)).length,
    password,
  };
}

const rp = daily ? await attachDailyChrome() : await launchRealPath({ withoutNativeHost: true });
let inproc: Awaited<ReturnType<typeof watchInproc>> | null = null;
let secrets: string[] = [];
const turns: Record<string, unknown>[] = [];
const result: Record<string, unknown> = { case: "excalidraw-probe", startedAt: startedAt.toISOString(), model: daily ? "daily: user's configured model" : modelArg, browser: daily ? `daily Chrome (${rp.browser})` : rp.browser, turns };

try {
  // 日常模式：attachDailyChrome 新开的那个标签页；用户原有标签页不碰。
  const blank = "workTargetId" in rp ? { targetId: rp.workTargetId } : await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: "https://excalidraw.com" }, work);
  const canvasAt = Date.now();
  await until(async () => (await rp.evaluate(work, `!!document.querySelector(".excalidraw canvas")`).catch(() => false)) || undefined, 60_000, "Excalidraw 画布");
  result.canvasMs = Date.now() - canvasAt;
  await sleep(2000);
  result.sceneBefore = summarizeScene((await rp.evaluate(work, READ_SCENE).catch(() => null)) as SceneElement[] | null);
  await rp.screenshot(work, join(out, "page-0-start.png"));

  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // SAFETY: PANEL_STATE 返回的字段与 PanelState 一一对应。
  const readPanel = async () => (await rp.evaluate(panel, PANEL_STATE)) as PanelState;
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector("#header-more")`).catch(() => false)) || undefined, 15_000, "侧栏渲染");

  if (daily) {
    // 用户已选的模型：读侧栏模型按钮上的名字，不改设置。
    result.panelModel = String(await rp.evaluate(panel, `document.querySelector("#model-name")?.textContent?.trim() ?? ""`).catch(() => ""));
    result.configure = "daily：沿用用户已配置的模型，未改设置";
    inproc = await watchInproc(rp, rp.extensionId).catch(() => null);
  } else if (!("workTargetId" in rp)) {
    inproc = await watchInproc(rp, rp.extensionId);
    const plan = await loadModelPlan(modelArg);
    secrets = [plan.credential.key, plan.credential.access, plan.credential.refresh].filter((v): v is string => typeof v === "string" && v.length > 8);

    if (plan.credential.type === "oauth") {
      await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
      result.configure = "订阅登录：直接写入扩展存储（设置页不支持订阅登录）";
    } else {
      const run = await configureViaSettings(rp, panel, plan);
      result.configure = { testStatus: run.testStatus, saveStatus: run.saveStatus };

      if (!run.testStatus.startsWith("连接正常")) throw new Error(`设置页测试连接失败：${run.testStatus}`);
      await rp.cdp.send("Target.closeTarget", { targetId: run.settingsTargetId });
    }
  }

  await rp.cdp.send("Page.bringToFront", {}, work);
  await until(async () => (await readPanel()).connected || undefined, 90_000, "侧栏连上 agent", 500);

  // 新开一个对话，不往用户正在用的对话里发。
  await rp.click(panel, "#conversation-new");
  await until(async () => { const st = await readPanel(); return st.userMessages === 0 && !st.running ? st : undefined; }, 20_000, "新会话", 500);
  // 新会话初始化会清空输入框：稍等再打字，否则第一句会丢。
  await sleep(1500);

  for (const [index, prompt] of PROMPTS.entries()) {
    const before = await readPanel();
    const sceneSize = async () => Number(await rp.evaluate(work, `localStorage.getItem("excalidraw")?.length ?? 0`).catch(() => -1));
    const sceneAtSend = await sceneSize();
    let firstSceneChangeMs: number | null = null;
    await rp.click(panel, "#input");
    await rp.typeText(panel, prompt.text);
    await sleep(300);
    // 输入框被清空（第一句丢了）时重打一次。
    if (!(await readPanel()).inputValue?.includes(prompt.text)) { await rp.click(panel, "#input"); await rp.typeText(panel, prompt.text); }
    const sentAt = Date.now();
    const sentInproc = inproc?.now() ?? 0;
    await rp.pressEnter(panel);
    let firstChipMs: number | null = null;
    let firstAnswerMs: number | null = null;
    let doneMs: number | null = null;
    let idle = 0;
    let lastBusyAt = Date.now();
    let last: PanelState | null = null;
    let midShots = 0;

    while (Date.now() - sentAt < TURN_LIMIT_MS) {
      const state = await readPanel().catch(() => null);

      if (state) {
        last = state;

        if (state.inputValue?.includes(prompt.text) && state.userMessages === before.userMessages) await rp.pressEnter(panel);

        if (firstChipMs === null && state.chips.length > before.chips.length) firstChipMs = Date.now() - sentAt;

        if (firstSceneChangeMs === null) { const size = await sceneSize(); if (size >= 0 && size !== sceneAtSend) firstSceneChangeMs = Date.now() - sentAt; }

        if (firstAnswerMs === null && state.answers.length > before.answers.length) firstAnswerMs = Date.now() - sentAt;
        const busy = state.running || state.stopping || state.streaming;

        // 运行中每 40 秒给网页和侧栏各拍一张（最多 3 组）。
        if (busy && midShots < 3 && Date.now() - sentAt >= (midShots + 1) * 40_000) {
          midShots += 1;
          await rp.screenshot(work, join(out, `page-${index + 1}-${prompt.id}-mid-${midShots}.png`)).catch(() => {});
          await rp.screenshot(panel, join(out, `panel-${index + 1}-${prompt.id}-mid-${midShots}.png`)).catch(() => {});
        }

        if (busy) lastBusyAt = Date.now();
        idle = !busy && state.userMessages > before.userMessages && Date.now() - sentAt > 3000 ? idle + 1 : 0;

        // 回答后可能还有目标核对接着做：空闲 8 秒才算结束，结束时刻取最后一次忙。
        if (idle >= 32) {
          doneMs = lastBusyAt - sentAt;
          break;
        }
      }

      await sleep(250);
    }

    if (doneMs === null) {
      await rp.click(panel, "#send-btn").catch(() => {});
      await until(async () => { const s = await readPanel(); return !s.running && !s.stopping ? s : undefined; }, 30_000, "停止", 500).catch(() => null);
    }

    const endInproc = inproc?.now() ?? 0;
    await sleep(1500);
    const final = (await readPanel().catch(() => null)) ?? last;
    // SAFETY: READ_SCENE 返回 SceneElement 数组或 null。
    const scene = (await rp.evaluate(work, READ_SCENE).catch(() => null)) as SceneElement[] | null;
    await rp.screenshot(work, join(out, `page-${index + 1}-${prompt.id}-end.png`)).catch(() => {});
    await rp.screenshot(panel, join(out, `panel-${index + 1}-${prompt.id}-end.png`)).catch(() => {});
    const modelCalls = inproc?.requestsBetween(sentInproc, endInproc).filter(isModelCall) ?? [];

    turns.push({
      id: prompt.id, prompt: prompt.text, sentAt: new Date(sentAt).toISOString(), timedOut: doneMs === null, doneMs, firstChipMs, firstSceneChangeMs, firstAnswerMs,
      modelRequests: inproc ? modelCalls.length : null,
      modelCalls: modelCalls.map((r) => ({ host: new URL(r.url).host, startMs: r.startMs - sentInproc, ttfbMs: r.firstByteMs === null ? null : r.firstByteMs - r.startMs, durMs: r.endMs === null ? null : r.endMs - r.startMs, status: r.status, failed: r.failed })),
      panelChips: final?.chips.slice(before.chips.length) ?? [],
      answer: final?.answers.slice(before.answers.length).join("\n\n").slice(0, 1500) ?? "",
      errors: final?.errors.slice(before.errors.length) ?? [],
      notices: final?.notices.slice(before.notices.length) ?? [],
      scene: summarizeScene(scene),
      sceneElements: scene,
    });
    console.log(`${prompt.id}\tdone=${doneMs ?? "timeout"}ms\tfirstChip=${firstChipMs ?? "-"}ms\tmodelRequests=${modelCalls.length}\tchips=${(final?.chips.length ?? 0) - before.chips.length}`);
  }

  // 工具调用：从设置页导出的诊断记录读（与用户在设置页导出的是同一份）。
  const traceDownloads = await mkdtemp(join(tmpdir(), "excalidraw-probe-trace-"));
  const { exportStatus, traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, traceDownloads).finally(async () => {
    // 导出时把浏览器下载目录指到了临时目录：日常 Chrome 里改回默认，不影响用户之后的下载。
    if (daily) await rp.cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
  });
  await rm(traceDownloads, { recursive: true, force: true });
  result.traceExport = exportStatus;
  const leaked = secrets.some((s) => traces.includes(s));
  result.traceSaved = !leaked;

  // 只留这两轮的记录：日常 Chrome 的诊断里还有用户自己的历史，不落盘。
  const since = Date.parse(String(turns[0]?.sentAt ?? startedAt.toISOString()));
  const ours = traces.split("\n").filter((line) => { try { return Date.parse(JSON.parse(line).time) >= since; } catch { return false; } }).join("\n");

  if (!leaked) await writeFile(join(out, "traces.jsonl"), ours);
  // SAFETY: 诊断记录每行是 run-trace-core 写的 { time, type, data } 对象；解析失败的行丢弃。
  const rows = traces.split("\n").filter(Boolean).flatMap((raw) => { try { return [JSON.parse(raw) as { time: string; type: string; data?: Record<string, unknown> }]; } catch { return []; } });
  const ends = new Map(rows.filter((r) => r.type === "tool_execution_end").map((r) => [String(r.data?.toolCallId), r]));
  const short = (v: unknown, n: number) => { const s = typeof v === "string" ? v : JSON.stringify(v ?? null); return s.length > n ? `${s.slice(0, n)}…` : s; };

  for (const [index, turn] of turns.entries()) {
    const from = Date.parse(String(turn.sentAt));
    const to = turns[index + 1] ? Date.parse(String(turns[index + 1]!.sentAt)) : Number.POSITIVE_INFINITY;
    const inTurn = rows.filter((r) => { const t = Date.parse(r.time); return t >= from && t < to; });
    const tools = inTurn.filter((r) => r.type === "tool_execution_start").map((r) => {
      const end = ends.get(String(r.data?.toolCallId));

      return { atMs: Date.parse(r.time) - from, name: String(r.data?.toolName), args: short(r.data?.args, 300), durMs: end?.data?.elapsedMs ?? null, ok: end ? !end.data?.isError : null, result: short(end?.data?.result, 300) };
    });
    turn.tools = tools;
    turn.toolCount = tools.length;
    turn.toolErrors = tools.filter((t) => t.ok === false).length;
    turn.toolNames = Object.fromEntries([...new Set(tools.map((t) => t.name))].map((n) => [n, tools.filter((t) => t.name === n).length]));
    turn.firstToolMs = tools[0]?.atMs ?? null;
    turn.firstPageActionMs = tools.find((t) => PAGE_ACTIONS.has(t.name))?.atMs ?? null;
    turn.programSteps = inTurn.filter((r) => r.type === "program_step").map((r) => ({ atMs: Date.parse(r.time) - from, step: short(r.data?.step, 200) }));
    turn.modelTurns = inTurn.filter((r) => r.type === "turn_start").length;
    turn.traceTypes = Object.fromEntries([...new Set(inTurn.map((r) => r.type))].map((t) => [t, inTurn.filter((r) => r.type === t).length]));
    console.log(`${turn.id}\ttools=${tools.length} errors=${turn.toolErrors} firstTool=${turn.firstToolMs ?? "-"}ms firstPageAction=${turn.firstPageActionMs ?? "-"}ms\t${JSON.stringify(turn.toolNames)}`);
    console.log(`${turn.id}\tscene=${JSON.stringify(turn.scene)}`);
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.error(result.error);
} finally {
  const logs = inproc?.logs() ?? "";

  if (logs && !secrets.some((v) => logs.includes(v))) await writeFile(join(out, "inproc-console.txt"), logs).catch(() => {});
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  // 日常模式不调 close()：它会关掉本次新开的 Excalidraw 标签页；只断开调试连接。
  if (daily) await rp.cdp.close().catch(() => {});
  else await rp.close();
  await rp.remove();
}

console.log(`\nevidence: ${out}`);
