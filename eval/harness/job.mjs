/**
 * One eval job = one (model spec, task) in its own headless Chrome with only the extension installed.
 *
 * Reuses the real-path acceptance driver (scripts/acceptance/real-path/harness.mts): Chrome for Testing
 * `--headless=new`, own temp profile, extension built from the tested repo into a temp dir with a random
 * key, agent core in the extension's offscreen document, real side panel via chrome.sidePanel.open. No
 * companion process, no Native Messaging; never touches the daily Chrome, its profile, CDP 9222 or
 * extension/dist. Main + fast model and credentials go into the extension's own storage (same keys the
 * settings page writes). After the run, that job's diagnostics are exported through the settings page
 * (IndexedDB `sideagent-diagnostics`) into <task>.trace.jsonl for judge v3 and analyze.py.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { REPO } from "./paths.mjs";
import { siteBlock } from "./environment.mjs";
import { storageItemsFor } from "./credentials.mjs";

export { REPO };

/** The tested repo's real-path driver (BYS_REPO decides which checkout is built and driven). */
const driver = () => import(pathToFileURL(join(REPO, "scripts/acceptance/real-path/harness.mts")).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const iso = (ms) => new Date(ms).toISOString();

export const slugOf = (model) => model.replace(/[^a-z0-9.-]+/gi, "_");

// Words that mean submit / buy / post / send: any confirmation mentioning these is denied.
const DANGEROUS = /提交|购买|买|支付|付款|下单|结算|发布|发表|发帖|发送|评论|删除|清空|注销|submit|buy|purchase|pay|checkout|order|post|publish|send|tweet|comment|delete|remove/i;

const PANEL_PROBE = `(() => {
  const txt = (el) => (el?.innerText ?? "").trim();
  const q = (s) => document.querySelector(s);
  const msgs = [...document.querySelectorAll("#messages .msg")].map((el) => ({ cls: el.className, text: txt(el) }));
  const runs = [...document.querySelectorAll("details.run-steps")].map((d) => ({
    title: txt(d.querySelector(".run-title")), chain: txt(d.querySelector(".run-chain")), time: txt(d.querySelector(".run-time")),
    chips: [...d.querySelectorAll(".chip")].map((c) => ({ label: txt(c.querySelector(".chip-label")) || txt(c), detail: txt(c.querySelector(".chip-detail")), cls: c.className })),
    thinking: [...d.querySelectorAll(".thinking")].map(txt).join("\\n").slice(0, 2000),
  }));
  const consents = [...document.querySelectorAll("#consent-requests .consent-card:not(.consent-complete)")].map((c, i) => ({ i, id: c.dataset.requestId ?? "", text: txt(c), buttons: [...c.querySelectorAll("button")].map((b) => b.textContent.trim()) }));
  const artifacts = [...document.querySelectorAll(".artifact-card")].map((c) => txt(c.querySelector(".artifact-name")) + " · " + txt(c.querySelector(".artifact-meta")));
  return { msgs, runs, consents, artifacts,
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    running: q("#status-pill")?.classList.contains("running") ?? false,
    abortVisible: q("#send-btn")?.classList.contains("stopping") ?? false,
    streaming: !!q(".msg.assistant.streaming, .msg.assistant[data-revealing], .thinking.streaming"),
    inputReady: !!q("#input") };
})()`;

/**
 * Trace lines written since primary key `after`, read from the panel (same extension origin as the offscreen
 * writer). Opens the existing v2 database only (never creates or upgrades it) and closes it right away.
 */
const traceSince = (after) => `(async () => {
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === "sideagent-diagnostics" && d.version >= 2)) return { last: ${after}, lines: "" };
  const db = await new Promise((res, rej) => { const r = indexedDB.open("sideagent-diagnostics"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked")); });
  try {
    if (!db.objectStoreNames.contains("trace-lines")) return { last: ${after}, lines: "" };
    const store = db.transaction("trace-lines").objectStore("trace-lines");
    const range = IDBKeyRange.lowerBound(${after}, true);
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const [keys, rows] = await Promise.all([req(store.getAllKeys(range)), req(store.getAll(range))]);
    return { last: keys.length ? keys[keys.length - 1] : ${after}, lines: rows.map((r) => r.line).join("") };
  } finally { db.close(); }
})()`;

const parseLines = (text) => text.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

/** Child processes still alive (so the runner can kill them if it exits). */
export const LIVE = new Set();

export function killLive() {
  for (const rp of LIVE) { try { rp.close(); } catch {} }

  LIVE.clear();
}

export async function runJob({ task, model, outDir, capMs = 240000, log = () => {}, dryRun = false }) {
  mkdirSync(outDir, { recursive: true });
  const { launchRealPath, until, exportDiagnosticsViaSettings } = await driver();

  const rec = { id: task.id, model, main_model: null, fast_model: null, category: task.category, site_url: task.site_url, prompt: task.prompt,
    status: "error", timestamps: {}, load_at_start: os.loadavg().map((x) => Math.round(x * 10) / 10), seconds_to_first_output: null, seconds_total: null,
    steps: [], final_answer_verbatim: "", panel_messages: [], confirmations: [], errors: [],
    site_observations: [], environment: null, final_page: null, downloads: [], screenshots: [], trace_model: null, trace_export: null, secret_scan: null,
    harness: { mode: "extension-only", browser: null, extension_id: null, stored_config: null } };

  const t = (ms) => ms == null ? null : Math.round((ms - rec._t0) / 100) / 10;
  let rp, secrets = [], trace = [], traceKey = 0;

  try {
    const cfg = storageItemsFor(model);
    secrets = cfg.secrets;
    rec.main_model = cfg.main; rec.fast_model = cfg.fast;

    rp = await launchRealPath();
    LIVE.add(rp);
    rec.harness.browser = rp.browser; rec.harness.extension_id = rp.extensionId;

    const evalIn = (sid, expr, opts) => rp.evaluate(sid, expr, opts);
    const blank = await until(async () => (await rp.targets()).find((x) => x.type === "page" && x.url === "about:blank"), 10000, "initial tab");
    const pageSid = await rp.attach(blank.targetId);
    await rp.cdp.send("Page.enable", {}, pageSid);
    await rp.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: rp.dirs.downloads, eventsEnabled: true }).catch(() => {});

    // --- real side panel + model config through the extension's own storage (what the settings page saves) ---
    const ps = await rp.attach(await rp.openSidePanel());
    await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, ps).catch(() => {});
    await until(async () => evalIn(ps, "!!document.querySelector('#input')"), 15000, "panel input");
    await evalIn(ps, `chrome.storage.local.set(${JSON.stringify(cfg.items)}).then(() => true)`);
    rec.harness.stored_config = await evalIn(ps, `chrome.storage.local.get(["inproc_model_config", "inproc_fast_model_config"])`);

    // Record the task tab's main-document response, never subresource/assistant errors.
    let documentResponse = null;
    rp.cdp.onEvent("Network.responseReceived", ({ sessionId, params }) => {
      if (sessionId === pageSid && params.type === "Document") documentResponse = { url: params.response.url, status: params.response.status };
    });
    await rp.cdp.send("Network.enable", {}, pageSid);

    const observeSite = async (errorText = "") => {
      const page = await evalIn(pageSid, `({url:location.href,title:document.title,text:(document.body?.innerText??'').slice(0,5000),challenge:!!document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,iframe[src*="challenges.cloudflare.com"]')})`).catch(() => ({ url: task.site_url, title: "", text: "" }));
      const observed = { ...page, errorText, status: documentResponse?.url === page.url ? documentResponse.status : null };
      rec.site_observations.push(observed);

      return observed;
    };

    // --- task page ---
    rec.timestamps.page_open = iso(Date.now());
    const navigation = await rp.cdp.send("Page.navigate", { url: task.site_url }, pageSid);
    await until(async () => (await evalIn(pageSid, "document.readyState").catch(() => "")) === "complete", 45000, "page load").catch((e) => rec.errors.push(`page load: ${e.message}`));
    await rp.cdp.send("Page.bringToFront", {}, pageSid).catch(() => {});
    await sleep(1000);
    await until(async () => (await evalIn(ps, PANEL_PROBE)).connected, 90000, "panel connected to the in-extension agent");
    const initialSite = await observeSite(navigation.errorText ?? "");
    const initialBlock = siteBlock(initialSite);

    if (initialBlock && !dryRun) {
      rec.status = "environment"; rec.environment = initialBlock;
      rec.final_page = { url: initialSite.url, title: initialSite.title }; rec.final_page_text = initialSite.text;
      const shot = join(outDir, `${task.id}-page.png`);
      await rp.screenshot(pageSid, shot); rec.screenshots.push(shot);

      return rec;
    }

    if (dryRun) {
      rec.status = "dry_run_ok";
      rec.dry = { panel: await evalIn(ps, PANEL_PROBE), modelLabel: await evalIn(ps, "document.querySelector('#model-name')?.textContent ?? ''") };
      await rp.screenshot(ps, join(outDir, `${task.id}-dry.png`)).catch(() => {});

      return rec;
    }

    // --- send prompt like a user: focus, type, Enter ---
    await rp.click(ps, "#input");
    await rp.typeText(ps, task.prompt);
    await sleep(200);
    rec._t0 = Date.now();
    rec.timestamps.send = iso(rec._t0);
    await rp.pressEnter(ps);

    // --- watch panel DOM + extension diagnostics ---
    const seen = new Set();

    const addStep = (at, source, text) => {
      const k = `${source}|${text}`;

      if (seen.has(k)) return;
      seen.add(k);
      rec.steps.push({ t: t(at), at: iso(at), source, text: String(text).slice(0, 500) });
    };

    let firstOut = null, lastChange = Date.now(), lastSig = "", ended = null, lastTraceRead = 0;
    const deniedHeld = new Set(), handledConsent = new Set();
    const deadline = rec._t0 + capMs;
    let snap;

    while (Date.now() < deadline) {
      const now = Date.now();
      snap = await evalIn(ps, PANEL_PROBE).catch((e) => ({ error: e.message }));

      if (snap?.error) { rec.errors.push(`panel probe: ${snap.error}`); await sleep(500); continue; }

      // the prompt can still sit in the input if Enter landed before the panel was ready
      const afterUser = snap.msgs.slice(snap.msgs.findLastIndex((m) => /\buser\b/.test(m.cls)) + 1);

      for (const m of afterUser) if (m.text && !/streaming/.test(m.cls)) addStep(now, `panel:${m.cls.replace(/^msg\s*/, "") || "msg"}`, m.text.slice(0, 300));

      for (const a of snap.artifacts) addStep(now, "panel:artifact", a);

      for (const r of snap.runs) {
        if (r.title) addStep(now, "panel:status", r.title);

        for (const c of r.chips) addStep(now, "panel:chip", [c.label, c.detail].filter(Boolean).join(" — "));
      }

      const visible = afterUser.some((m) => m.text) || snap.runs.some((r) => r.chips.length || (r.title && !r.title.startsWith("正在")) || r.thinking);

      if (!rec.timestamps.first_status && snap.runs.some((r) => r.title)) { rec.timestamps.first_status = iso(now); rec.seconds_to_first_status = t(now); }

      if (!firstOut && (afterUser.some((m) => m.text) || snap.runs.some((r) => r.chips.length || r.thinking))) { firstOut = now; rec.timestamps.first_visible_output = iso(now); }

      // consent cards: allow once unless it smells like submit/buy/post
      for (const c of snap.consents) {
        const k = c.id || c.text.slice(0, 200);

        if (handledConsent.has(k)) continue;
        handledConsent.add(k);
        const allow = !(DANGEROUS.test(c.text) || /\bPOST\b/.test(c.text));
        const label = allow ? "允许一次" : "拒绝";
        await evalIn(ps, `(()=>{const c=document.querySelectorAll('#consent-requests .consent-card:not(.consent-complete)')[${c.i}];const b=c&&[...c.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(b){b.click();return true}return false})()`).catch(() => false);
        rec.confirmations.push({ at: iso(now), t: t(now), kind: "consent_card", text: c.text.slice(0, 400), decision: allow ? "allow_once" : "deny" });
        addStep(now, "harness", `consent ${allow ? "allowed" : "denied"}: ${c.text.slice(0, 120)}`);
      }

      // diagnostics, read incrementally every ~1.5 s
      if (now - lastTraceRead > 1500) {
        lastTraceRead = now;
        const got = await evalIn(ps, traceSince(traceKey)).catch(() => null);

        if (got) { traceKey = got.last; trace.push(...parseLines(got.lines)); }
      }

      // held (destructive) clicks: confirm ordinary deletes/removals on the page, but never confirm
      // anything that submits / buys / pays / posts / sends / publishes (then cancel via the panel).
      const startArgs = new Map(trace.filter((e) => e.type === "tool_execution_start").map((e) => [e.data?.toolCallId, e.data?.args]));

      for (const e of trace) {
        if (e.type === "tool_execution_end" && /Held click/.test(JSON.stringify(e.data?.result ?? "")) && !deniedHeld.has(e.data?.toolCallId)) {
          deniedHeld.add(e.data?.toolCallId);
          const argsText = String(JSON.stringify(startArgs.get(e.data?.toolCallId) ?? e.data?.args ?? {}) ?? "");
          const heldText = argsText + " " + String(JSON.stringify(e.data?.result?.content?.[0]?.text ?? "") ?? "");
          const neverConfirm = /提交|购买|支付|付款|下单|结算|发布|发表|发帖|发送|submit|buy|purchase|pay|checkout|order|post|publish|send|tweet/i.test(argsText);
          const reply = neverConfirm ? "取消" : "确认";
          await rp.click(ps, "#input");
          await rp.typeText(ps, reply);
          await rp.pressEnter(ps);
          rec.confirmations.push({ at: iso(now), t: t(now), kind: "held_click", text: heldText.slice(0, 300), decision: neverConfirm ? "deny (sent 取消)" : "confirm (sent 确认)" });
          addStep(now, "harness", `held click ${neverConfirm ? "denied" : "confirmed"}: ${argsText.slice(0, 120)}`);
        }
      }

      const settled = trace.some((e) => e.type === "agent_settled" && Date.parse(e.time) >= rec._t0 - 1000);
      const sig = JSON.stringify([snap.msgs.map((m) => m.text.length), snap.runs.map((r) => [r.title, r.chips.length]), snap.abortVisible, snap.running, snap.streaming]);

      if (sig !== lastSig) { lastSig = sig; lastChange = now; }

      const idle = !snap.abortVisible && !snap.running && !snap.streaming;
      const answered = afterUser.some((m) => /assistant/.test(m.cls) && m.text);

      if (idle && visible && ((settled && answered && now - lastChange > 4000) || (answered && now - lastChange > 8000) || (settled && now - lastChange > 12000))) { ended = lastChange; break; }

      await sleep(300);
    }

    const endAt = ended ?? Date.now();
    rec.status = ended ? "completed" : "timeout";
    rec.timestamps.finish = iso(endAt);
    rec.seconds_total = t(endAt);
    rec.seconds_to_first_output = t(firstOut);

    // a timed-out task is stopped like a user would (send button doubles as stop) before collecting evidence
    if (!ended) {
      await rp.click(ps, "#send-btn").catch(() => {});
      const stopped = (s) => !s.running && !s.abortVisible;
      await until(async () => stopped(await evalIn(ps, PANEL_PROBE)), 30000, "stop").catch(() => {});
      snap = await evalIn(ps, PANEL_PROBE).catch(() => snap);
    }

    // --- final state ---
    if (snap && !snap.error) {
      const afterUser = snap.msgs.slice(snap.msgs.findLastIndex((m) => /\buser\b/.test(m.cls)) + 1);
      rec.panel_messages = afterUser;
      const answers = snap.msgs.filter((m) => /assistant/.test(m.cls) && m.text);
      rec.final_answer_verbatim = answers.at(-1)?.text ?? "";
      rec.panel_runs = snap.runs;

      for (const m of afterUser) if (/error/.test(m.cls)) rec.errors.push(`panel error: ${m.text}`);

      if (!rec.final_answer_verbatim && afterUser.length) rec.final_answer_verbatim = afterUser.map((m) => m.text).join("\n");
    }

    try {
      const tabs = (await rp.targets()).filter((x) => x.type === "page" && !x.url.startsWith("chrome-extension://"));
      rec.final_page = { url: (await evalIn(pageSid, "location.href").catch(() => null)) ?? blank.url, title: await evalIn(pageSid, "document.title").catch(() => null), tabs: tabs.map((x) => ({ url: x.url, title: x.title })) };
      rec.page_changed = rec.final_page.url !== task.site_url;
      rec.environment = siteBlock(await observeSite());
      // final page text for the judge: visible text + form field values (bounded; a native dialog can block this)
      rec.final_page_text = await Promise.race([
        evalIn(pageSid, `(()=>{const f=[...document.querySelectorAll('input,select,textarea')].filter(e=>e.type!=='hidden'&&e.type!=='password').slice(0,80).map(e=>(e.name||e.id||e.type)+'='+(e.type==='checkbox'||e.type==='radio'?e.checked:(e.tagName==='SELECT'?(e.selectedOptions[0]?.text??''):e.value))).join('; ');return (document.body?.innerText??'').slice(0,30000)+(f?'\\n[form fields] '+f:'')})()`),
        sleep(5000).then(() => null)]).catch(() => null);
    } catch (e) { rec.errors.push(`final page: ${e.message}`); }

    // screenshots: page + side panel side by side (what the judge prompt calls the window), and the panel alone
    const pagePng = join(outDir, `${task.id}-page.png`), panelPng = join(outDir, `${task.id}-panel.png`), shot = join(outDir, `${task.id}.png`);
    await rp.screenshot(pageSid, pagePng).catch((e) => rec.errors.push(`page screenshot: ${e.message}`));
    await rp.screenshot(ps, panelPng).catch(() => {});

    try {
      execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", pagePng, "-i", panelPng, "-filter_complex", "[0:v]scale=-2:900[a];[1:v]scale=-2:900[b];[a][b]hstack", shot], { timeout: 20000 });
      rec.screenshots.push(shot);
    } catch { if (existsSync(pagePng)) rec.screenshots.push(pagePng); }

    if (existsSync(panelPng)) rec.screenshots.push(panelPng);

    // artifact cards: click 下载 like a user
    const cardNames = await evalIn(ps, "[...document.querySelectorAll('.artifact-card')].filter((c) => !c.querySelector('.artifact-download')?.disabled).map((c) => c.dataset.filename)").catch(() => []);

    for (const name of cardNames ?? []) {
      const button = `.artifact-card[data-filename="${name}"] .artifact-download`;
      await evalIn(ps, `document.querySelector(${JSON.stringify(button)})?.scrollIntoView({ block: "center" })`).catch(() => {});
      await rp.click(ps, button).catch(() => {});
    }

    if (cardNames?.length) await sleep(2500);

    // diagnostics: export through the settings page like a user (fresh profile, so the file is this job only)
    let exported = null;

    try {
      const ex = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(rp.root, "export"));
      exported = parseLines(ex.traces);
      rec.trace_export = { via: "settings page 导出", status: ex.exportStatus, lines: exported.length };
    } catch (e) {
      const got = await evalIn(ps, traceSince(traceKey)).catch(() => null);

      if (got) trace.push(...parseLines(got.lines));
      rec.trace_export = { via: "panel IndexedDB read (settings export failed)", error: e.message, lines: trace.length };
      rec.errors.push(`trace export: ${e.message}`);
    }

    if (exported) trace = exported;
    rec.trace_counts = {};

    for (const e of trace) rec.trace_counts[e.type] = (rec.trace_counts[e.type] ?? 0) + 1;

    for (const e of trace) {
      const at = Date.parse(e.time);

      if (e.type === "run_start") rec.trace_model = e.data?.model ?? null;

      if (e.type === "first_response") { addStep(at, "trace:first_response", `model first response ${e.data?.elapsedMs}ms`); rec.timestamps.first_model_response ??= e.time; }

      if (e.type === "tool_execution_start") addStep(at, "trace:tool_start", `${e.data.toolName} ${JSON.stringify(e.data.args ?? {}).slice(0, 200)}`);

      if (e.type === "tool_execution_end") addStep(at, "trace:tool_end", `${e.data.toolName} ${e.data.isError ? "ERROR " : ""}${JSON.stringify(e.data.result?.content?.[0]?.text ?? "").slice(0, 200)}`);

      if (e.type === "agent_end") { addStep(at, "trace:agent_end", `elapsed ${e.data?.elapsedMs}ms`); rec.timestamps.agent_end = e.time; }

      if (e.type === "error" || /error/.test(e.type)) rec.errors.push(`trace ${e.type}: ${JSON.stringify(e.data).slice(0, 300)}`);
    }

    rec.steps.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    rec.n_tool_calls = trace.filter((e) => e.type === "tool_execution_start").length;
    rec.n_steps = rec.steps.filter((s) => s.source === "trace:tool_start" || s.source === "panel:chip").length;

    // artifacts rebuilt from the artifacts tool calls (in case the card download did not land)
    const arts = new Map();

    for (const e of trace) {
      if (e.type !== "tool_execution_start" || e.data?.toolName !== "artifacts") continue;
      const a = e.data.args ?? {};

      if (["create", "rewrite"].includes(a.command) && a.filename) arts.set(a.filename, String(a.content ?? ""));

      if (a.command === "update" && arts.has(a.filename)) arts.set(a.filename, arts.get(a.filename).replace(a.old_str ?? "", a.new_str ?? ""));

      if (a.command === "delete") arts.delete(a.filename);
    }

    for (const [name, content] of arts) { const dst = join(outDir, `${task.id}.artifact.${name}`); writeFileSync(dst, content); rec.downloads.push({ kind: "artifact(tool args)", name, path: dst, bytes: Buffer.byteLength(content) }); }

    // browser downloads (artifact cards, page downloads)
    for (const f of existsSync(rp.dirs.downloads) ? readdirSync(rp.dirs.downloads) : []) {
      const src = join(rp.dirs.downloads, f);

      if (f.endsWith(".crdownload") || !statSync(src).isFile()) continue;
      const dst = join(outDir, `${task.id}.dl.${f}`);
      copyFileSync(src, dst);
      rec.downloads.push({ kind: "browser", name: f, path: dst, bytes: statSync(src).size });
    }

    writeFileSync(join(outDir, `${task.id}.trace.jsonl`), trace.map((e) => JSON.stringify(e)).join("\n"));
    const mainId = rec.main_model.slice(rec.main_model.indexOf("/") + 1);

    // run_start records the model as "provider/modelId"
    if (rec.trace_model != null && !JSON.stringify(rec.trace_model).includes(mainId)) rec.errors.push(`MODEL MISMATCH: trace says ${JSON.stringify(rec.trace_model)}`);
  } catch (e) {
    rec.errors.push(`harness: ${e.stack ?? e.message}`);
    rec.status = rec._t0 ? "error" : "setup_error";
  } finally {
    delete rec._t0;

    if (rp) {
      await rp.close().catch(() => {});
      await rp.remove().catch(() => {}); // deletes the temp profile, which holds the credential in extension storage
      LIVE.delete(rp);
    }

    rec.load_at_end = os.loadavg().map((x) => Math.round(x * 10) / 10);
    writeFileSync(join(outDir, `${task.id}.json`), JSON.stringify(rec, null, 2));
    // credentials must not reach results: scan every file this job wrote (bytes compared in memory, never printed)
    const mine = readdirSync(outDir).filter((f) => f.startsWith(`${task.id}.`) || f.startsWith(`${task.id}-`));
    const leaks = mine.filter((f) => secrets.some((s) => readFileSync(join(outDir, f)).includes(Buffer.from(s))));
    rec.secret_scan = { files: mine.length, leaked_files: leaks };

    if (leaks.length) rec.errors.push(`CREDENTIAL LEAK in ${leaks.join(", ")}`);
    writeFileSync(join(outDir, `${task.id}.json`), JSON.stringify(rec, null, 2));
    log(`${model} ${task.id} -> ${rec.status} total=${rec.seconds_total}s first=${rec.seconds_to_first_output}s`);
  }

  return rec;
}
