/**
 * #43 设计核对（只看不修）：Agent 光标旁的动作旁白，在真实用户路径上是否成立。
 *
 *   npx tsx scripts/probes/design-check/43/cursor-narration.mts --headless [--model=openai-codex/gpt-6-luna] [--only=normal|reduced]
 *
 * 只装扩展的无头 Chrome（harness 把扩展构建到临时目录，不动 extension/dist），
 * 订阅登录令牌直接写进扩展存储（不刷新令牌；少于 3 小时就停）。
 * 本机表单页：日期输入、文字输入、按钮。侧栏里让 Agent 填表并点按钮；运行期间高频读取页面里
 * 封闭 shadow root 的光标名牌（CDP pierce），旁白文字变化时给页面标签页截图（整页 + 光标附近放大）。
 * 跑两轮：正常、以及 CDP 模拟 prefers-reduced-motion: reduce。
 * 产物：out/design-check/43/ 下的截图与 result.json。
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../../acceptance/real-path/harness.mts";
import { loadModelPlan, modelStorageItems } from "../../../acceptance/real-path/inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? "openai-codex/gpt-6-luna";

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

const OUT = join(REPO, "out/design-check/43");

const RUN_LIMIT_MS = 180_000;

await mkdir(OUT, { recursive: true });

const FORM = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订票</title>
<style>body{font:16px -apple-system,"PingFang SC",sans-serif;margin:0;padding:60px 80px;background:#f7f7f5;color:#1c1f24}
form{display:grid;gap:22px;max-width:420px;background:#fff;padding:28px;border-radius:12px;box-shadow:0 1px 3px #0001}
label{display:grid;gap:6px;font-weight:600}input{font:inherit;padding:8px 10px;border:1px solid #ccc;border-radius:8px}
button{font:inherit;padding:10px 16px;border:0;border-radius:8px;background:#2d4a86;color:#fff;justify-self:start;cursor:pointer}
#result{margin-top:16px;font-weight:600}</style></head><body>
<h1>火车票查询</h1>
<form onsubmit="return false">
<label for="date">出发日期<input id="date" type="date"></label>
<label for="name">乘客姓名<input id="name" type="text"></label>
<button id="go" type="button" onclick="document.querySelector('#result').textContent='已查询：'+document.querySelector('#date').value+' '+document.querySelector('#name').value">查询车票</button>
</form><p id="result"></p></body></html>`;

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FORM));

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const PROMPT = "在这个页面上把出发日期填成 2026-10-20，乘客姓名填张三，然后点「查询车票」按钮。";

type DomNode = { nodeId: number; backendNodeId: number; nodeName?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

type Rect = { x: number; y: number; width: number; height: number };

/** 每次采样读到的一个 Agent 光标。 */
type CursorRead = {
  classes: string; acting: boolean; text: string; actionTexts: number; labelDisplay: string; labelOpacity: number;
  labelPointerEvents: string; hostPointerEvents: string; labelTransition: string; labelAnimation: string; labelTransitionDuration: string; cursorTransitionDuration: string;
  cursorTransition: string; cursorAnimation: string; labelRect: Rect | null; cursorTransform: string;
};

type ScreenshotParams = { format: string; clip?: Rect & { scale: number } };

type ValueChange = { ms: number; date: string; name: string; result: string; cursors: string };

type Run = {
  mode: "normal" | "reduced"; mediaReduceMatches: unknown; finished: boolean; valueChanges: ValueChange[]; elapsedMs: number;
  pageResult: unknown; answer: unknown; texts: Array<{ ms: number; text: string; classes: string }>; samples: Sample[];
};

type Sample = { ms: number; cursors: CursorRead[]; targets: Record<string, Rect>; hitAtTargets: Record<string, string>; hitAtLabel: string | null; shot?: string; zoom?: string };

const classOf = (n: DomNode) => {
  const a = n.attributes ?? [];
  const i = a.indexOf("class");

  return i >= 0 ? a[i + 1] ?? "" : "";
};

const READ_CURSOR = `function() {
  const label = this.querySelector(":scope > .label");
  const host = this.getRootNode().host;
  const cs = label ? getComputedStyle(label) : null;
  const ccs = getComputedStyle(this);
  const r = label?.getBoundingClientRect();
  return {
    classes: this.className, acting: this.classList.contains("acting"),
    text: label?.querySelector(".action-text")?.textContent ?? "",
    actionTexts: this.querySelectorAll(".action-text").length,
    labelDisplay: cs?.display ?? "", labelOpacity: cs ? Number(cs.opacity) : 0,
    labelPointerEvents: cs?.pointerEvents ?? "", hostPointerEvents: host ? getComputedStyle(host).pointerEvents : "",
    labelTransition: cs ? cs.transitionProperty + " " + cs.transitionDuration : "", labelAnimation: cs ? cs.animationName + " " + cs.animationDuration : "",
    labelTransitionDuration: cs?.transitionDuration ?? "", cursorTransitionDuration: ccs.transitionDuration,
    cursorTransition: ccs.transitionProperty + " " + ccs.transitionDuration, cursorAnimation: ccs.animationName,
    labelRect: r && r.width ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
    cursorTransform: ccs.transform,
  };
}`;

const rp = await launchRealPath();

const plan = await loadModelPlan(modelArg);

const runs: Run[] = [];

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // SAFETY: modelStorageItems 只含扩展存储键值；令牌不打印。
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on")`)) || undefined, 90_000, "侧栏连上 agent", 500);

  /** 页面里所有 Agent 光标元素（.cursor，在封闭 shadow root 里）。 */
  const readCursors = async (): Promise<CursorRead[]> => {
    // SAFETY: CDP DOM.getDocument 返回 { root: Node }。
    const { root } = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)) as { root: DomNode };
    const found: DomNode[] = [];

    const walk = (n: DomNode) => {
      if (/(^|\s)cursor(\s|$)/.test(classOf(n)) && n.nodeName === "DIV") found.push(n);

      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c);
    };

    walk(root);
    const out: CursorRead[] = [];

    for (const n of found) {
      // SAFETY: DOM.resolveNode 返回 { object: { objectId } }。
      const { object } = (await rp.cdp.send("DOM.resolveNode", { backendNodeId: n.backendNodeId }, work)) as { object: { objectId: string } };
      // SAFETY: READ_CURSOR 返回 CursorRead 形状的对象。
      const reply = (await rp.cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: READ_CURSOR, returnByValue: true }, work)) as { result: { value: CursorRead } };
      out.push(reply.result.value);
    }

    return out;
  };

  // SAFETY: 脚本返回 date/name/go 三个元素的矩形。
  const readTargets = async () => (await rp.evaluate(work, `(() => { const o = {}; for (const id of ["date","name","go"]) { const r = document.getElementById(id).getBoundingClientRect(); o[id] = { x: r.x, y: r.y, width: r.width, height: r.height }; } return o; })()`)) as Record<string, Rect>;

  /** 页面主世界里的 elementFromPoint：光标层 pointer-events:none 时应该命中页面元素本身。 */
  const hitAt = async (x: number, y: number) => String(await rp.evaluate(work, `(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.getAttribute("data-sideagent-overlay") !== null ? "[overlay]" : "") : "null"; })()`));

  const shoot = async (file: string, clip?: Rect) => {
    const params: ScreenshotParams = { format: "png" };

    if (clip) params.clip = { ...clip, scale: 2 };
    // SAFETY: Page.captureScreenshot 返回 { data: base64 }。
    const { data } = (await rp.cdp.send("Page.captureScreenshot", params, work)) as { data: string };
    await writeFile(join(OUT, file), Buffer.from(data, "base64"));

    return join(OUT, file);
  };

  for (const mode of ["normal", "reduced"] as const) {
    if (only && only !== mode) continue;
    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced" ? "reduce" : "no-preference" }] }, work);
    await rp.cdp.send("Page.navigate", { url: origin }, work);
    await until(async () => (await rp.evaluate(work, `document.readyState === "complete" && !!document.querySelector("#go")`)) || undefined, 15_000, "表单页加载");
    const mediaOk = await rp.evaluate(work, `matchMedia("(prefers-reduced-motion: reduce)").matches`);
    await rp.cdp.send("Page.bringToFront", {}, work);
    await sleep(800);
    await rp.click(panel, "#conversation-new");
    await sleep(1500);
    await rp.click(panel, "#input");
    await rp.typeText(panel, PROMPT);
    const sentAt = Date.now();
    await rp.pressEnter(panel);

    const samples: Sample[] = [];
    const texts: Array<{ ms: number; text: string; classes: string }> = [];
    let lastText = "";
    let lastShotAt = 0;
    let shots = 0;
    let idle = 0;
    let finished = false;
    const valueChanges: ValueChange[] = [];

    while (Date.now() - sentAt < RUN_LIMIT_MS) {
      const ms = Date.now() - sentAt;
      const cursors = await readCursors().catch((): CursorRead[] => []);
      // SAFETY: 返回三个字符串字段。
      const values = (await rp.evaluate(work, `({ date: document.querySelector("#date")?.value ?? "", name: document.querySelector("#name")?.value ?? "", result: document.querySelector("#result")?.textContent ?? "" })`).catch(() => null)) as { date: string; name: string; result: string } | null;
      const lastValues = valueChanges.at(-1);

      if (values && (!lastValues || lastValues.date !== values.date || lastValues.name !== values.name || lastValues.result !== values.result)) valueChanges.push({ ms, ...values, cursors: cursors.map((c) => `${c.classes}/${c.text}`).join(" | ") });
      const shown = cursors.filter((c) => c.labelDisplay !== "none" && c.text);
      const text = shown.map((c) => c.text).join(" | ");

      if (cursors.length) {
        const targets = await readTargets().catch(() => ({}));
        const hitAtTargets: Record<string, string> = {};

        for (const [id, r] of Object.entries(targets)) hitAtTargets[id] = await hitAt(r.x + r.width / 2, r.y + r.height / 2);
        const lr = shown[0]?.labelRect;
        const sample: Sample = { ms, cursors, targets, hitAtTargets, hitAtLabel: lr ? await hitAt(lr.x + lr.width / 2, lr.y + lr.height / 2) : null };
        const changed = text !== lastText;

        if (changed) texts.push({ ms, text, classes: shown.map((c) => c.classes).join(" | ") });

        // 旁白文字变化时必拍；仍在显示时每 400ms 补一张，每轮最多 40 张。
        if (shown.length && shots < 40 && (changed || ms - lastShotAt > 400)) {
          shots += 1;
          lastShotAt = ms;
          const tag = `${mode}-${String(shots).padStart(2, "0")}-${ms}ms`;
          sample.shot = await shoot(`${tag}.png`).catch(() => undefined);

          if (lr) sample.zoom = await shoot(`${tag}-zoom.png`, { x: Math.max(0, lr.x - 140), y: Math.max(0, lr.y - 90), width: 420, height: 200 }).catch(() => undefined);
        }

        lastText = text;
        samples.push(sample);
      }

      // SAFETY: 返回 { running, answers } 两个字段。
      const state = (await rp.evaluate(panel, `({ running: document.querySelector("#status-pill")?.classList.contains("running") ?? false, streaming: !!document.querySelector(".msg.assistant.streaming, .msg.assistant[data-revealing]"), answers: document.querySelectorAll("#messages .msg.assistant").length })`).catch(() => null)) as { running: boolean; streaming: boolean; answers: number } | null;
      idle = state && !state.running && !state.streaming && ms > 4000 ? idle + 1 : 0;

      if (idle >= 12) {
        finished = true;
        break;
      }

      await sleep(60);
    }

    const pageResult = await rp.evaluate(work, `({ date: document.querySelector("#date").value, name: document.querySelector("#name").value, result: document.querySelector("#result").textContent })`);
    const answer = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].map((e) => e.innerText.trim()).join("\\n")`);
    await shoot(`${mode}-final-page.png`);
    // SAFETY: Page.captureScreenshot 返回 { data: base64 }。
    const { data } = (await rp.cdp.send("Page.captureScreenshot", { format: "png" }, panel)) as { data: string };
    await writeFile(join(OUT, `${mode}-final-panel.png`), Buffer.from(data, "base64"));
    runs.push({ mode, mediaReduceMatches: mediaOk, finished, valueChanges, elapsedMs: Date.now() - sentAt, pageResult, answer, texts, samples });
    console.log(`${mode}\tfinished=${finished}\ttexts=${JSON.stringify(texts.map((t) => t.text))}\tpage=${JSON.stringify(pageResult)}`);
  }

  // 诊断记录：看 Agent 实际用了哪些工具、参数和时刻（令牌若出现则整份不落盘）。
  const diag = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(rp.root, "diag")).catch((e: Error) => ({ traces: "", exportStatus: e.message }));
  const secret = String(plan.credential.access ?? plan.credential.key ?? "");
  await writeFile(join(OUT, "traces.jsonl"), secret.length > 8 && diag.traces.includes(secret) ? "redacted: contained credential\n" : diag.traces);
} finally {
  await writeFile(join(OUT, "raw-runs.json"), JSON.stringify(runs, null, 2)).catch(() => {});
  await rp.close();
  site.close();
  await rp.remove();
}

// ── 判定 ─────────────────────────────────────────────

type Verdict = { status: "pass" | "fail" | "not-run"; evidence: string };

const allTexts = runs.flatMap((r) => r.texts.map((t) => t.text)).filter(Boolean);

const actingSamples = runs.flatMap((r) => r.samples.flatMap((s) => s.cursors.filter((c) => c.acting && c.text).map((c) => ({ s, c, mode: r.mode }))));

const chars = (t: string) => [...t].length;

const verdict: Record<string, Verdict> = {};

verdict.R1_bubble_le_12_chars = !allTexts.length ? { status: "fail", evidence: "运行期间没读到任何光标旁白" }
  : allTexts.every((t) => t.split(" | ").every((x) => chars(x) <= 12)) ? { status: "pass", evidence: `全部旁白 ≤12 字：${[...new Set(allTexts)].join("；")}` }
  : { status: "fail", evidence: `超过 12 字：${allTexts.filter((t) => chars(t) > 12).join("；")}` };

const fillTexts = [...new Set(allTexts.filter((t) => t.includes("填")))];

const clickTexts = [...new Set(allTexts.filter((t) => t.includes("点")))];

verdict.R2a_matches_action = !fillTexts.length || !clickTexts.length ? { status: "fail", evidence: `没同时看到填写与点击旁白：fill=${fillTexts.join("、") || "无"} click=${clickTexts.join("、") || "无"}` }
  : { status: "pass", evidence: `填写时：${fillTexts.join("、")}；点击时：${clickTexts.join("、")}（与动作对照见 raw-runs.json 的 targets/cursor 坐标）` };

const multi = actingSamples.filter(({ c }) => c.actionTexts > 1);

const stacked = runs.flatMap((r) => r.samples.filter((s) => s.cursors.filter((c) => c.labelDisplay !== "none" && c.text).length > 1));

verdict.R2b_replaces_previous = !actingSamples.length ? { status: "fail", evidence: "没有采到 acting 态" }
  : multi.length || stacked.length ? { status: "fail", evidence: `同时显示多句：${multi.length} 个样本一个光标多行，${stacked.length} 个样本多个光标同时有旁白` }
  : { status: "pass", evidence: `每个样本只有一句；顺序：${runs.map((r) => `${r.mode}: ${r.texts.map((t) => t.text || "∅").join(" → ")}`).join(" ／ ")}` };

const notNone = actingSamples.filter(({ c }) => c.labelPointerEvents !== "none" || c.hostPointerEvents !== "none");

const hitBlocked = runs.flatMap((r) => r.samples.flatMap((s) => Object.entries(s.hitAtTargets).filter(([id, hit]) => !hit.endsWith(`#${id}`) && !(id === "date" && hit.includes("label"))).map(([id, hit]) => `${id}->${hit}`)));

const overlapping = actingSamples.filter(({ s, c }) => c.labelRect && Object.values(s.targets).some((t) => Math.min(c.labelRect!.x + c.labelRect!.width, t.x + t.width) - Math.max(c.labelRect!.x, t.x) > 1 && Math.min(c.labelRect!.y + c.labelRect!.height, t.y + t.height) - Math.max(c.labelRect!.y, t.y) > 1));

verdict.R3_no_block_target = !actingSamples.length ? { status: "not-run", evidence: "没采到 acting 态" }
  : notNone.length || hitBlocked.length ? { status: "fail", evidence: `pointer-events 非 none 样本 ${notNone.length}；目标中心命中被挡 ${hitBlocked.slice(0, 5).join("、")}` }
  : { status: "pass", evidence: `${actingSamples.length} 个 acting 样本：名牌与宿主 pointer-events 均为 none，目标中心 elementFromPoint 命中目标本身；名牌与目标矩形视觉重叠的样本 ${overlapping.length} 个` };

const reduced = runs.find((r) => r.mode === "reduced");

const reducedActing = actingSamples.filter((x) => x.mode === "reduced");

const zero = (d: string) => d.split(",").every((x) => parseFloat(x) === 0);

const animated = reducedActing.filter(({ c }) => !c.labelAnimation.startsWith("none") || !zero(c.labelTransitionDuration) || !zero(c.cursorTransitionDuration));

const firstReduced = reducedActing[0]?.c;

verdict.R4_reduced_motion_no_animation = !reduced ? { status: "not-run", evidence: "没跑 reduced 轮" }
  : !reduced.mediaReduceMatches ? { status: "fail", evidence: "页面里 matchMedia(reduce) 未生效，模拟失败" }
  : !reducedActing.length ? { status: "fail", evidence: "reduced 轮没采到旁白" }
  : animated.length ? { status: "fail", evidence: `仍有动画/过渡：${animated[0]!.c.labelAnimation} / ${animated[0]!.c.labelTransition}` }
  : { status: "pass", evidence: `reduced 轮 ${reducedActing.length} 个样本：名牌 animation=${firstReduced?.labelAnimation}，transition=${firstReduced?.labelTransition}，首次读到时 opacity=${firstReduced?.labelOpacity}` };

verdict.R5_user_cursor_distinct = { status: "not-run", evidence: "无头截图不含系统鼠标；只能人看 Agent 光标形状/颜色（见截图）" };

const result = { case: "#43 cursor narration", model: modelArg, at: new Date().toISOString(), browser: "isolated headless, extension only", prompt: PROMPT, verdict,
  runs: runs.map((r) => ({ mode: r.mode, finished: r.finished, valueChanges: r.valueChanges, elapsedMs: r.elapsedMs, pageResult: r.pageResult, answer: String(r.answer).slice(0, 400), texts: r.texts,
    normalTransitions: [...new Set(r.samples.flatMap((s) => s.cursors.filter((c) => c.acting).map((c) => `${c.labelTransition} | anim ${c.labelAnimation}`)))],
    shots: r.samples.filter((s) => s.shot).map((s) => ({ ms: s.ms, shot: s.shot, zoom: s.zoom, text: s.cursors.map((c) => c.text).join(" | "), classes: s.cursors.map((c) => c.classes).join(" | ") })) })) };

await writeFile(join(OUT, "result.json"), JSON.stringify(result, null, 2));

console.log(JSON.stringify(verdict, null, 2));
