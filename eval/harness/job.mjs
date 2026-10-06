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

const PANEL_PROBE = `(() => {
  const txt = (el) => (el?.innerText ?? "").trim();
  const q = (s) => document.querySelector(s);
  const msgs = [...document.querySelectorAll("#messages .msg")].map((el) => ({ cls: el.className, text: txt(el) }));
  const runs = [...document.querySelectorAll("details.run-steps")].map((d) => ({
    title: txt(d.querySelector(".run-title")), chain: txt(d.querySelector(".run-chain")), time: txt(d.querySelector(".run-time")),
    chips: [...d.querySelectorAll(".chip")].map((c) => ({ label: txt(c.querySelector(".chip-label")) || txt(c), detail: txt(c.querySelector(".chip-detail")), cls: c.className })),
    thinking: [...d.querySelectorAll(".thinking")].map(txt).join("\\n").slice(0, 2000),
  }));
  const artifacts = [...document.querySelectorAll(".artifact-card")].map((c) => txt(c.querySelector(".artifact-name")) + " · " + txt(c.querySelector(".artifact-meta")));
  return { msgs, runs, artifacts,
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

/** Select `needle` (whitespace ignored) in the visible page text, open shadow roots included (MDN code blocks); returns the selected text or null. */
const selectText = (needle) => `(() => {
  const want = ${JSON.stringify(needle)}.replace(/\\s+/g, "");
  let flat = ""; const at = [];

  const walk = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.shadowRoot) walk(n.shadowRoot);
      const el = n.nodeType === 3 && (n.parentElement ?? n.parentNode.host);
      if (!el || el.closest("script,style,noscript") || !el.checkVisibility()) continue;
      for (let i = 0; i < n.data.length; i++) if (!/\\s/.test(n.data[i])) { flat += n.data[i]; at.push([n, i]); }
    }
  };

  walk(document.body);
  const i = flat.indexOf(want);
  if (i < 0) return null;
  const range = document.createRange();
  range.setStart(...at[i]); range.setEnd(at[i + want.length - 1][0], at[i + want.length - 1][1] + 1);
  (at[i][0].parentElement ?? at[i][0].parentNode.host).scrollIntoView({ block: "center", behavior: "instant" });
  getSelection().removeAllRanges(); getSelection().addRange(range);
  return getSelection().toString();
})()`;

/** The page's 划词 reading thread, as the extension stores it (chrome.storage.session, read from the panel). */
const READING_PROBE = `chrome.storage.session.get("readingRecords").then((s) => {
  const turn = (s.readingRecords ?? []).sort((a, b) => a.updatedAt - b.updatedAt).at(-1)?.turns.at(-1);
  return turn ? { state: turn.state, answer: turn.answer, error: turn.error ?? "" } : null;
})`;

const parseLines = (text) => text.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

/** Child processes still alive (so the runner can kill them if it exits). */
export const LIVE = new Set();

export function killLive() {
  for (const rp of LIVE) { try { rp.close(); } catch {} }

  LIVE.clear();
}

/** `{ladder}` in a task URL = the local ladder pages (ladder-sites.mjs), started by run.mjs. */
const siteUrl = (url) => url.replace("{ladder}", process.env.BYS_LADDER_BASE ?? "{ladder}");

/** Center of the first element matching `selector` (page coordinates for a mouse click). */
const centerOf = (selector) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;

/** Each conversation in the panel menu with its state label (运行中 / 空闲 / …). */
const CONVERSATIONS = `[...document.querySelectorAll("#conversation-menu [data-conversation-id]")].map((b) => ({ id: b.dataset.conversationId, title: b.title, state: b.lastElementChild?.textContent ?? "" }))`;

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
    const navigation = await rp.cdp.send("Page.navigate", { url: siteUrl(task.site_url) }, pageSid);
    await until(async () => (await evalIn(pageSid, "document.readyState").catch(() => "")) === "complete", 45000, "page load").catch((e) => rec.errors.push(`page load: ${e.message}`));
    await rp.cdp.send("Page.bringToFront", {}, pageSid).catch(() => {});
    await sleep(1000);
    await until(async () => (await evalIn(ps, PANEL_PROBE)).connected, 90000, "panel connected to the in-extension agent");
    const initialSite = await observeSite(navigation.errorText ?? "");
    const initialBlock = siteBlock(initialSite);

    if (initialBlock && !dryRun) {
      const recorded = await evalIn(ps, traceSince(0));
      const events = parseLines(recorded.lines);
      rec.n_tool_calls = events.filter(e => e.type === "tool_execution_start").length;
      rec.n_model_requests = events.filter(e => e.type === "model_request" || e.type === "side_call").length;
      writeFileSync(join(outDir, `${task.id}.trace.jsonl`), recorded.lines);
      rec.status = "environment"; rec.environment = initialBlock;
      rec.final_page = { url: initialSite.url, title: initialSite.title }; rec.final_page_text = initialSite.text;
      const shot = join(outDir, `${task.id}-page.png`);
      await rp.screenshot(pageSid, shot); rec.screenshots.push(shot);

      return rec;
    }

    // --- task setup_steps: extra tabs; a text selection opened in the page's 划词 card like a user (Shift-select → 问 AI) ---
    let selected = null;
    rec.setup = [];

    const shadowCenter = async (attr, value) => {
      const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, pageSid);

      const find = (n) => {
        const a = n.attributes ?? [];

        for (let i = 0; i < a.length; i += 2) if (a[i] === attr && (value == null || a[i + 1] === value)) return n;

        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
          const f = find(c);

          if (f) return f;
        }

        return null;
      };

      const node = find(root);
      const box = node && await rp.cdp.send("DOM.getBoxModel", { nodeId: node.nodeId }, pageSid).catch(() => null);
      const q = box?.model?.border;

      return q && box.model.width > 0 ? { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 } : null;
    };

    try {
      for (const step of task.setup_steps ?? []) {
        if (step.type === "open_tabs") {
          for (const url of step.urls.map(siteUrl)) {
            const sid = await rp.attach((await rp.cdp.send("Target.createTarget", { url, background: true })).targetId);
            await until(() => evalIn(sid, "location.href !== 'about:blank' && document.readyState === 'complete'").catch(() => false), 45000, `tab load ${url}`).catch((e) => rec.errors.push(`setup: ${e.message}`));
            const landed = await evalIn(sid, "location.href + ' | ' + document.title").catch(() => "?");
            rec.setup.push(`open_tabs ${url} -> ${landed}`);
            await rp.detach(sid);

            if (!/^https?:/.test(landed)) throw new Error(`tab did not load: ${url} -> ${landed}`);
          }
        } else if (step.type === "select_text") {
          selected = await evalIn(pageSid, selectText(step.text));

          if (!selected) throw new Error(`text not found on page: ${step.text.slice(0, 60)}`);
          await sleep(600); // let scrollIntoView finish; a scroll hides the toolbar
          const shift = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
          await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 8, ...shift }, pageSid);
          await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...shift }, pageSid);
          const ask = await until(() => shadowCenter("data-act", "ask"), 10000, "划词 toolbar 问 AI");

          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: ask.x, y: ask.y, button: "left", clickCount: 1 }, pageSid);
          await until(() => shadowCenter("aria-label", "关于选中文字的问题"), 10000, "划词 card input");
          rec.setup.push(`select_text ${selected.length} chars "${selected.replace(/\s+/g, " ").slice(0, 80)}" -> 划词 card open`);
        } else throw new Error(`unknown setup step ${step.type}`);
      }

      await rp.cdp.send("Page.bringToFront", {}, pageSid).catch(() => {});
    } catch (e) {
      rec.status = "setup_failed";
      rec.errors.push(`setup: ${e.message}`);
    }

    for (const line of rec.setup) log(`${task.id} setup: ${line}`);

    if (rec.status === "setup_failed") {
      const shot = join(outDir, `${task.id}-page.png`);
      await rp.screenshot(pageSid, shot).catch(() => {}); rec.screenshots.push(shot);

      return rec;
    }

    if (dryRun) {
      rec.status = "dry_run_ok";
      rec.dry = { panel: await evalIn(ps, PANEL_PROBE), modelLabel: await evalIn(ps, "document.querySelector('#model-name')?.textContent ?? ''") };
      await rp.screenshot(ps, join(outDir, `${task.id}-dry.png`)).catch(() => {});
      await rp.screenshot(pageSid, join(outDir, `${task.id}-dry-page.png`)).catch(() => {});

      return rec;
    }

    // --- memory quiz: earlier turns (same or new conversation), each run to the end before the next; not timed ---
    const newConversation = async () => {
      await rp.click(ps, "#conversation-new");
      await until(async () => evalIn(ps, "document.querySelector('#send-btn')?.disabled === false && !document.querySelector('#messages .msg.user')"), 30000, "new conversation");
    };

    const sendAndSettle = async (text) => {
      const answers = await evalIn(ps, "document.querySelectorAll('#messages .msg.assistant').length");
      await rp.click(ps, "#input");
      await rp.typeText(ps, text);
      await rp.pressEnter(ps);
      await until(async () => evalIn(ps, `document.querySelectorAll('#messages .msg.assistant').length > ${answers} && !document.querySelector('#status-pill')?.classList.contains('running') && !document.querySelector('#send-btn')?.classList.contains('stopping')`), capMs, "earlier turn done");
      await sleep(4000); // memory judgments run after the turn settles
      rec.before_turns.push({ prompt: text, answer: await evalIn(ps, "[...document.querySelectorAll('#messages .msg.assistant')].at(-1)?.innerText ?? ''") });
    };

    rec.before_turns = [];

    for (const turn of task.before_turns ?? []) {
      if (turn.new_conversation) await newConversation();
      await sendAndSettle(turn.prompt);
    }

    if (task.new_conversation) await newConversation();

    // --- send prompt like a user: focus, type, Enter (selection tasks: into the open 划词 card, minus the （选中…） stage note) ---
    const inputSid = selected ? pageSid : ps;

    if (selected) rec.typed_prompt = task.prompt.replace(/^（[^）]*）\s*/, "");
    else await rp.click(ps, "#input");
    await rp.typeText(inputSid, rec.typed_prompt ?? task.prompt);
    await sleep(200);
    rec._t0 = Date.now();
    rec.timestamps.send = iso(rec._t0);
    await rp.pressEnter(inputSid);

    // --- L7: a second task in a new foreground tab and a new conversation, while the first one runs ---
    let pageB = null;

    if (task.parallel) {
      pageB = await rp.attach((await rp.cdp.send("Target.createTarget", { url: siteUrl(task.parallel.site_url) })).targetId);
      await until(async () => (await evalIn(pageB, "document.readyState").catch(() => "")) === "complete", 45000, "parallel tab load").catch((e) => rec.errors.push(`parallel: ${e.message}`));
      await rp.cdp.send("Page.bringToFront", {}, pageB);
      await rp.click(ps, "#conversation-new");
      await until(async () => evalIn(ps, "document.querySelector('#send-btn')?.disabled === false && !document.querySelector('#messages .msg.user')"), 30000, "new conversation");
      await rp.click(ps, "#input");
      await rp.typeText(ps, task.parallel.prompt);
      await rp.pressEnter(ps);
      rec.parallel = { site_url: task.parallel.site_url, prompt: task.parallel.prompt, sent_at: t(Date.now()) };
    }

    // --- L6: the user takes over once `takeover.when` holds on the page, edits one field, hands back ---
    const takeover = async () => {
      const at = Date.now();
      await rp.click(ps, "#takeover-btn");
      await until(async () => /已暂停/.test(await evalIn(ps, "document.querySelector('#task-bar-root')?.innerText ?? ''")), 10000, "paused");
      const paused = Date.now();
      const p = await evalIn(pageSid, centerOf(task.takeover.edit.selector));

      for (const type of ["mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, ...p, button: "left", clickCount: 1 }, pageSid);
      await evalIn(pageSid, `document.querySelector(${JSON.stringify(task.takeover.edit.selector)}).select()`);
      await rp.typeText(pageSid, task.takeover.edit.value);
      await rp.click(ps, "#takeover-btn");
      rec.takeover = { at: t(at), paused_ms: paused - at, edited: task.takeover.edit, value_after_edit: await evalIn(pageSid, `document.querySelector(${JSON.stringify(task.takeover.edit.selector)}).value`) };
    };

    // --- watch panel DOM + extension diagnostics ---
    const seen = new Set();

    const addStep = (at, source, text) => {
      const k = `${source}|${text}`;

      if (seen.has(k)) return;
      seen.add(k);
      rec.steps.push({ t: t(at), at: iso(at), source, text: String(text).slice(0, 500) });
    };

    let firstOut = null, lastChange = Date.now(), lastSig = "", ended = null, lastTraceRead = 0;
    const deadline = rec._t0 + capMs;
    let snap;

    while (Date.now() < deadline) {
      const now = Date.now();

      // 划词 answers stream into the page card, not the panel
      if (selected) {
        const r = await evalIn(ps, READING_PROBE).catch(() => null);

        if (r?.answer && !firstOut) { firstOut = now; rec.timestamps.first_visible_output = iso(now); }

        if (r && !["pending", "streaming"].includes(r.state)) { ended = now; break; }

        await sleep(300); continue;
      }

      if (task.takeover && !rec.takeover && await evalIn(pageSid, task.takeover.when).catch(() => false)) {
        await takeover().catch((e) => { rec.takeover = { error: e.message }; rec.errors.push(`takeover: ${e.message}`); });
        lastChange = Date.now();
      }

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

      // diagnostics, read incrementally every ~1.5 s
      if (now - lastTraceRead > 1500) {
        lastTraceRead = now;
        const got = await evalIn(ps, traceSince(traceKey)).catch(() => null);

        if (got) { traceKey = got.last; trace.push(...parseLines(got.lines)); }
      }

      const settled = trace.some((e) => e.type === "agent_settled" && Date.parse(e.time) >= rec._t0 - 1000);
      const sig = JSON.stringify([snap.msgs.map((m) => m.text.length), snap.runs.map((r) => [r.title, r.chips.length]), snap.abortVisible, snap.running, snap.streaming]);

      if (sig !== lastSig) { lastSig = sig; lastChange = now; }

      const othersRunning = task.parallel && (await evalIn(ps, CONVERSATIONS).catch(() => [])).some((c) => c.state === "运行中");
      const idle = !snap.abortVisible && !snap.running && !snap.streaming && !othersRunning;
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

    if (task.parallel) {
      const answers = [];

      for (const c of await evalIn(ps, CONVERSATIONS).catch(() => [])) {
        await evalIn(ps, `document.querySelector('#conversation-menu [data-conversation-id="${c.id}"]').click()`);
        await sleep(1500);
        const last = await evalIn(ps, "[...document.querySelectorAll('#messages .msg.assistant')].at(-1)?.innerText ?? ''");
        answers.push(`【${c.title}】（${c.state}）\n${last}`);
      }

      rec.final_answer_verbatim = answers.join("\n\n");
      rec.parallel.conversations = answers.length;
    }

    if (selected) {
      const r = await evalIn(ps, READING_PROBE).catch(() => null);
      rec.reading = r;
      rec.final_answer_verbatim = r?.answer || r?.error || "";
      rec.panel_messages = r ? [{ cls: `reading ${r.state}`, text: rec.final_answer_verbatim }] : [];
      addStep(Date.now(), `reading:${r?.state ?? "none"}`, rec.final_answer_verbatim.slice(0, 300));

      if (r?.state === "error") rec.errors.push(`reading error: ${r.error}`);
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

      if (pageB) rec.final_page_text = `[tab 1] ${rec.final_page_text ?? ""}\n\n[tab 2] ${await evalIn(pageB, "(document.body?.innerText ?? '').slice(0, 15000)").catch(() => "")}`;
    } catch (e) { rec.errors.push(`final page: ${e.message}`); }

    if (task.before_turns || task.memory_check) {
      const memory = await evalIn(ps, `new Promise((ok) => { const q = indexedDB.open("sideagent-memory"); q.onsuccess = () => { const g = q.result.transaction("kv").objectStore("kv").get("memories"); g.onsuccess = () => ok(g.result ?? null); g.onerror = () => ok(null); }; q.onerror = () => ok(null); })`).catch(() => null);
      const doc = memory ? JSON.parse(memory) : null; // document-idb stores the document as JSON text
      const entries = (doc?.entries ?? []).filter((e) => e.status === "active").map((e) => ({ kind: e.kind, scope: e.scope, text: e.text }));
      const dst = join(outDir, `${task.id}.memory.json`);
      writeFileSync(dst, JSON.stringify(entries, null, 1));
      rec.downloads.push({ kind: "memory store after the run (active entries)", name: "memory.json", path: dst, bytes: statSync(dst).size });
    }

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

    if (exported?.length) trace = exported;
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
