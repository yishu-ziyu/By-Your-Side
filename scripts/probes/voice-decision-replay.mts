import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fastOpContent, parseFastDecision, VOICE_FAST_OP_PROMPT } from "../../agent/src/voice-fast-op.js";
import type { VoicePageState } from "../../shared/voice-page-op.js";

const card = (row: number, col: number) => ({ row, col, title: `视频${row}-${col}`, url: `https://www.youtube.com/watch?v=r${row}c${col}` });
const HOME: VoicePageState = { url: "https://www.youtube.com/", title: "YouTube", media: null, hasNext: false, cards: [1, 2].flatMap(r => [1, 2, 3].map(c => card(r, c))) };
const BILI: VoicePageState = { ...HOME, url: "https://www.bilibili.com/", title: "哔哩哔哩" };
const WATCH: VoicePageState = { url: "https://www.youtube.com/watch?v=r1c1", title: "视频1-1", media: { playing: true, currentTime: 40, duration: 300 }, hasNext: true, cards: [] };

type Expected = string | string[];
const CASES: Array<{ text: string; page: VoicePageState; recent?: string[]; expect: Expected }> = [
  { text: "嗨你好", page: HOME, expect: "chat" },
  { text: "打开YouTube", page: BILI, expect: "task" },
  { text: "聊天切换到YouTube的那个页面OK,然后点击第一行的第一个视频", page: BILI, expect: "task" },
  { text: "拖动到三分十二秒", page: WATCH, expect: "seek:192" },
  { text: "暂停音乐的 播放", page: WATCH, expect: "pause" },
  { text: "Hi, 晚 上好", page: HOME, expect: "chat" },
  { text: "帮我打开一下YouTube", page: BILI, expect: "task" },
  { text: "同时打开一个新的bilibili主页,然后定位到 收藏夹,然后 YouTube 点 进 第一 行的 第二 个 视频", page: HOME, expect: "task" },
  { text: "默认模型换一个,因为现在ChatGPT它没有那个,所以我给它换一个", page: HOME, expect: "chat" },
  { text: "嗨,你好", page: HOME, expect: "chat" },
  { text: "今天 怎么样", page: HOME, expect: "chat" },
  { text: "能看到当前的页面是什么吗", page: HOME, expect: "task" },
  { text: "嗯,打开第一行的 第三个 视频", page: HOME, expect: "open:1-3" },
  { text: ",尝试获取它的 字幕", page: WATCH, expect: "task" },
  { text: "可以,你先暂停视频", page: WATCH, expect: "pause" },
  { text: "没有暂停啊", page: WATCH, recent: ["可以,你先暂停视频"], expect: ["pause", "task"] },
  { text: "重新试了一下,你读一下日志,然后再分析一下,我觉得他依旧很糟糕", page: WATCH, expect: "chat" },
  { text: "你好", page: HOME, expect: "chat" },
  { text: "打开YouTube", page: BILI, expect: "task" },
  { text: "打开bilibili", page: HOME, expect: "task" },
  { text: "切换到bilibili的页面", page: HOME, expect: "task" },
  { text: "切换到YouTube页面", page: BILI, expect: "task" },
  { text: "打开第二行", page: HOME, expect: "listen" },
  { text: "第一个视频", page: HOME, recent: ["打开第二行"], expect: "open:2-1" },
  { text: "调错 了,我 说 是 第二 行 第 一个,第一 行 第 一个", page: WATCH, recent: ["打开第二行", "第一个视频"], expect: "task" },
  { text: "第二行 第 一个", page: WATCH, recent: ["打开第二行", "第一个视频"], expect: "task" },
];

const MODEL = process.argv.find(a => a.startsWith("--model="))?.slice(8) ?? "MiniMax-M3.1-Flash-Preview";
const key = (JSON.parse(readFileSync(join(homedir(), ".sideagent/providers.local.json"), "utf8")) as { "minimax-cn": { key: string } })["minimax-cn"].key;

function label(raw: string, page: VoicePageState): string {
  const d = parseFastDecision(raw, page);
  if (d.op === "seek") return `seek:${d.seconds}`;
  if (d.op === "open") return `open:${d.card.row}-${d.card.col}`;
  return d.op;
}

async function decide(c: (typeof CASES)[number]): Promise<{ got: string; ms: number }> {
  const started = Date.now();
  const res = await fetch("https://api.minimaxi.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 2000, messages: [{ role: "system", content: VOICE_FAST_OP_PROMPT }, { role: "user", content: fastOpContent(c.text, c.page, c.recent ?? []) }] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { got: `http_${res.status}`, ms: Date.now() - started };
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  try { return { got: label(raw, c.page), ms: Date.now() - started }; } catch { return { got: `invalid(${raw.slice(0, 40)})`, ms: Date.now() - started }; }
}

const started = Date.now();
const results: Array<{ got: string; ms: number }> = [];
let next = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (next < CASES.length) {
    const at = next++;
    results[at] = await decide(CASES[at]!).catch(error => ({ got: `http_${error instanceof Error ? error.name : "error"}`, ms: Date.now() - started }));
  }
}));
let wrong = 0, skipped = 0;
results.forEach((r, i) => {
  const c = CASES[i]!;
  const notRun = r.got.startsWith("http_");
  const ok = [c.expect].flat().includes(r.got);
  if (notRun) skipped += 1;
  else if (!ok) wrong += 1;
  console.log(`${notRun ? "没跑" : ok ? "对" : "错"}  ${c.text.slice(0, 34).padEnd(34)}  应为 ${[c.expect].flat().join("/")}  实际 ${r.got}  ${r.ms}ms`);
});
console.log(`\n对 ${CASES.length - wrong - skipped}，错 ${wrong}，没跑 ${skipped}（共 ${CASES.length}），模型 ${MODEL}，总耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
process.exit(wrong || skipped ? 1 : 0);
