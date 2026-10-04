/**
 * 「提取字幕并保存」验收（docs/evals/20261001-data-to-file.md 标准 2，及「共用约定」）。
 * 验收者按合同独立编写，没读实现；期望值全部来自本脚本的练习站接口（独立 oracle）。
 *
 * 只装扩展的隔离无头 Chrome、真侧栏、本机练习站 video.test（解析到本机）：
 * 视频页只有标题和播放器占位，字幕不在页面里；页面脚本里的 __INITIAL_STATE__ 给出视频号与字幕接口地址，
 * 同源接口 /api/subtitle?vid=… 返回 830 条 {from,to,content}（秒，毫秒精度，时间不规则，含英文行，正文 4 万多字）。
 *
 *   npx tsx scripts/acceptance/real-path/data-to-file.mts --headless --scripted
 *     不花钱：脚本模型按合同调用 browser_run 里的 browser.saveFile，只验证这套验收本身与产品通路。
 *     不带 --model 时默认就是脚本模式（run-all 只传 --headless）。
 *   npx tsx scripts/acceptance/real-path/data-to-file.mts --headless --model=opencode-go/deepseek-v4.1-flash
 *   npx tsx scripts/acceptance/real-path/data-to-file.mts --headless --model=custom/<模型>
 *     花钱：真实模型。custom 读环境变量 SIDEAGENT_CUSTOM_BASE_URL / SIDEAGENT_CUSTOM_KEY（见 inproc-config.mts）。
 *   npx tsx scripts/acceptance/real-path/data-to-file.mts --rejudge=<产物目录>
 *     不开浏览器：按现行 file 判据重算该目录的 downloaded-* 文件，写 rejudge.json，原 summary.json 不动。
 *
 * 判定（全部满足才 PASS）：
 *   card       侧栏出现至少一张文件卡片。
 *   file       点每张未删除卡片的「下载」：至少一份完整无损（恰好 830 条，起止毫秒与文字和接口逐条一致；
 *              接受 SRT / VTT、每行「起 止 文字」的 TXT、[{from,to,content}] 的 JSON），且其余每份不含错误内容：
 *              按接口顺序恰好 830 条、文字逐字一致，出现的时间按显示精度取整后一致（只有文字、只开始时间、表格可以）。
 *              编造、缺条、乱序都不通过。规则于 10-01 测量修正，见验收文件。
 *   count      本轮最后一条回答里写了 830。
 *   bounded    发出到本轮结束 ≤ 6 分钟。
 *   noSpin     卡片出现后最多再有 2 次工具调用，且 90 秒内本轮结束（合同「文件出现后本轮结束」，留一次核对的余地）。
 *   setup      诊断导出里这句话的 run_start 当前页是 video.test；否则记 invalid-setup（验收前提不成立，不是产品结论）。
 * 只作证据：工具调用次数与名字、进入模型上下文的工具结果字数、上下文里是否出现字幕原文（脚本模式另有请求原文记录）。
 *
 * 产物：out/acceptance/real-path/<时间>-data-to-file-<scripted|模型>/ 下 summary.json、截图、下载的文件、诊断导出。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json, type JsonRecord } from "./harness.mts";
import { configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

const rejudgeDir = process.argv.find((a) => a.startsWith("--rejudge="))?.slice(10);

if (!rejudgeDir) requireHeadless();

const modelArg = process.argv.find((a) => a.startsWith("--model="))?.slice(8);

const scripted = process.argv.includes("--scripted") || !modelArg;

if (process.argv.includes("--scripted") && modelArg) {
  console.error("二选一：--scripted 或 --model=provider/id");
  process.exit(2);
}

const USER_TEXT = "提取字幕并且保存";

const HOST = "video.test";

const VID = "BV1Fx411c7Kq";

const VIDEO_PATH = `/video/${VID}`;

const SUBTITLE_PATH = `/api/subtitle?vid=${VID}&lan=zh-CN`;

const ENTRY_COUNT = 830;

const TURN_LIMIT_MS = scripted ? 120_000 : 6 * 60_000;

const AFTER_CARD_TOOLS = 2;

const AFTER_CARD_MS = 90_000;

// ══ 练习站：确定性字幕生成（oracle）════════════════════════════════════════════════

type Entry = { fromMs: number; toMs: number; content: string };

function mulberry32(seed: number) {
  let s = seed;

  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZH_HEAD = ["那天晚上", "麦克纳尔蒂", "巴尔的摩西区", "这条线索", "斯金格", "警局里", "码头工会", "法庭上", "奥马尔", "毒品交易", "窃听组", "街角的孩子们", "市长办公室", "老探员", "这一季"];

const ZH_BODY = ["其实早就埋下了伏笔", "说明他根本不信任任何人", "把整个调查拖进了死胡同", "让所有人都措手不及", "是全剧最冷静的一场戏", "把制度的问题摆在了台面上", "暴露了上面的人在算什么账", "第一次把镜头对准了普通工人", "用一句台词就交代了动机", "和第一季的结尾形成了呼应", "看似随意其实每个细节都对得上", "让人重新理解前面几集"];

const ZH_TAIL = ["。", "，你注意看他的眼神。", "，这个很关键。", "，我们后面还会说到。", "，导演故意没有给特写。", "，弹幕里很多人没看出来。", "。"];

const EN = ["All in the game, yo.", "The king stay the king.", "You come at the king, you best not miss.", "A man must have a code.", "This is America, man.", "Lie to me, tell me it's not my fault.", "We used to make shit in this country.", "Rules is rules, but this ain't right.", "Cheese is cheese, product is product.", "The bigger the lie, the more they believe."];

function generateSubtitles(): Entry[] {
  const rand = mulberry32(20261001);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  const seen = new Set<string>();
  const out: Entry[] = [];
  let cursor = 1530;

  for (let i = 0; i < ENTRY_COUNT; i += 1) {
    let content = i % 9 === 4
      ? `${pick(EN)} ${pick(EN)}`
      : `${pick(ZH_HEAD)}${pick(ZH_BODY)}，${pick(ZH_HEAD)}${pick(ZH_BODY)}${rand() < 0.8 ? `，${pick(ZH_BODY)}` : ""}${pick(ZH_TAIL)}`;

    // 每条文字都不同：撞了就补一段，直到唯一。
    while (seen.has(content)) content += i % 9 === 4 ? ` ${pick(EN)}` : pick(ZH_BODY);
    seen.add(content);
    // 起止都避开整秒：模型补写的整秒时间轴一眼可辨（原故障第 494 条起全是整秒）。
    const fromMs = cursor % 1000 === 0 ? cursor + 7 : cursor;
    let toMs = fromMs + 1200 + Math.floor(rand() * 3600);

    if (toMs % 1000 === 0) toMs += 13;
    out.push({ fromMs, toMs, content });
    cursor = toMs + Math.floor(rand() * 900);
  }

  return out;
}

const SUBTITLES = generateSubtitles();

const SUBTITLE_CHARS = SUBTITLES.reduce((n, e) => n + e.content.length, 0);

if (SUBTITLE_CHARS < 40_000) throw new Error(`练习站字幕只有 ${SUBTITLE_CHARS} 字，不到 4 万，起不到「大段数据」的作用`);

/** 用来判断字幕原文有没有进模型上下文的标记：中段一条中文、一条英文。 */
const LEAK_MARKERS = [SUBTITLES[500]!.content, SUBTITLES[ENTRY_COUNT - 3]!.content];

const SUBTITLE_JSON = JSON.stringify({ font_size: 0.4, font_color: "#FFFFFF", lang: "zh-CN", body: SUBTITLES.map((e, i) => ({ sid: i + 1, from: e.fromMs / 1000, to: e.toMs / 1000, location: 2, content: e.content })) });

const VIDEO_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>【火线】第 8–10 集解说：制度如何吞掉每一个人_哔哩哔哩练习站</title></head>
<body style="font:15px/1.6 -apple-system,sans-serif;margin:0;background:#f4f5f7">
<header style="padding:12px 24px;background:#fff;border-bottom:1px solid #e3e5e7"><b>练习站</b> · 视频</header>
<main style="max-width:980px;margin:20px auto">
<h1 style="font-size:20px">【火线】第 8–10 集解说：制度如何吞掉每一个人</h1>
<div style="color:#9499a0;font-size:13px">12.3万播放 · 2026-09-28 · ${VID}</div>
<div id="player" style="position:relative;margin-top:12px;aspect-ratio:16/9;background:#000;border-radius:8px;color:#fff;display:flex;align-items:center;justify-content:center">
  <span>▶ 播放器（练习站占位，不播放）</span>
  <button id="cc" style="position:absolute;right:12px;bottom:12px;background:transparent;color:#fff;border:1px solid #fff;border-radius:4px">字幕</button>
</div>
<p style="margin-top:16px">UP 主：老剧新看 · 简介：把第二季码头线和警局线放在一起讲。</p>
</main>
<script>window.__INITIAL_STATE__ = ${JSON.stringify({ aid: 1145141919, bvid: VID, videoData: { bvid: VID, cid: 284759302, title: "【火线】第 8–10 集解说：制度如何吞掉每一个人", duration: Math.ceil(SUBTITLES.at(-1)!.toMs / 1000), subtitle: { allow_submit: false, list: [{ id: 1, lan: "zh-CN", lan_doc: "中文（自动生成）", subtitle_url: SUBTITLE_PATH }] } } })};</script>
</body></html>`;

const siteLog = { pageHits: 0, subtitleHits: 0 };

function site(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${HOST}`);

  if (url.pathname === "/api/subtitle") {
    if (url.searchParams.get("vid") !== VID) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ code: -404, message: "啥都木有" }));

      return;
    }

    siteLog.subtitleHits += 1;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(SUBTITLE_JSON);

    return;
  }

  if (url.pathname === VIDEO_PATH || url.pathname === "/") {
    siteLog.pageHits += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(VIDEO_PAGE);

    return;
  }

  res.writeHead(404).end();
}

// ══ 文件解析：SRT / VTT / TXT / JSON → 条目 ══════════════════════════════════════════

const CLOCK = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/g;

const clockMs = (m: RegExpMatchArray) => ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]!.padEnd(3, "0"));

type JsonEntry = { from?: number; to?: number; content?: string | null };

type Parsed = { format: string; entries: Entry[]; problems: string[] };

function parseFile(filename: string, text: string): Parsed {
  const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const problems: string[] = [];

  if (/\.json$/i.test(filename) || /^\s*[[{]/.test(body)) {
    try {
      // SAFETY: 只接受 [{from,to,content}] 或 {body:[…]}；外层形状由下面的 Array.isArray 区分，字段缺了逐项判为问题。
      const raw = JSON.parse(body) as { body?: JsonEntry[] } | JsonEntry[];
      const list: JsonEntry[] = Array.isArray(raw) ? raw : Array.isArray(raw.body) ? raw.body : [];

      const entries = list.map((e, i) => {
        if (!Number.isFinite(e.from) || !Number.isFinite(e.to) || e.content === undefined || e.content === null) problems.push(`第 ${i + 1} 项不是 {from,to,content}`);

        return { fromMs: Math.round(Number(e.from) * 1000), toMs: Math.round(Number(e.to) * 1000), content: String(e.content ?? "").trim() };
      });

      return { format: "json", entries, problems };
    } catch (error) {
      // 以「[」开头的 TXT 也会先试 JSON：只有 .json 文件解析失败才算问题。
      if (/\.json$/i.test(filename)) problems.push(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // SRT / VTT：空行分块，块里有「-->」那行是时间轴，之后是文字。
  if (/-->/.test(body) && /\n\s*\n/.test(body)) {
    const entries: Entry[] = [];

    for (const block of body.split(/\n\s*\n/)) {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

      const at = lines.findIndex((l) => l.includes("-->"));

      if (at < 0) continue;
      const clocks = [...lines[at]!.matchAll(CLOCK)];

      if (clocks.length < 2) { problems.push(`时间轴读不出起止：${lines[at]!.slice(0, 60)}`); continue; }

      entries.push({ fromMs: clockMs(clocks[0]!), toMs: clockMs(clocks[1]!), content: lines.slice(at + 1).join(" ").trim() });
    }

    if (entries.length) return { format: body.startsWith("WEBVTT") ? "vtt" : "srt", entries, problems };
  }

  // TXT：一行一条，行里两个时间（时:分:秒.毫秒，或纯秒数 12.345），其余是文字。
  const entries: Entry[] = [];

  for (const line of body.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const clocks = [...line.matchAll(CLOCK)];

    let fromMs: number, toMs: number, rest: string;

    if (clocks.length >= 2) {
      fromMs = clockMs(clocks[0]!);
      toMs = clockMs(clocks[1]!);
      rest = line.slice(clocks[1]!.index! + clocks[1]![0].length);
    } else {
      const secs = line.match(/^\[?\s*(\d+\.\d{1,3})\s*s?\s*(?:-->|-|–|~|→|,)\s*(\d+\.\d{1,3})\s*s?\s*\]?/);

      if (!secs) { problems.push(`这一行没有起止两个时间：${line.slice(0, 60)}`); continue; }

      fromMs = Math.round(Number(secs[1]) * 1000);
      toMs = Math.round(Number(secs[2]) * 1000);
      rest = line.slice(secs[0].length);
    }

    entries.push({ fromMs, toMs, content: rest.replace(/^[\s\]):：|\t-]+/, "").trim() });
  }

  return { format: "txt", entries, problems };
}

/** 逐条与接口比对：条数、起止毫秒、文字（去首尾空白）。 */
function compare(parsed: Parsed): JsonRecord & { ok: boolean } {
  const got = parsed.entries;
  const mismatches: JsonRecord[] = [];

  for (let i = 0; i < Math.max(got.length, SUBTITLES.length); i += 1) {
    const g = got[i];
    const want = SUBTITLES[i];

    if (!g || !want || g.fromMs !== want.fromMs || g.toMs !== want.toMs || g.content !== want.content.trim()) {
      mismatches.push({ index: i + 1, got: g ? { fromMs: g.fromMs, toMs: g.toMs, content: g.content.slice(0, 60) } : null, want: want ? { fromMs: want.fromMs, toMs: want.toMs, content: want.content.slice(0, 60) } : null });
    }
  }

  // 原故障的签名：从某条起时间轴全是整秒（模型补写）。
  const wholeSecond = got.filter((e) => e.fromMs % 1000 === 0 && e.toMs % 1000 === 0).length;

  return {
    ok: got.length === ENTRY_COUNT && mismatches.length === 0,
    format: parsed.format, entries: got.length, expected: ENTRY_COUNT, mismatchCount: mismatches.length,
    firstMismatches: mismatches.slice(0, 5), wholeSecondEntries: wholeSecond, parseProblems: parsed.problems.slice(0, 5), parseProblemCount: parsed.problems.length,
    lastEntry: got.at(-1) ? { fromMs: got.at(-1)!.fromMs, toMs: got.at(-1)!.toMs } : null,
  };
}

/**
 * 有损但正确的附带文件（测量修正，见验收文件）：只有文字、只有开始时间、表格等。
 * 判据：恰好按接口顺序含全部 830 条（不缺、不多、不乱序），每条文字逐字一致；
 * 出现的时间按显示精度向下取整后与接口一致（第一个时间对开始，第二个对结束，多于两个算错）。
 * 第一条之前最多 8 行对不上字幕的行算表头/标题（标题、视频号、条数、来源等，可含数字和时间）；之后出现对不上的行算编造。
 */
/** 附带文件开头允许的表头行数（10-01 MiniMax 的纯文字版前面有 3 行说明）。 */
const MAX_HEADER_LINES = 8;

const TS = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3})(?![\d:]))?/g;

const SECS = /(?<![\d.:])(\d+)\.(\d{1,3})(?![\d.:])/g;

const SEPARATORS = /^[\s\d,.:;|[\](){}"'\-–—>~→#\t\uFEFF]*$/;

type Shown = { ms: number; unitMs: number };

const agrees = (shown: Shown, apiMs: number) => Math.floor(apiMs / shown.unitMs) * shown.unitMs === shown.ms;

function shownTimes(residue: string) {
  const clocks = [...residue.matchAll(TS)];

  if (clocks.length) {
    const times: Shown[] = clocks.map((m) => {
      const unitMs = m[4] ? 10 ** (3 - m[4].length) : 1000;

      return { ms: ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + (m[4] ? Number(m[4]) * unitMs : 0), unitMs };
    });

    return { times, rest: residue.replace(TS, " ") };
  }

  const secs = [...residue.matchAll(SECS)];

  return { times: secs.map((m): Shown => ({ ms: Number(m[1]) * 1000 + Number(m[2]!.padEnd(3, "0")), unitMs: 10 ** (3 - m[2]!.length) })), rest: residue.replace(SECS, " ") };
}

function lossyCheck(filename: string, text: string): JsonRecord & { ok: boolean } {
  const body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const problems: string[] = [];
  let matched = 0;
  let preamble = 0;
  let timedEntries = 0;

  if (/\.json$/i.test(filename)) {
    const parsed = parseFile(filename, text);
    parsed.entries.forEach((e, i) => {
      const want = SUBTITLES[i];

      if (!want || e.content !== want.content) problems.push(`第 ${i + 1} 项文字对不上`);
      else if ((Number.isFinite(e.fromMs) && e.fromMs !== want.fromMs) || (Number.isFinite(e.toMs) && e.toMs !== want.toMs)) problems.push(`第 ${i + 1} 项时间对不上`);
    });
    matched = parsed.entries.length;

    if (matched !== ENTRY_COUNT) problems.push(`有 ${matched} 项，应为 ${ENTRY_COUNT}`);

    return { ok: problems.length === 0, entries: matched, problemCount: problems.length, problems: problems.slice(0, 5) };
  }

  const records = /-->/.test(body) && /\n\s*\n/.test(body) ? body.split(/\n\s*\n/) : body.split("\n");

  for (const record of records.map((r) => r.trim()).filter(Boolean)) {
    const want = SUBTITLES[matched];
    const at = want ? record.indexOf(want.content) : -1;

    if (at < 0) {
      if (matched === 0 && preamble < MAX_HEADER_LINES) { preamble += 1; continue; }

      problems.push(matched >= ENTRY_COUNT ? `830 条之后多出一行：${record.slice(0, 60)}` : `第 ${matched + 1} 条应为「${want!.content.slice(0, 20)}…」，文件里是：${record.slice(0, 60)}`);

      if (problems.length >= 20) break;
      continue;
    }

    const { times, rest } = shownTimes(record.slice(0, at) + " " + record.slice(at + want!.content.length));

    if (!SEPARATORS.test(rest)) problems.push(`第 ${matched + 1} 条多出文字：${rest.trim().slice(0, 40)}`);
    else if (times.length > 2) problems.push(`第 ${matched + 1} 条有 ${times.length} 个时间`);
    else if ((times[0] && !agrees(times[0], want!.fromMs)) || (times[1] && !agrees(times[1], want!.toMs))) problems.push(`第 ${matched + 1} 条时间对不上：${record.slice(0, at).trim().slice(0, 60)}`);

    if (times.length) timedEntries += 1;
    matched += 1;
  }

  if (matched !== ENTRY_COUNT) problems.push(`按顺序对上 ${matched} 条，应为 ${ENTRY_COUNT}`);

  return { ok: problems.length === 0, entries: matched, timedEntries, preambleLines: preamble, problemCount: problems.length, problems: problems.slice(0, 5) };
}

/**
 * file 判据：至少一份完整无损（830 条、起止毫秒、文字全对），其余每份都不含错误内容（lossyCheck）。
 * 下载失败的卡片算不通过。
 */
function judgeFiles(downloaded: Array<{ filename: string; text: string | null }>) {
  const files = downloaded.map(({ filename, text }) => {
    if (text === null) return { filename, chars: 0, fullFidelity: false, ok: false, error: "点「下载」后没有得到文件", full: null, lossy: null };
    const full = compare(parseFile(filename, text));
    // 完整无损的文件不再做有损检查：lossy 记 null。
    const lossy = full.ok ? null : lossyCheck(filename, text);

    return { filename, chars: text.length, fullFidelity: full.ok, ok: full.ok || lossy!.ok, error: null, full, lossy };
  });

  return { ok: files.some((f) => f.fullFidelity) && files.every((f) => f.ok), files };
}

// ══ 脚本模型（--scripted）：按合同用 browser.saveFile 存文件 ═══════════════════════════

const SCRIPTED_PROGRAM = `
const state = (await browser.js({ code: "(() => window.__INITIAL_STATE__)()" })).value;
const url = state.videoData.subtitle.list[0].subtitle_url;
const data = (await browser.js({ code: "fetch(" + JSON.stringify(url) + ").then((r) => r.json())" })).value;
const pad = (n, w) => String(n).padStart(w, "0");
const clock = (s) => { const ms = Math.round(s * 1000); return pad(Math.floor(ms / 3600000), 2) + ":" + pad(Math.floor(ms / 60000) % 60, 2) + ":" + pad(Math.floor(ms / 1000) % 60, 2) + "," + pad(ms % 1000, 3); };
const srt = data.body.map((e, i) => (i + 1) + "\\n" + clock(e.from) + " --> " + clock(e.to) + "\\n" + e.content + "\\n").join("\\n");
const receipt = await browser.saveFile({ filename: "subtitles.srt", content: srt });
return { entries: data.body.length, receipt };
`;

const RULES: Rule[] = [{
  match: USER_TEXT,
  steps: [
    { tool: { name: "browser_run", args: { label: "取字幕接口并存成文件", code: SCRIPTED_PROGRAM } } },
    { text: `已把这个视频的 ${ENTRY_COUNT} 条字幕存成 subtitles.srt，侧栏里点「下载」即可。` },
  ],
}];

type ChatMessage = { role: string; content?: string | Array<{ text?: string }> | null };

const textOf = (c: ChatMessage["content"]) => Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : c ?? "";

/** 脚本模式的代理：转发给脚本模型，记下每次请求里工具结果的字数，以及字幕原文是否进了上下文。 */
async function startRecordingModel() {
  const upstream = await startScriptedModel(RULES);
  const origin = new URL(upstream.baseUrl).origin;
  const log: Array<{ toolMessages: number; toolChars: number; leaked: boolean }> = [];

  const server = createServer(async (req, res) => {
    let payloadText = "";

    for await (const part of req) payloadText += part;

    if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
      // SAFETY: OpenAI 兼容请求体。
      const messages = (JSON.parse(payloadText) as { messages?: ChatMessage[] }).messages ?? [];
      const tools = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
      const all = messages.map((m) => textOf(m.content)).join("\n");
      log.push({ toolMessages: tools.length, toolChars: tools.reduce((n, t) => n + t.length, 0), leaked: LEAK_MARKERS.some((m) => all.includes(m)) });
    }

    try {
      const reply = await fetch(origin + (req.url ?? "/"), { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" ? undefined : payloadText });

      if (!res.headersSent) res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" });

      for await (const chunk of reply.body ?? []) res.write(chunk);
    } catch { /* 连接被中断 */ }

    res.end();
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  return { baseUrl: `http://127.0.0.1:${siteAddress(server).port}/v1`, log, close: async () => { server.closeAllConnections(); server.close(); await upstream.close(); } };
}

/** summary.json 里 checks 的形状（本脚本写入）。 */
type SummaryChecks = { card?: boolean; file?: boolean; count?: boolean; bounded?: boolean; noSpin?: boolean; setup?: boolean };

// ══ 重判（--rejudge=<产物目录>）：不开浏览器，只按现行 file 判据重算下载下来的文件 ═══════════

if (rejudgeDir) {
  const names = (await readdir(rejudgeDir)).filter((n) => /^downloaded-\d+-/.test(n)).sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  const downloaded = await Promise.all(names.map(async (n) => ({ filename: n.replace(/^downloaded-\d+-/, ""), text: await readFile(join(rejudgeDir, n), "utf8") })));
  const judged = judgeFiles(downloaded);
  // SAFETY: 本脚本写的 summary.json：{status, checks:{…布尔}, …}。
  const original = JSON.parse(await readFile(join(rejudgeDir, "summary.json"), "utf8")) as { status?: string; checks?: SummaryChecks };
  const checksNow: SummaryChecks = { ...original.checks, file: judged.ok };
  const productOk = [checksNow.card, checksNow.file, checksNow.count, checksNow.bounded, checksNow.noSpin].every((v) => v === true);
  const statusNow = checksNow.setup === false ? "invalid-setup" : productOk ? "pass" : "fail";

  await writeFile(join(rejudgeDir, "rejudge.json"), JSON.stringify({
    rule: "测量修正 2026-10-01：至少一份完整无损，其余文件不含错误内容（见 docs/evals/20261001-data-to-file.md）",
    rejudgedAt: new Date().toISOString(), originalStatus: original.status ?? null, originalFile: original.checks?.file ?? null, status: statusNow, checks: checksNow, files: judged.files,
  }, null, 2));

  for (const f of judged.files) console.log(`  ${f.ok ? "ok " : "BAD"} ${f.fullFidelity ? "完整" : "附带"} ${String(f.filename)} ${JSON.stringify(f.lossy ?? {}).slice(0, 300)}`);
  console.log(`${statusNow.toUpperCase()} data-to-file 重判（原 ${original.status}）${JSON.stringify(checksNow)} ${join(rejudgeDir, "rejudge.json")}`);
  process.exit(statusNow === "pass" ? 0 : 1);
}

// ══ 运行 ═════════════════════════════════════════════════════════════════════════

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-data-to-file-${modelArg ? modelArg.replace(/[^a-z0-9.-]+/gi, "_") : "scripted"}`);

await mkdir(artifacts, { recursive: true });

const plan = modelArg ? await loadModelPlan(modelArg) : null;

const siteServer = createServer(site);

await new Promise<void>((done) => siteServer.listen(0, "127.0.0.1", done));

const model = scripted ? await startRecordingModel() : null;

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${siteAddress(siteServer).port}`, "--no-proxy-server"] });

const PANEL = `(() => {
  const q = (s) => document.querySelector(s);
  const replies = [...document.querySelectorAll("#messages .msg.assistant")];
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    ready: q("#send-btn")?.disabled === false,
    busy: !!(q("#status-pill")?.classList.contains("running") || q("#send-btn")?.classList.contains("stopping") || q(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
    userMessages: document.querySelectorAll("#messages .msg.user").length,
    replies: document.querySelectorAll("#messages .msg:not(.user)").length,
    lastReply: replies.at(-1)?.innerText ?? "",
    cards: [...document.querySelectorAll(".artifact-card")].map((el) => ({ filename: el.dataset.filename ?? "", deleted: el.dataset.deleted === "true", meta: el.querySelector(".artifact-meta")?.textContent ?? "" })),
  };
})()`;

type Card = { filename: string; deleted: boolean; meta: string };

type PanelState = { connected: boolean; ready: boolean; busy: boolean; userMessages: number; replies: number; lastReply: string; cards: Card[] };

let panel = "";

let work = "";

let workTargetId = "";

let ext = "";

const read = async (): Promise<PanelState> => {
  // SAFETY: PANEL 返回的字段与 PanelState 一一对应。
  return (await rp.evaluate(panel, PANEL)) as PanelState;
};

const hostOf = (url: string) => {
  try { return new URL(url).hostname; } catch { return ""; }
};

/** 把练习站设为窗口里的当前标签页（侧栏读的就是它）；CDP 激活之外再用扩展的 tabs API 核对（见 remember-corrections.mts）。 */
async function focusSite() {
  await rp.cdp.send("Target.activateTarget", { targetId: workTargetId });
  await rp.cdp.send("Page.bringToFront", {}, work);
  const activeUrl = String(await rp.evaluate(ext, `chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.url ?? "")`));

  if (hostOf(activeUrl) === HOST) return activeUrl;

  await rp.evaluate(ext, `(async () => { const tabs = await chrome.tabs.query({ currentWindow: true });
    const t = tabs.find((x) => { try { return new URL(x.url).hostname === ${JSON.stringify(HOST)}; } catch { return false; } });
    if (t) await chrome.tabs.update(t.id, { active: true }); return !!t; })()`);
  await sleep(300);

  return String(await rp.evaluate(ext, `chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.url ?? "")`));
}

async function shot(session: string, name: string) {
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, session).catch(() => undefined);
  await sleep(300);
  await rp.screenshot(session, join(artifacts, `${name}.png`)).catch(() => undefined);
}

/** 像用户一样点卡片上的「下载」，返回落到下载文件夹的文件内容。 */
async function downloadCard(filename: string, n: number): Promise<string | null> {
  const dir = join(rp.dirs.downloads, `card-${n}`);
  await mkdir(dir, { recursive: true });
  await rp.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  const sel = `.artifact-card[data-filename=${JSON.stringify(filename)}] .artifact-download`;
  await rp.evaluate(panel, `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" }); true`);
  await sleep(300);
  await rp.click(panel, sel);

  const name = await until(async () => (await readdir(dir)).find((f) => !f.endsWith(".crdownload")), 15_000, `下载 ${filename}`).catch(() => null);

  return name ? readFile(join(dir, name), "utf8") : null;
}

type TraceLine = { time: string; type: string; data: JsonRecord; raw: string };

function parseTraces(text: string): TraceLine[] {
  return text.split("\n").filter(Boolean).flatMap((raw) => {
    try {
      // SAFETY: 导出一行一个 JSON 对象（shared/run-trace-core.ts：{time, sessionId, runId, turn, type, data}）。
      const o = JSON.parse(raw) as { time?: string; type?: string; data?: JsonRecord };

      return [{ time: String(o.time ?? ""), type: String(o.type ?? ""), data: o.data ?? {}, raw }];
    } catch { return []; }
  });
}

/** 工具结果进模型上下文的文字：tool_execution_end 的 result.content 里的 text；记录过大被截时用原始字节数。 */
function toolResultChars(line: TraceLine): number {
  // SAFETY: Pi 的 tool_execution_end 带 result: {content:[{type,text}]}；缺了按 0 算。
  const content = (line.data.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];

  return content.reduce((n, part) => n + (part.type === "text" ? (part.text ?? "").length : 0), 0);
}

const checks: JsonRecord = {};

const evidence: JsonRecord = { subtitleChars: SUBTITLE_CHARS, entryCount: ENTRY_COUNT };

let status: "pass" | "fail" | "invalid-setup" = "fail";

let fatal: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  workTargetId = blank.targetId;
  work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
  await rp.cdp.send("Page.navigate", { url: `http://${HOST}${VIDEO_PATH}` }, work);
  await until(async () => (await rp.evaluate(work, `location.hostname === ${JSON.stringify(HOST)} && document.readyState === "complete"`).catch(() => false)) || undefined, 15_000, "打开练习站");
  await focusSite();
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, work);

  if (model) {
    const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
    await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  } else {
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan!))}).then(() => true)`);
  }

  await until(async () => {
    const s = await read();

    return s.connected && s.ready ? s : undefined;
  }, 90_000, "侧栏就绪", 500);
  await sleep(800);

  // 发话前把练习站设为当前页。
  evidence.activeUrlBeforeSend = await focusSite();
  await shot(work, "page");
  const before = await read();
  const sentAt = Date.now();
  await rp.click(panel, "#input");
  await rp.typeText(panel, USER_TEXT);
  await rp.pressEnter(panel);

  if (!(await until(async () => (await read()).userMessages > before.userMessages || undefined, 5_000, "消息发出").catch(() => false))) await rp.click(panel, "#send-btn");
  await until(async () => (await read()).userMessages > before.userMessages || undefined, 10_000, "消息发出");

  // 等这一轮结束；同时记下文件卡片第一次出现的时刻。
  let cardSeenAt: number | null = null;
  let idle = 0;

  while (Date.now() - sentAt < TURN_LIMIT_MS && idle < 12) {
    const s = await read().catch(() => null);

    if (s && cardSeenAt === null && s.cards.some((c) => !c.deleted)) cardSeenAt = Date.now();
    idle = s && !s.busy && s.replies > before.replies && Date.now() - sentAt > 3000 ? idle + 1 : 0;
    await sleep(250);
  }

  const endedAt = Date.now() - (idle >= 12 ? 12 * 250 : 0);
  const finished = idle >= 12;
  await sleep(1500);
  const after = await read();
  await shot(panel, "panel-after-turn");

  evidence.elapsedMs = endedAt - sentAt;
  evidence.finished = finished;
  evidence.cardSeenAfterMs = cardSeenAt === null ? null : cardSeenAt - sentAt;
  evidence.cards = after.cards;
  evidence.lastReply = after.lastReply.slice(0, 600);

  // 卡片与文件。
  const live = after.cards.filter((c) => !c.deleted);
  checks.card = live.length > 0;
  const downloaded: Array<{ filename: string; text: string | null }> = [];

  for (const [i, card] of live.entries()) {
    const text = await downloadCard(card.filename, i + 1);

    if (text !== null) await writeFile(join(artifacts, `downloaded-${i + 1}-${card.filename}`), text);
    downloaded.push({ filename: card.filename, text });
  }

  const judged = judgeFiles(downloaded);
  evidence.files = judged.files;
  checks.file = judged.ok;
  checks.count = new RegExp(`(?<!\\d)${ENTRY_COUNT}(?!\\d)`).test(after.lastReply);
  checks.bounded = finished && endedAt - sentAt <= 6 * 60_000;

  // 诊断：当前页核对、工具调用、进上下文的字数。
  const exported = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(rp.dirs.downloads, "export"));
  await writeFile(join(artifacts, "diagnostics.jsonl"), exported.traces);
  const lines = parseTraces(exported.traces);
  const runStart = lines.find((l) => l.type === "run_start" && String(l.data.text ?? "") === USER_TEXT);
  // SAFETY: run_start 的 context 是 {tabId,title,url}；缺了就是空串，判为当前页不对。
  const seenUrl = runStart ? String((runStart.data.context as JsonRecord | null | undefined)?.url ?? "") : null;
  evidence.runStartUrl = seenUrl;
  const setupOk = seenUrl !== null && hostOf(seenUrl) === HOST;

  const starts = lines.filter((l) => l.type === "tool_execution_start");
  const ends = lines.filter((l) => l.type === "tool_execution_end");
  evidence.toolCalls = starts.length;
  evidence.toolNames = starts.map((l) => String(l.data.toolName ?? ""));
  evidence.programSteps = lines.filter((l) => l.type === "program_step").length;
  evidence.toolResultCharsToContext = ends.reduce((n, l) => n + toolResultChars(l), 0);
  evidence.toolResultLargest = ends.reduce((n, l) => Math.max(n, toolResultChars(l)), 0);
  evidence.toolResultRecordsTruncated = lines.filter((l) => l.raw.includes("\"record size limit\"")).length;
  evidence.subtitleTextInToolResults = ends.some((l) => LEAK_MARKERS.some((m) => l.raw.includes(m)));
  const afterCard = cardSeenAt === null ? [] : starts.filter((l) => Date.parse(l.time) > cardSeenAt!);
  evidence.toolsAfterCard = afterCard.map((l) => String(l.data.toolName ?? ""));
  checks.noSpin = cardSeenAt !== null && finished && afterCard.length <= AFTER_CARD_TOOLS && endedAt - cardSeenAt <= AFTER_CARD_MS;

  if (model) evidence.scriptedRequests = model.log;
  evidence.siteLog = siteLog;
  checks.setup = setupOk;

  const productOk = ["card", "file", "count", "bounded", "noSpin"].every((k) => checks[k] === true);
  status = !setupOk ? "invalid-setup" : productOk ? "pass" : "fail";
} catch (error) {
  fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(fatal);

  if (panel) await shot(panel, "error");
} finally {
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  await model?.close().catch(() => undefined);
  siteServer.closeAllConnections();
  siteServer.close();
}

if (fatal) status = "fail";

const summary: Json = {
  case: "data-to-file", contract: "docs/evals/20261001-data-to-file.md#2", startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  mode: { scripted, model: modelArg ?? null }, userText: USER_TEXT, status, checks, evidence, fatal,
};

await writeFile(join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`${status.toUpperCase()} data-to-file ${JSON.stringify(checks)} ${artifacts}${status === "invalid-setup" ? "（验收前提不成立，不是产品结论）" : ""}`);

process.exit(status === "pass" ? 0 : 1);
