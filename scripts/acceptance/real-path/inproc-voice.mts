/**
 * 语音迁移验收：只装扩展、不装伴随进程，语音在扩展里连 StepFun，完成一句真实语音请求。
 *
 *   --case=question  问页面内容："这个页面上的备注写的是什么"，回答要包含页面上的备注
 *   --case=mark      语音操作："帮我把保存按钮圈出来，不要点它"，圈要盖住「保存」且按钮没被点
 *   --case=chat      闲聊："我今天有点累，陪我聊两句吧。"，只留回答原文，供人判断人设语气
 *   --case=opinion   闲聊："你觉得这个页面做得怎么样？"，同上，是人设示例之外的留出题
 *   --case=barge-in   插话：先请它讲个长故事，回答播到一半时问备注；旧回答要在开口后马上停声，新问题照常回答
 *   --case=stop-task  点选等待中：问候照常回答、停声不停任务；说“终止任务”直接终止原任务，回执前不宣称已停，旧要求不能复活
 *   --case=ask-status 任务在跑时问「任务结束了吗？」：问句不是终止，原任务照常在跑，助手照常回答（文字模型用本机脚本模型拖住任务）
 *
 * 麦克风是 macOS say 合成的中文 WAV（Chrome 假设备只放一遍）。语音密钥来自 ~/.sideagent/stepfun-api.key，
 * 文字模型来自 ~/.sideagent/providers.local.json（--model=provider/id，默认 kimi-coding/kimi-for-coding）。
 *
 *   --voice=<音色>   先在设置页点选音色，再核对服务端 session.updated 回显的就是它
 *   --lead=<ms>      开头静音时长（默认 6000）；--lead=300 相当于点完麦克风马上开口，会话此时还没就绪
 *
 * 问答、圈画、闲聊用例另记开口时间线（result.opening）：开麦、握手帧、首帧音频、服务端断句与转写相对开麦的毫秒数，
 * 以及发给服务端的音频响度。判据 speechDelivered 比较 WAV 里的人声时长和实际发给服务端的人声时长，不依赖服务端断句。
 *
 *   npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=mark
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { JsonRecord } from "./harness.mts";
import { loadModelPlan, modelStorageItems } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { STEP_VOICES, STEP_VOICE_STORAGE_KEY, VOICE_PERSONA_STORAGE_KEY, VOICE_PERSONAS } from "../../../shared/voice.ts";
import { MODEL } from "../../../agent/src/realtime-voice-connection.ts";
import { finishRealtimeTiming, firstAudiblePlayback, installRealtimeTiming } from "./realtime-timing.ts";
import { installMarkTiming, readMarkTiming, installReadOnlyTiming, readReadOnlyTiming, installTaskTiming, readTaskTiming } from "./realtime-page.ts";
import { makeLongIdleWav } from "./realtime-long-wav.ts";
import { makeBackchannelWav, makeInterruptWav } from "./realtime-fixture-wav.ts";
import { interceptBrowserTask } from "./scripted-task-intercept.ts";
import { RESEARCH_COMPANIES, researchPage } from "./realtime-research-page.ts";
import { researchTaskRule } from "./realtime-research-script.ts";

requireHeadless();

/** 导出的语音记录一行：本机同格式的公共字段；text 只在 asr / text / forward 行上有。 */
const VoiceLineSchema = Type.Object({ at: Type.Number(), voiceId: Type.String(), type: Type.String(), text: Type.Optional(Type.String()) });

type VoiceLine = Static<typeof VoiceLineSchema>;

function parseVoiceLine(raw: string): VoiceLine | null {
  try {
    const value = JSON.parse(raw);

    return Check(VoiceLineSchema, value) ? value : null;
  } catch {
    return null;
  }
}


const isText = (value: Json | undefined): value is string => typeof value === "string";
const GOAL_CHECK_MARK = "You check whether a browser assistant has finished the user's goal";

const caseName = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length) ?? "question";
const scriptBrowserTask = process.argv.includes("--script-browser-task");
const bddResearchStart = process.argv.includes("--bdd=2.1");
const bddResearchProgress = process.argv.includes("--bdd=2.2");
// 断线待播：调研任务在语音连接中断期间核对完成，恢复后应自动播一次；播完再断一次，不得补播。
const m7Reconnect = process.argv.includes("--m7-reconnect");
const speechFormat = process.argv.find(arg => arg.startsWith("--speech-format="))?.slice("--speech-format=".length);
if (speechFormat && !["table", "long", "mixed"].includes(speechFormat)) throw new Error("未知朗读格式用例");
const bddResearch = bddResearchStart || bddResearchProgress || m7Reconnect || !!speechFormat;
const firstUtterance = process.argv.includes("--first-utterance");
if (firstUtterance && caseName !== "question") throw new Error("首句验收只用于页面问答");
const planVoice = process.argv.includes("--plan");
if (planVoice && caseName !== "question") throw new Error("套餐首句验收只用于页面问答");
const mossVoice = process.argv.includes("--moss");
if (scriptBrowserTask && (!mossVoice || !["mark", "research"].includes(caseName) || !process.argv.some(arg => arg.startsWith("--model=minimax-cn/")))) {
  throw new Error("脚本网页任务需要 MOSS、mark/research 场景及真实 MiniMax 分类模型");
}
if (bddResearch && (caseName !== "research" || !scriptBrowserTask || [bddResearchStart, bddResearchProgress, m7Reconnect, !!speechFormat].filter(Boolean).length > 1)) throw new Error("用例 2.1/2.2/断线待播需要分别使用 --case=research --script-browser-task");
if (caseName === "research" && !bddResearch) throw new Error("research 场景需要明确的验收用例");
const m1Case = process.argv.includes("--m1");
if (m1Case && (!mossVoice || caseName !== "question")) throw new Error("M1 需要 --moss --case=question");
const m2aCase = process.argv.includes("--m2a");
if (m2aCase && (!mossVoice || caseName !== "question" || m1Case)) throw new Error("M2a 需要 --moss --case=question");
const m2bCase = process.argv.includes("--m2b");
if (m2bCase && (!mossVoice || caseName !== "question" || m1Case || m2aCase)) throw new Error("M2b 需要 --moss --case=question");
const m3Case = process.argv.includes("--m3");
if (m3Case && (!mossVoice || caseName !== "question" || m1Case || m2aCase || m2bCase)) throw new Error("M3 需要 --moss --case=question");
const m4Case = process.argv.includes("--m4");
if (m4Case && (!mossVoice || caseName !== "question" || m1Case || m2aCase || m2bCase || m3Case)) throw new Error("M4 需要 --moss --case=question");
const m5Case = process.argv.includes("--m5");
if (m5Case && (!mossVoice || caseName !== "question" || m1Case || m2aCase || m2bCase || m3Case || m4Case)) throw new Error("M5 需要 --moss --case=question");
const m8aCase = process.argv.includes("--m8a");
if (m8aCase && (!mossVoice || caseName !== "question" || m1Case || m2aCase || m2bCase || m3Case || m4Case || m5Case)) throw new Error("M8a 需要 --moss --case=question");
const m8aRetryTimeout = process.argv.includes("--m8a-retry-timeout");
if (m8aRetryTimeout && !m8aCase) throw new Error("重试超时对照需要 --m8a");
const m8aTranscriptProbe = process.argv.includes("--m8a-transcript-probe");
if (m8aTranscriptProbe && (!m8aCase || m8aRetryTimeout)) throw new Error("字幕对照需要单独使用 --m8a");
const m8cCase = process.argv.includes("--m8c");
if (m8cCase && (!mossVoice || caseName !== "question" || m1Case || m2aCase || m2bCase || m3Case || m4Case || m5Case || m8aCase)) throw new Error("M8c 需要 --moss --case=question");
const m8bCase = process.argv.includes("--m8b");
if (m8bCase && (!mossVoice || caseName !== "question" || m1Case || m2aCase || m2bCase || m3Case || m4Case || m5Case || m8aCase || m8cCase)) throw new Error("M8b 需要 --moss --case=question");
const blackholeProbe = process.argv.includes("--m8b-blackhole");
if (blackholeProbe && !m8bCase) throw new Error("悬挂连接对照需要 --m8b");
const bddMark = process.argv.includes("--bdd=1.2");
if (bddMark && (!mossVoice || caseName !== "mark")) throw new Error("用例 1.2 需要 --moss --case=mark");
const bddObserve = process.argv.includes("--bdd=1.1");
if (bddObserve && (!mossVoice || caseName !== "question" || m1Case || m2aCase || m2bCase || m3Case || m4Case || m5Case || m8aCase || m8bCase || m8cCase)) throw new Error("用例 1.1 需要 --moss --case=question");
const mossReconnect = mossVoice && process.argv.includes("--interrupt-connection");
if (mossReconnect && caseName !== "question") throw new Error("断线验收只用于 MOSS 页面问答");
const noticeBarge = mossVoice && caseName === "mark" && process.argv.includes("--interrupt-notice");
const realMinimax = mossVoice && caseName === "mark" && process.argv.includes("--real-minimax");
if (bddResearch && process.argv.includes("--real-minimax")) throw new Error("用例 2.1/2.2 不使用结果朗读服务");
if (noticeBarge && realMinimax) throw new Error("朗读打断验收只使用模拟服务");
const m6Case = process.argv.includes("--m6"), m7Case = process.argv.includes("--m7");
if (realMinimax && (bddMark || m6Case)) throw new Error("用例 1.2 和 M6 不允许用 MiniMax 代替 MOSS 应答");
if ((m6Case || m7Case) && (!mossVoice || caseName !== "mark" || bddMark || noticeBarge || m6Case && m7Case)) {
  throw new Error("M6/M7 分别需要 --moss --case=mark，不能与其他用例合并");
}

const QUESTIONS = new Map([["question", "这个页面上的备注写的是什么"], ["mark", "帮我把保存按钮圈出来，不要点它"], ["research", "帮我调研一下这几家公司，列个对比。"], ["stop-task", "终止任务"], ["ask-status", "任务结束了吗？"], ["chat", "我今天有点累，陪我聊两句吧。"], ["opinion", "你觉得这个页面做得怎么样？"], ["barge-in", "等一下，先不讲了，我想问你这个页面上的备注写的是什么"]]);

const QUESTION = m1Case ? "请你仔细看一下这个订单页面里的备注，并告诉我备注完整写了什么内容。"
  : m2aCase ? "我想知道这个页面上的备注里面具体写了什么内容。"
  : m2bCase ? "用三四句话讲个小故事。"
  : m4Case ? "等一下，先别讲了，页面上的备注写的是什么？"
  : m8aCase ? "刚才我说我最喜欢什么颜色？"
  : bddObserve ? "这双鞋底是什么材质"
  : bddMark ? "把尺码表圈出来，不要点。" : QUESTIONS.get(caseName);

if (!QUESTION) throw new Error(`未知用例 ${caseName}，可选：${[...QUESTIONS.keys()].join("、")}`);

const NOTE = "周五前发货";
const M5_NOTE = "请用蓝色包装";

const TURN_LIMIT_MS = m8cCase ? 7_430_000 : m2bCase ? 90_000 : m7Reconnect ? 3 * 60_000 : 2 * 60_000;

const startedAt = new Date();

const artifacts = join(REPO, "out/acceptance/real-path", `${startedAt.toISOString().replace(/[:.]/g, "-")}-inproc-voice-${caseName}`);

await mkdir(artifacts, { recursive: true });
if (m1Case || m2aCase || m2bCase || m3Case || m4Case || m5Case || m6Case || m7Case || m8aCase || m8bCase || m8cCase || bddMark || bddObserve || bddResearch) {
  process.env.SIDEAGENT_RECORD = "1";
  process.env.SIDEAGENT_RECORD_PRESERVE = "1";
  process.env.SIDEAGENT_RECORD_DIR = join(artifacts, "recording");
  if (m8cCase) process.env.SIDEAGENT_RECORD_SKIP_SLOW = "1";
}

// 前面垫静音，后面垫静音让服务端断句。就绪前的人声由侧栏缓冲、就绪后补发。
const wav = join(artifacts, "microphone.wav");

// 终止用例两句：先问候（闸门放行、停声不停任务），再说终止（直接终止，不读回）。
// 先去设置页选音色或人设会多耗几秒，开头静音跟着加长。假麦克风在 getUserMedia 时开始放（实测人声出现在开麦后 lead 毫秒）。
// --lead=<ms>：开头静音。用 --lead=300 模拟用户点完麦克风马上开口（会话还没就绪）。
const leadArg = process.argv.find((arg) => arg.startsWith("--lead="))?.slice(7);

const lead = m8cCase ? 7_230_000 : m8bCase ? 100 : leadArg ? Number(leadArg) : mossReconnect ? 15000 : process.argv.some((arg) => arg.startsWith("--voice=") || arg.startsWith("--persona=")) ? 14000 : 6000;

/** 插话用例的第一句：要一段足够长的回答，第二句开口时它还在念。 */
const STORY = "给我讲一个长一点的故事，慢慢讲。";

const speech = m8aCase ? `[[slnc ${lead}]]我最喜欢的颜色是橘黄色，你觉得怎么样？[[slnc 32000]]${QUESTION}[[slnc 6000]]`
  : m2aCase ? `[[slnc ${lead}]]我想知道这个页面上的[[slnc 1200]]备注里面具体写了什么内容。[[slnc 4000]]`
  : bddResearchProgress ? `[[slnc ${lead}]]${QUESTION}[[slnc 28000]]做到哪一步了？[[slnc 80000]]`
  : bddResearch ? `[[slnc ${lead}]]${QUESTION}[[slnc 110000]]`
  : noticeBarge ? `[[slnc ${lead}]]${QUESTION}[[slnc 4000]]稍等一下，麻烦你告诉我这个页面的备注是什么。[[slnc 4000]]` : caseName === "stop-task" ? `[[slnc ${lead}]]你好。[[slnc 12000]]${QUESTION}[[slnc 8000]]` : caseName === "barge-in" ? `[[slnc ${lead}]]${STORY}[[slnc 20000]]${QUESTION}[[slnc 8000]]` : `[[slnc ${lead}]]${QUESTION}[[slnc 4000]]`;

if (m8cCase) makeLongIdleWav(wav, QUESTION, lead);
else if (m2bCase) makeBackchannelWav(wav, QUESTION, lead);
else if (m4Case) makeInterruptWav(wav, STORY, QUESTION, lead);
else execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", speech]);

/** 人声判定：20 ms 一窗，峰值超过它算有人声。静音和底噪都远低于它。 */
const SPEECH_PEAK = 5000;
let speechEndMs = 0;

/** WAV 里有人声的总时长（毫秒），与发给服务端的音频比较，判断开口有没有被丢。 */
const spokenMs = await readFile(wav).then((bytes) => {
  const data = bytes.indexOf("data") + 8;
  let ms = 0;

  for (let at = data; at + 960 <= bytes.length; at += 960) {
    let peak = 0;

    for (let i = at; i < at + 960; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));

    if (peak > SPEECH_PEAK) { ms += 20; speechEndMs = (at - data + 960) / 48; }
  }

  return ms;
});

const fixtureSpeechKey = realMinimax
  ? (JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8")) as Record<string, { key?: string }>)["minimax-cn"]?.key ?? ""
  : "sk-cp-acceptance-fixture";
if (realMinimax && !/^sk-cp-[\w-]{8,}$/.test(fixtureSpeechKey)) throw new Error("未找到 MiniMax Token Plan 订阅密钥");
let fixtureSpeechHex = "";
if (mossVoice && (caseName === "mark" || m7Reconnect || speechFormat) && !realMinimax && !bddMark && !m6Case) {
  const fixtureWav = join(artifacts, "minimax-fixture.wav");
  const fixtureText = m7Reconnect ? "三家公司已经调研完了。" : bddMark ? "我来帮你圈出尺码表。" : noticeBarge ? "已收到你的要求，正在检查当前页面，找到保存按钮之后会把它标记出来，不会点击它。请稍等，我会再告诉你结果。" : "已圈出保存按钮，没有点击。";
  execFileSync("say", ["-v", "Tingting", "-o", fixtureWav, "--data-format=LEI16@24000", fixtureText]);
  const bytes = await readFile(fixtureWav);
  fixtureSpeechHex = bytes.subarray(bytes.indexOf("data") + 8).toString("hex");
}

const NOTE_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单备注</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:520px;margin:40px auto;padding:0 20px}
textarea{width:100%;height:90px}.actions{margin-top:20px;display:flex;gap:12px}button{padding:8px 18px;font:inherit}</style></head>
<body><h1>订单备注</h1><label for="note">备注</label><textarea id="note">${NOTE}</textarea>
<div class="actions"><button type="button" id="save">保存</button><button type="button" id="cancel">取消</button></div>
<script>window.receipts={save:[],cancel:[]};for(const id of ["save","cancel"])for(const t of ["pointerdown","mousedown","click"])document.getElementById(id).addEventListener(t,()=>receipts[id].push(t));</script></body></html>`;

const SHOE_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>订单备注 - 鞋 A</title>
<style>body{font:16px/1.5 sans-serif;max-width:760px;margin:24px auto;padding:0 20px}img{width:420px;max-width:100%}table{border-collapse:collapse;width:440px;max-width:100%;margin:20px 0}caption{font-weight:bold;text-align:left;padding:6px}td,th{border:1px solid #333;padding:12px}button{padding:8px 18px;margin-right:12px}</style></head>
<body><h1>鞋 A</h1><img src="/sole.svg" alt="鞋底特写"><p>价格：399 元</p>
<table id="size-chart" aria-label="尺码表"><caption>尺码表</caption><thead><tr><th>尺码</th><th>脚长</th><th>脚宽</th></tr></thead><tbody><tr><td>38</td><td>24 cm</td><td>9 cm</td></tr><tr><td>39</td><td>24.5 cm</td><td>9.2 cm</td></tr></tbody></table>
<button id="save" type="button">加入购物车</button><button id="cancel" type="button">收藏</button>
<script>window.receipts={save:[],cancel:[],all:[]};for(const type of ["click","input"])document.addEventListener(type,e=>receipts.all.push(type),true);for(const id of ["save","cancel"])for(const type of ["pointerdown","mousedown","click"])document.getElementById(id).addEventListener(type,()=>receipts[id].push(type));</script></body></html>`;
const SOLE_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="300"><rect width="100%" height="100%" fill="#ece8dd"/><path d="M100 210 Q210 170 300 130 L540 115 Q620 122 700 195 L720 230 L100 230 Z" fill="#58554d"/><path d="M100 230 L720 230 Q730 250 700 255 L120 255 Q100 250 100 230" fill="#202423"/><text x="80" y="64" font-family="sans-serif" font-size="36">鞋底材质：耐磨橡胶</text></svg>`;
const PAGE = bddMark || bddObserve ? SHOE_PAGE : NOTE_PAGE;
const researchVisits: Array<{ at: number; pathname: string }> = [];
const site = createServer((req, res) => {
  if (bddResearch) {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    researchVisits.push({ at: Date.now(), pathname });
    const html = researchPage(pathname);
    return res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(html ?? "not found");
  }
  return req.url === "/sole.svg"
    ? res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" }).end(SOLE_IMAGE)
    : res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const siteOrigin = `http://127.0.0.1:${siteAddress(site).port}`;
const pageUrl = `${siteOrigin}/${bddResearch ? "research" : "note"}`;

// 文字模型：用户选的套餐。Kimi 是订阅登录，只借用 Pi 里当前有效的令牌，不在测试里刷新。
const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? "kimi-coding/kimi-for-coding";

/**
 * ask-status 的原任务只需要一直在跑：文字模型换成本机脚本模型，对这句任务拖着不回。
 * 真模型可能直接用文字反问、任务当场结束，宿主的终止判断就不在场了。
 */
const ASK_STATUS_TASK = "帮我把这个页面上的备注整理一下";

// 长表与混合格式只写练习页上真有的事实，否则目标核对判“没做完”，走不到朗读。
// 长表 8 行：前 5 行要念，后 3 行的内容（未公开、2 家、3 家）只在被截掉的行里出现。
const longRows = [...RESEARCH_COMPANIES.flatMap(c => [`| ${c.name} | 业务 | ${c.business} |`, `| ${c.name} | 融资 | ${c.funding} |`]), "| 已公开融资 | 公司数 | 2 家 |", "| 合计 | 调研公司数 | 3 家 |"];
const longHeard = ["工厂视觉检测", "天使轮", "农田灌溉传感器", "A轮", "废旧电池回收"];
const longCut = ["未公开", "2 家", "3 家", "已公开融资", "合计"];
const tableRows = RESEARCH_COMPANIES.map(c => `| ${c.name} | ${c.business} | ${c.funding} |`);
const speechFinalText = speechFormat === "mixed" ? `# 三家公司调研结果\n**结论**：三家的业务和融资都已查到，来源见[调研页](${siteOrigin}/research)。\n${RESEARCH_COMPANIES.map(c => `- ${c.name}：业务是${c.business}，融资是${c.funding}。`).join("\n")}\n\`\`\`json\n{"fundingKey": "天使轮"}\n\`\`\`\n<b>融资未公开的是丙林虚构公司</b>\n原始页面 ${siteOrigin}/research 。以上来自各公司详情页。`
  : speechFormat === "long" ? ["| 公司 | 项目 | 内容 |", "| --- | --- | --- |", ...longRows].join("\n")
  : speechFormat ? ["| 公司 | 业务 | 融资 |", "| --- | --- | --- |", ...tableRows].join("\n") : undefined;
const holdingModel = bddResearch ? await startScriptedModel([researchTaskRule(siteOrigin, "调研", speechFinalText)])
  : scriptBrowserTask ? await startScriptedModel([
  { match: bddMark ? "尺码表" : "保存", steps: [
    { tool: { name: "mark", args: { target: bddMark ? "#size-chart" : "#save", label: bddMark ? "尺码表" : "保存" } } },
    { text: bddMark ? "已圈出尺码表，没有点击。" : "已圈出保存按钮，没有点击。" },
  ] },
]) : caseName === "ask-status" ? await startScriptedModel([{ match: "备注整理", steps: [{ text: "好的，我整理一下。", delayMs: 180_000 }] }])
  : mossVoice && !process.argv.some(arg => arg.startsWith("--model=")) ? await startScriptedModel([
    ...(caseName === "mark" ? [
      { match: '"lastReply"', steps: [{ text: '{"status":"done","remaining":null}' }] },
      ...(noticeBarge ? [{ match: "稍等一下", steps: [{ text: '{"steps":[{"action":"observe","target":null}]}' }] }] : []),
      { match: '"text":', steps: [{ text: '{"steps":[{"action":"start","target":null}]}' }] },
      { match: bddMark ? "尺码表" : "保存", steps: [
        { tool: { name: "mark", args: { target: bddMark ? "#size-chart" : "#save", label: bddMark ? "尺码表" : "保存" } } },
        { text: bddMark ? "已圈出尺码表，没有点击。" : "已圈出保存按钮，没有点击。" },
      ] },
    ] : []),
    ...(bddObserve ? [{ match: "鞋底", steps: [{ text: '{"steps":[{"action":"observe","target":null}]}' }] }] : []),
    ...(m8aCase ? [{ match: "颜色", steps: [{ text: '{"steps":[{"action":"chat","target":null}]}' }] }] : []),
    { match: "备注", steps: [{ text: '{"steps":[{"action":"observe","target":null}]}' }] },
    { match: "故事", steps: [{ text: '{"steps":[{"action":"chat","target":null}]}' }] },
  ]) : null;

const plan = holdingModel && !scriptBrowserTask ? { providerId: "custom", modelId: "fixture", credential: { type: "api_key", key: "local-fixture" }, baseUrl: holdingModel.baseUrl } : await loadModelPlan(modelArg);

const voiceKey = (await readFile(join(homedir(), mossVoice ? ".sideagent/moss-api.key" : planVoice ? ".sideagent/step-plan.key" : ".sideagent/stepfun-api.key"), "utf8")).trim();

const PANEL_STATE = `(() => {
  const q = (s) => document.querySelector(s);
  return {
    connected: q("#status-dot")?.classList.contains("on") ?? false,
    pill: q("#tab-title-text")?.textContent?.trim() ?? null,
    voiceState: q(".voice-progress")?.dataset.state ?? null,
    voiceStatus: q(".voice-state")?.textContent?.trim() ?? "",
    heard: q(".voice-question")?.textContent?.trim() ?? "",
    answer: q(".voice-answer")?.textContent?.trim() ?? "",
    transcript: q("#messages")?.innerText ?? "",
    taskBusy: !!q("#status-pill.running, #send-btn.stopping, .msg.assistant.streaming, .msg.assistant[data-revealing]"),
  };
})()`;

type PanelState = { connected: boolean; pill: string | null; voiceState: string | null; voiceStatus: string; heard: string; answer: string; transcript: string; taskBusy: boolean };

interface StopFrame { kind: string; at: number; conversationId?: string; runId?: string | null; state?: string; event?: string; action?: string; status?: string; source?: string; requestId?: string; message?: string }

type DomNode = { backendNodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

type Verdict = { status: "yes" | "no" | "unverified"; evidence: JsonRecord };

const verdicts: Record<string, Verdict> = {};

const verdict = (pass: boolean, evidence: JsonRecord): Verdict => ({ status: pass ? "yes" : "no", evidence });

const states: string[] = [];

const taskRouting = { scripted: 0, forwarded: 0, failed: 0 };
let classifierTraceVerified = false;
let traceEvents: Array<{ at: number; runId: string | null; type: string; data: Record<string, unknown> }> = [];
const classifierVerified = (traces: string): boolean => {
  traceEvents = traces.split("\n").flatMap(line => {
    try {
      const entry = JSON.parse(line) as { time?: string; runId?: string; type?: string; data?: Record<string, unknown> };
      return entry.time && entry.type && entry.data ? [{ at: Date.parse(entry.time), runId: entry.runId ?? null, type: entry.type, data: entry.data }] : [];
    } catch { return []; }
  });
  return traceEvents.some(entry => entry.type === "side_call" && entry.data.purpose === "voice_plan"
    && entry.data.model === modelArg && entry.data.outcome === "ok");
};
const result: JsonRecord = { case: `inproc-voice-${caseName}`, startedAt: startedAt.toISOString(), question: QUESTION, model: holdingModel && !scriptBrowserTask ? "local-scripted-classifier" : modelArg, ...(scriptBrowserTask ? { taskRouting } : {}) };

// --native：原先同一段录音走本机伴随进程做对照；本机模式已退役，传了就报错。
if (process.argv.includes("--native")) throw new Error("--native 已随本机模式退役，只能验收扩展内路径");

const voiceArg = process.argv.find((arg) => arg.startsWith("--voice="))?.slice("--voice=".length);

if (voiceArg && !STEP_VOICES.some((v) => v.id === voiceArg)) throw new Error(`未知音色 ${voiceArg}，可选：${STEP_VOICES.map((v) => v.id).join("、")}`);

result.voice = voiceArg ?? null;

// --persona=robin|default|custom：像用户一样在设置页选人设（custom 会填一段描述并保存），再核对发给供应商的会话配置。
const personaArg = process.argv.find((arg) => arg.startsWith("--persona="))?.slice("--persona=".length);

const CUSTOM_PERSONA = "说话干脆利落，像一位老练的船长，偶尔来一句航海比喻。";

if (personaArg && ![...VOICE_PERSONAS.map((p) => p.id), "custom"].includes(personaArg)) throw new Error(`未知人设 ${personaArg}`);

result.persona = personaArg ?? null;

interface PickState { stored: string | null; checked: string | null; all: string[]; lists: number }

interface VoiceFrames { requested: string | null; confirmed: string | null }

const voiceFrames: VoiceFrames = { requested: null, confirmed: null };

result.path = "extension-only";

const stalledSockets = new Set<Socket>();
let stalledConnections = 0;
const stalledServer = blackholeProbe ? createTcpServer(socket => {
  stalledConnections++;
  stalledSockets.add(socket);
  socket.on("close", () => stalledSockets.delete(socket));
  socket.on("error", () => {});
  socket.unref();
}) : null;
if (stalledServer) await new Promise<void>(resolve => stalledServer.listen(0, "127.0.0.1", resolve));
stalledServer?.unref();
const stallAddress = stalledServer?.address();
const blockedHost = stallAddress && typeof stallAddress !== "string" ? `127.0.0.1:${stallAddress.port}` : "~NOTFOUND";
const rp = await launchRealPath({
  microphoneWav: wav,
  ...(m8cCase ? { recordFps: 1 } : {}),
  ...(m8bCase ? { chromeArgs: [`--host-resolver-rules=MAP api.mosi.cn ${blockedHost}`, "--no-proxy-server"] } : {}),
});

let last: PanelState | null = null;

let panelSession: string | null = null;

const providerTimeline: JsonRecord[] = [];

/** 问答/圈画用例的开口时间线；失败超时也要落盘，所以在 finally 里调用。 */
let recordOpening: (() => Promise<void>) | null = null;

/** 插话用例的出声/开口判定；StepFun 挂住导致超时也要落盘，所以同样在 finally 里调用。 */
let recordBargeIn: (() => Promise<void>) | null = null;
let recordM1: (() => Promise<void>) | null = null;
let recordM2a: (() => Promise<void>) | null = null;
let recordM2b: (() => Promise<void>) | null = null;
let recordM4: (() => Promise<void>) | null = null;
let recordM5: (() => Promise<void>) | null = null;
let recordM8a: (() => Promise<void>) | null = null;
let recordM8b: (() => Promise<void>) | null = null;
let recordAnswerLatency: (() => Promise<void>) | null = null;
let recordBddMark: (() => Promise<void>) | null = null;
let recordBddResearch: (() => Promise<void>) | null = null;
let researchFixture: { at: number; visibleNames: string[] } | null = null;
let recordTaskVoice: (() => Promise<void>) | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find((t) => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, page);
  await rp.cdp.send("Page.navigate", { url: pageUrl }, page);
  await until(async () => ((await rp.evaluate(page, bddResearch ? `!!document.querySelector("#research-search")` : `!!document.querySelector("#save")`).catch(() => false)) ? true : undefined), 15_000, "练习页加载");
  if (bddResearch) {
    researchFixture = await rp.evaluate(page, `(() => ({
      at: Date.now(),
      visibleNames: [...document.querySelectorAll("#results a")].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
        .map(node => node.textContent?.trim() ?? "")
    }))()`) as { at: number; visibleNames: string[] };
    result.researchFixture = researchFixture;
    if (!RESEARCH_COMPANIES.every(company => researchFixture!.visibleNames.includes(company.name))) {
      result.fixtureFailure = "开口前公司列表不可见";
      throw new Error("夹具无效：开口前公司列表不可见");
    }
  }

  const panel = await rp.attach(await rp.openSidePanel());
  if (process.env.SIDEAGENT_ACCEPTANCE_DIST) {
    const expected = createHash("sha256").update(await readFile(join(process.env.SIDEAGENT_ACCEPTANCE_DIST, "sidepanel.js"))).digest("hex");
    const actual = await rp.evaluate(panel, "fetch(chrome.runtime.getURL('sidepanel.js')).then(r=>r.arrayBuffer()).then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>[...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join(''))");
    verdicts.preparedPackageLoaded = verdict(actual === expected, { expected, actual });
  }
  panelSession = panel;
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  // 相当于用户在设置里填好文字模型和语音密钥。
  // --shared-voice-key：不单独填语音 key，靠阶跃星辰模型的 key（需配合 --model=stepfun/…）。
  const sharedVoiceKey = process.argv.includes("--shared-voice-key");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(mossVoice || sharedVoiceKey ? modelStorageItems(plan) : { ...modelStorageItems(plan), inproc_voice_key: voiceKey, ...(planVoice ? { inproc_voice_model: 'stepaudio-2.5-realtime' } : {}) })}).then(() => true)`);
  await until(async () => {
    // SAFETY: PANEL_STATE 是本文件写的页面脚本，返回 PanelState；下同。
    const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;

    return state.connected && state.pill?.includes(bddResearch ? "虚构公司调研" : "订单备注") ? state : undefined;
  }, 60_000, "侧栏连上扩展内 agent 并认出练习页", 500);
  // 侧栏启动时发的新建会话要等配置后才建好；在它切换会话之前点语音，会和会话切换撞在一起。
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") !== "true"`)) || undefined, 20_000, "启动时的新会话建好", 300);

  if (mossVoice) {
    const origin = await rp.evaluate(panel, "location.origin");
    const { targetId } = await rp.cdp.send("Target.createTarget", { url: `${String(origin)}/settings.html` }) as { targetId: string };
    const settings = await rp.attach(targetId);
    await rp.cdp.send("Page.bringToFront", {}, settings);
    await until(async () => (await rp.evaluate(settings, `!!document.querySelector('[data-settings-page="voice"]')`)) || undefined, 15_000, "设置页导航");
    await rp.click(settings, '[data-settings-page="voice"]');
    await until(async () => (await rp.evaluate(settings, `!!document.querySelector('.voice-model-option[data-model="moss-live-1.0"]')`)) || undefined, 15_000, "设置页语音模型");
    await rp.evaluate(settings, `document.querySelector('#voice-model-list').scrollIntoView({block:'center'}); true`);
    await rp.click(settings, '.voice-model-option[data-model="moss-live-1.0"]');
    await until(async () => (await rp.evaluate(settings, `document.querySelector('#voice-key-title')?.textContent === 'MOSS 密钥（语音用）'`)) || undefined, 10_000, "MOSS 密钥栏");
    await rp.click(settings, "#voice-key");
    await rp.typeText(settings, voiceKey);
    await rp.click(settings, "#voice-save");
    await until(async () => (await rp.evaluate(settings, `chrome.storage.local.get(['inproc_moss_voice_key','inproc_voice_model']).then(s=>!!s.inproc_moss_voice_key&&s.inproc_voice_model==='moss-live-1.0')`)) || undefined, 10_000, "保存 MOSS 密钥");
    if (caseName === "mark" || bddResearch) {
      await rp.evaluate(settings, `document.querySelector('#speech-key').scrollIntoView({block:'center'}); true`);
      await rp.click(settings, "#speech-key");
      await rp.typeText(settings, fixtureSpeechKey);
      await rp.click(settings, "#speech-save");
      await until(async () => (await rp.evaluate(settings, `chrome.storage.local.get('ptt_speech_key').then(s=>s.ptt_speech_key===${JSON.stringify(fixtureSpeechKey)})`)) || undefined, 10_000, "保存测试订阅密钥");
    }
    await until(async () => (await rp.evaluate(settings, `chrome.declarativeNetRequest.getSessionRules().then(r=>r.some(x=>x.id===7103))`)) || undefined, 10_000, "MOSS 鉴权规则就绪");
    await rp.evaluate(settings, `["voice-state","speech-state"].forEach(id=>{const node=document.getElementById(id);if(node)node.textContent="密钥信息已遮盖";});true`);
    await rp.screenshot(settings, join(artifacts, "settings-moss.png"));
    verdicts.mossSettings = verdict(true, { model: "moss-live-1.0", saved: true });
    await rp.cdp.send("Target.closeTarget", { targetId });
    await rp.cdp.send("Page.bringToFront", {}, page);
  }
  // --voice=<id>：像用户一样在设置页点选音色；判据取服务端 session.updated 回显的音色，不看产品自己的日志。
  if (voiceArg) {
    const origin = await rp.evaluate(panel, "location.origin");
    // SAFETY: CDP 规范里 Target.createTarget 返回 { targetId }。
    const { targetId } = await rp.cdp.send("Target.createTarget", { url: `${String(origin)}/settings.html` }) as { targetId: string };
    const settings = await rp.attach(targetId);
    await rp.cdp.send("Page.bringToFront", {}, settings);
    await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".timbre-option").length`)) === STEP_VOICES.length || undefined, 15_000, "设置页渲染音色");
    // 音色在页面底部：先滚到可见处再点，和用户一样。
    await rp.evaluate(settings, `document.querySelector("#timbre-list").scrollIntoView({ block: "center" }); true`);
    await rp.click(settings, `.timbre-option[data-voice="${voiceArg}"]`);
    let pickState: PickState | null = null;

    const picked = await until(async () => {
      // SAFETY: 这段页面脚本返回 PickState 形状。
      const state = await rp.evaluate(settings, `chrome.storage.local.get("${STEP_VOICE_STORAGE_KEY}").then(s => ({ stored: s["${STEP_VOICE_STORAGE_KEY}"] ?? null, checked: document.querySelector('.timbre-option[aria-checked="true"]')?.dataset.voice ?? null, all: [...document.querySelectorAll('.timbre-option')].map(b => b.dataset.voice + ":" + b.getAttribute("aria-checked")), lists: document.querySelectorAll('#timbre-list').length }))`) as PickState;

      pickState = state;

      return state.stored === voiceArg && state.checked === voiceArg ? state : undefined;
    }, 5_000, "音色保存").catch((error) => { throw new Error(`${String(error)}；设置页状态：${JSON.stringify(pickState)}`); });

    await rp.screenshot(settings, join(artifacts, "settings-voice.png"));
    verdicts.voicePickedInSettings = verdict(true, picked);
    await rp.cdp.send("Target.closeTarget", { targetId });
    await rp.cdp.send("Page.bringToFront", {}, page);
    const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "扩展内 agent 文档");
    const off = await rp.attach(offscreen.targetId);
    await rp.cdp.send("Network.enable", {}, off);

    const frame = (dir: "sent" | "received") => (message: { sessionId?: string; params?: { response?: { payloadData?: string } } }) => {
      if (message.sessionId !== off) return;
      let event: { type?: string; session?: { voice?: string } } | null = null;

      try { event = JSON.parse(message.params?.response?.payloadData ?? ""); } catch { return; }

      if (dir === "sent" && event?.type === "session.update") voiceFrames.requested = event.session?.voice ?? null;

      if (dir === "received" && event?.type === "session.updated") voiceFrames.confirmed = event.session?.voice ?? null;
    };

    rp.cdp.onEvent("Network.webSocketFrameSent", frame("sent"));
    rp.cdp.onEvent("Network.webSocketFrameReceived", frame("received"));
  }

  let sentInstructions: string | null = null;

  if (personaArg) {
    const origin = await rp.evaluate(panel, "location.origin");
    // SAFETY: CDP 规范里 Target.createTarget 返回 { targetId }。
    const { targetId } = await rp.cdp.send("Target.createTarget", { url: `${String(origin)}/settings.html` }) as { targetId: string };
    const settings = await rp.attach(targetId);
    await rp.cdp.send("Page.bringToFront", {}, settings);
    await until(async () => (await rp.evaluate(settings, `document.querySelectorAll(".persona-option").length`)) === VOICE_PERSONAS.length + 1 || undefined, 15_000, "设置页渲染人设");
    await rp.evaluate(settings, `document.querySelector("#persona-list").scrollIntoView({ block: "center" }); true`);
    await rp.click(settings, `.persona-option[data-persona="${personaArg}"]`);

    if (personaArg === "custom") {
      await rp.click(settings, "#persona-text");
      await rp.typeText(settings, CUSTOM_PERSONA);
      await rp.evaluate(settings, `document.querySelector("#persona-save").scrollIntoView({ block: "center" }); true`);
      await rp.click(settings, "#persona-save");
    }

    const saved = await until(async () => {
      // SAFETY: 这段页面脚本返回存储里的人设记录。
      const stored = await rp.evaluate(settings, `chrome.storage.local.get("${VOICE_PERSONA_STORAGE_KEY}").then(s => s["${VOICE_PERSONA_STORAGE_KEY}"] ?? null)`) as { id?: string; text?: string } | null;

      return stored?.id === personaArg ? stored : undefined;
    }, 5_000, "人设保存").catch(async (error) => {
      const form = await rp.evaluate(settings, `({ status: document.querySelector("#persona-status")?.textContent, text: document.querySelector("#persona-text")?.value, hidden: document.querySelector("#persona-custom")?.hidden })`);

      throw new Error(`${String(error)}；设置页：${JSON.stringify(form)}`);
    });

    await rp.screenshot(settings, join(artifacts, "settings-persona.png"));
    verdicts.personaSavedInSettings = verdict(personaArg !== "custom" || saved.text === CUSTOM_PERSONA, saved);
    await rp.cdp.send("Target.closeTarget", { targetId });
    await rp.cdp.send("Page.bringToFront", {}, page);
    const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "扩展内 agent 文档");
    const off = await rp.attach(offscreen.targetId);
    await rp.cdp.send("Network.enable", {}, off);
    rp.cdp.onEvent("Network.webSocketFrameSent", (message: { sessionId?: string; params?: { response?: { payloadData?: string } } }) => {
      if (message.sessionId !== off) return;

      try {
        const event = JSON.parse(message.params?.response?.payloadData ?? "");

        if (event?.type === "session.update") sentInstructions = String(event.session?.instructions ?? "");
      } catch { /* 音频等非 JSON 帧不关心 */ }
    });
  }

  const marks = new Map<number, number[]>();

  const readMarks = async () => {
    // SAFETY: CDP 规范里 DOM.getDocument 返回 { root: Node }。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, page) as { root: DomNode };
    const ids: number[] = [];

    const walk = (node: DomNode) => {
      const a = node.attributes ?? [];
      const i = a.indexOf("class");

      if (i >= 0 && /(^|\s)mark(\s|$)/.test(a[i + 1] ?? "")) ids.push(node.backendNodeId);

      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
    };

    walk(root);

    for (const id of ids) {
      if (marks.has(id)) continue;
      // SAFETY: DOM.getBoxModel 返回 { model: { border: Quad } }；节点消失时 catch 成 null。
      const box = await rp.cdp.send("DOM.getBoxModel", { backendNodeId: id }, page).catch(() => null) as { model?: { border: number[] } } | null;

      if (box?.model?.border) marks.set(id, box.model.border);
    }
  };

  if (caseName === "stop-task" || caseName === "ask-status") {
    // 供应商原始帧时间线：只留事件类型、ID、工具名和文字；音频只记每轮首帧时刻，密钥不在帧内容里。
    const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "扩展内 agent 文档");
    const off = await rp.attach(offscreen.targetId);
    await rp.cdp.send("Network.enable", {}, off);
    const audioSeen = new Set<string>();

    const record = (dir: "sent" | "received") => (message: { sessionId?: string; params?: { timestamp?: number; response?: { payloadData?: string } } }) => {
      if (message.sessionId !== off) return;
      let e: JsonRecord;

      try { e = JSON.parse(message.params?.response?.payloadData ?? ""); } catch { return; }

      const type = String(e.type ?? "");

      if (dir === "sent" && type === "input_audio_buffer.append") return;
      // SAFETY: StepFun Realtime 事件是 JSON 对象，response/item 字段按其事件协议为对象或缺省；只读取可选字段。
      const responseId = (e.response_id ?? (e.response as JsonRecord | undefined)?.id) as string | undefined;

      if (type === "response.audio.delta") {
        if (audioSeen.has(String(responseId))) return;
        audioSeen.add(String(responseId));
      }

      // SAFETY: StepFun Realtime 事件是 JSON 对象，response/item 字段按其事件协议为对象或缺省；只读取可选字段。
      const item = e.item as JsonRecord | undefined;
      const text = type.endsWith("transcription.completed") ? e.transcript : type.endsWith("transcript.done") ? e.transcript : type === "response.audio_transcript.delta" ? e.delta : undefined;

      // SAFETY: session.update 的 session.tools 按 StepFun 协议是函数定义数组；只读名称字段。
      providerTimeline.push({ ms: Math.round((message.params?.timestamp ?? 0) * 1000), dir, type, responseId, itemId: e.item_id ?? item?.id, name: e.name ?? item?.name, text, itemType: item?.type, output: isText(item?.output) ? item.output.slice(0, 300) : undefined, tools: type === "session.update" ? ((e.session as JsonRecord | undefined)?.tools as Array<{ function?: { name?: string }; name?: string }> | undefined)?.map((t) => t.function?.name ?? t.name) : undefined });
    };

    rp.cdp.onEvent("Network.webSocketFrameSent", record("sent"));
    rp.cdp.onEvent("Network.webSocketFrameReceived", record("received"));
    const stopEvidence: JsonRecord = {};
    const voiceSamples: Array<{ at: number; state: string | null; heard: string; answer: string }> = [];

    result.stopTask = stopEvidence;
    stopEvidence.voiceSamples = voiceSamples;
    // 旁路只记协议中可核验的身份、状态和回执；语音音频、凭据不进入产物。
    await rp.evaluate(panel, `(() => {
      const frames = [];
      const port = chrome.runtime.connect({ name: "sideagent-panel" });
      const keep = frame => { frames.push({ at: Date.now(), ...frame }); if (frames.length > 300) frames.shift(); };
      const record = frame => {
        if (frame.type === "status") keep({ kind: "status", state: frame.state, runId: frame.runId ?? null });
        if (frame.type === "agent_event") {
          if (frame.event.kind === "notice" && frame.event.receipt) {
            const r = frame.event.receipt;
            keep({ kind: "receipt", action: r.action, status: r.status, source: r.source, requestId: r.requestId, conversationId: r.conversationId, runId: r.runId, message: r.message });
          } else if (["agent_start", "agent_end", "run_stopped"].includes(frame.event.kind)) {
            keep({ kind: "event", event: frame.event.kind, runId: frame.runId ?? null });
          }
        }
      };
      port.onMessage.addListener(message => {
        if (message.kind === "conversations") {
          const current = message.conversations.find(c => c.id === "default");
          if (current) keep({ kind: "conversation", conversationId: current.id, state: current.state, runId: current.runId });
        }
        if (message.kind === "history") for (const entry of message.entries) if (entry.item.kind === "server") record(entry.item.msg);
        if (message.kind === "server") record(message.msg);
      });
      window.__stopProbe = { frames, port };
      port.postMessage({ kind: "sync", conversationId: "default" });
      return true;
    })()`);
    // SAFETY: 探针脚本返回 window.__stopProbe.frames，写入时即为 StopFrame 数组。
    const protocol = async () => rp.evaluate(panel, "window.__stopProbe.frames") as Promise<StopFrame[]>;
    const pendingText = caseName === "ask-status" ? ASK_STATUS_TASK : "我指一个按钮给你，把我指的那个圈出来，不要点它。";

    await rp.click(panel, "#input");
    await rp.typeText(panel, pendingText);
    await rp.pressEnter(panel);
    if (caseName === "stop-task") await until(async () => rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')"), 120_000, "原任务等待用户点选", 500);
    const start = await until(async () => (await protocol()).find(frame => frame.kind === "receipt" && frame.action === "start" && frame.source === "text" && frame.status === "accepted" && frame.runId), 10_000, "原任务接收回执");
    const runId = start.runId!;
    // SAFETY: PANEL_STATE/页面探针脚本返回的对象形状由同文件的表达式定义。
    const beforeVoice = await rp.evaluate(panel, PANEL_STATE) as PanelState;

    stopEvidence.originalRunId = runId;
    stopEvidence.beforeVoice = beforeVoice;
    await rp.screenshot(panel, join(artifacts, "01-pending-task.png"));
    verdicts.taskWaitingBeforeVoice = verdict(beforeVoice.taskBusy && !!runId, { runId, taskBusy: beforeVoice.taskBusy });

    const sample = async () => {
      // SAFETY: PANEL_STATE/页面探针脚本返回的对象形状由同文件的表达式定义。
      const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;

      last = state;

      if (state.voiceState && states.at(-1) !== state.voiceState) states.push(state.voiceState);
      const previous = voiceSamples.at(-1);

      if (!previous || previous.state !== state.voiceState || previous.heard !== state.heard || previous.answer !== state.answer) {
        voiceSamples.push({ at: Date.now(), state: state.voiceState, heard: state.heard, answer: state.answer });
      }

      return state;
    };

    if (caseName === "ask-status") {
      // 问任务状态的句子也带「结束…任务」：宿主不能把它当成终止，要交给模型照常回答，原任务照常在跑。
      const askedAt = Date.now();

      await rp.click(panel, "#input");
      await rp.click(panel, ".voice-start");
      const asked = await until(async () => {
        const state = await sample();

        return state.heard.includes("任务") ? state : undefined;
      }, 40_000, "听到问任务状态", 200);

      // 宿主误判时终止在转写后一两秒内就下发；等这句回答说完再看任务。
      await until(async () => {
        const state = await sample();

        return state.answer && state.voiceState === "listening" ? state : undefined;
      }, 30_000, "回答说完", 300).catch(() => undefined);
      const after = await sample();
      const frames = await protocol();
      const aborted = frames.filter(frame => frame.kind === "receipt" && frame.action === "abort" && frame.at >= askedAt).map(frame => ({ ...frame }));
      const stopped = frames.some(frame => frame.at >= askedAt && ((frame.kind === "event" && frame.event === "run_stopped") || (frame.kind === "status" && frame.state === "aborted")));

      // 转写要带「结束/取消…任务」这种终止说法的短句才测到了：转成「任务完成了吗」时，宿主本来就不会当成终止。
      const heardShort = asked.heard.replace(/[\p{P}\p{Z}\s]/gu, "");
      const abortWording = heardShort.length <= 16 && /(?:终止|中止|取消|停止|结束|停掉)(?:掉)?(?:当前|这个|这项|刚才的?)?任务|任务(?:给我)?(?:终止|中止|取消|停止|结束|停掉)/.test(heardShort);

      stopEvidence.askStatus = { heard: asked.heard, panel: after, aborted, stopped };
      verdicts.heardStatusQuestion = verdict(abortWording, { heard: asked.heard, abortWording });
      verdicts.statusQuestionKeepsTask = verdict(!aborted.length && !stopped && after.taskBusy, { runId, aborted, stopped, taskBusy: after.taskBusy });
      verdicts.statusQuestionAnswered = verdict(!!after.answer, { answer: after.answer });
      stopEvidence.protocol = frames.map(frame => ({ ...frame }));
      await rp.screenshot(panel, join(artifacts, "02-asked-status-panel.png"));
      await rp.screenshot(page, join(artifacts, "03-asked-status-page.png"));
      // SAFETY: PANEL_STATE/页面探针脚本返回的对象形状由同文件的表达式定义。
      await writeFile(join(artifacts, "panel-transcript.txt"), (await rp.evaluate(panel, PANEL_STATE) as PanelState).transcript);
    }

    if (caseName === "stop-task") {
      // 第一句是普通问候：可控任务期间的转写闸门必须放行，助手照常回答，任务不动。
      await rp.click(panel, "#input");
      await rp.click(panel, ".voice-start");

      const greeted = await until(async () => {
        const state = await sample();

        return state.heard.includes("你好") && state.answer && state.voiceState === "speaking" ? state : undefined;
      }, 40_000, "问候被正常回答", 200);

      stopEvidence.greeting = greeted;
      verdicts.chatPassesGate = verdict(greeted.taskBusy, { heard: greeted.heard, answer: greeted.answer, taskBusy: greeted.taskBusy });
      // SAFETY: 表达式只返回布尔值。
      const muted = await rp.evaluate(panel, `(() => { const b = document.querySelector(".voice-stop-speech"); if (!b || b.hidden || b.disabled) return false; b.click(); return true; })()`) as boolean;

      const afterMute = await until(async () => {
        const state = await sample();

        return state.voiceState === "listening" ? state : undefined;
      }, 10_000, "停声后继续收音", 200);

      // SAFETY: 表达式只返回布尔值。
      const pendingAfterMute = await rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')") as boolean;
      const abortedByMute = (await protocol()).some(frame => frame.kind === "receipt" && frame.action === "abort" && frame.runId === runId);

      stopEvidence.afterMute = { muted, panel: afterMute, pendingPicker: pendingAfterMute, abortedByMute };
      verdicts.muteKeepsOriginalTask = verdict(pendingAfterMute && afterMute.taskBusy && !abortedByMute, { muted, runId, pendingPicker: pendingAfterMute, taskBusy: afterMute.taskBusy, abortedByMute });
      await rp.screenshot(panel, join(artifacts, "02-muted-still-running.png"));

      // 第二句“终止任务”：直接终止原任务，不复述确认；回执之前不能宣称已停。
      const confirmationWaitingAt = Date.now();
      let abort: StopFrame | undefined;

      await until(async () => {
        await sample();
        abort = (await protocol()).find(frame => frame.kind === "receipt" && frame.action === "abort" && frame.source === "voice");

        return abort;
      }, 40_000, "语音终止回执", 200);
      const receipt = abort!;
      const afterAbort = await sample();
      const claims = voiceSamples.filter(v => /已终止|终止了|已停止|停了|已经停/.test(v.answer));

      stopEvidence.confirmation = { panel: afterAbort, receipt: { ...receipt } };
      verdicts.confirmedOriginalAbort = verdict(receipt.status === "applied" && receipt.runId === runId && receipt.conversationId === "default" && afterAbort.heard.includes("终止任务"), { runId, receipt: { ...receipt }, heard: afterAbort.heard });
      verdicts.noReadback = verdict(!voiceSamples.some(v => v.answer.includes("你是说")), { answers: [...new Set(voiceSamples.map(v => v.answer))] });
      verdicts.noClaimBeforeReceipt = verdict(!claims.some(v => v.at < receipt.at), { receiptAt: receipt.at, claims });

      const terminal = await until(async () => {
        // SAFETY: 表达式只返回布尔值。
        const picker = await rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')") as boolean;
        const frames = await protocol();
        const ended = frames.some(frame => frame.kind === "status" && ["aborted", "idle"].includes(frame.state ?? "") && frame.at >= confirmationWaitingAt) || frames.some(frame => frame.kind === "event" && frame.event === "run_stopped" && frame.at >= confirmationWaitingAt);

        return !picker && ended ? { picker, ended } : undefined;
      }, 15_000, "终止后点选层与任务状态收束", 300);

      stopEvidence.terminal = terminal;
      verdicts.abortClearsPicker = verdict(!terminal.picker && terminal.ended, terminal);

      const lateRequestId = `late-after-abort-${Date.now()}`;
      await rp.evaluate(panel, `window.__stopProbe.port.postMessage({ kind: "client", msg: { type: "task_action", conversationId: "default", request: { requestId: ${JSON.stringify(lateRequestId)}, conversationId: "default", source: "text", action: "steer", expectedRunId: ${JSON.stringify(runId)}, text: "现在点击保存按钮" } } }); true`);
      const lateReceipt = await until(async () => (await protocol()).find(frame => frame.kind === "receipt" && frame.requestId === lateRequestId), 10_000, "迟到旧要求的拒绝回执", 300);
      await new Promise(resolve => setTimeout(resolve, 2_000));
      await readMarks();
      const finalFrames = await protocol();
      // SAFETY: 练习页把 window.receipts 维护为普通 JSON 对象。
      const pageReceipts = await rp.evaluate(page, "window.receipts") as JsonRecord;
      // SAFETY: 表达式只返回布尔值。
      const pickerReturned = await rp.evaluate(page, "!!document.querySelector('[data-sideagent-point]')") as boolean;
      const revived = finalFrames.some(frame => frame.kind === "event" && frame.event === "agent_start" && frame.runId === runId && frame.at > abort.at);

      stopEvidence.late = { request: { requestId: lateRequestId, expectedRunId: runId }, receipt: { ...lateReceipt }, revived, pickerReturned, pageReceipts, markCount: marks.size };
      verdicts.lateRequestCannotRevive = verdict(lateReceipt.status === "rejected" && !revived && !pickerReturned && marks.size === 0 && Array.isArray(pageReceipts.save) && pageReceipts.save.length === 0 && Array.isArray(pageReceipts.cancel) && pageReceipts.cancel.length === 0, { lateReceipt: { ...lateReceipt }, revived, pickerReturned, pageReceipts, markCount: marks.size });
      stopEvidence.protocol = finalFrames.map(frame => ({ ...frame }));
      await rp.screenshot(panel, join(artifacts, "03-stopped-panel.png"));
      await rp.screenshot(page, join(artifacts, "04-stopped-page.png"));
      // SAFETY: PANEL_STATE/页面探针脚本返回的对象形状由同文件的表达式定义。
      await writeFile(join(artifacts, "panel-transcript.txt"), (await rp.evaluate(panel, PANEL_STATE) as PanelState).transcript);
    }
  } else {
  // 开口时间线：假麦克风从 getUserMedia 起放 WAV，就绪前的帧被侧栏丢弃；记下开麦、握手、首帧音频、断句与转写的时刻。
  const opening: Array<{ at: number; event: string; text?: string }> = [];
  const offscreen = await until(async () => (await rp.targets()).find((t) => t.url.endsWith("/inproc.html")), 10_000, "扩展内 agent 文档");
  const off = await rp.attach(offscreen.targetId);
  await rp.cdp.send("Network.enable", {}, off);
  // 只断语音连接：本机脚本模型和朗读拦截照常可达，整页离线会让任务本身也失败。
  if (mossReconnect || m8aCase || m7Reconnect) await rp.evaluate(off, `(() => {
    const Original = window.WebSocket;
    window.__mossSockets = [];
    window.__mossBlocked = false;
    window.WebSocket = class extends Original {
      constructor(...args) {
        if (window.__mossBlocked && String(args[0]).startsWith("wss://api.mosi.cn/v1/realtime")) args[0] = "wss://127.0.0.1:9/blocked";
        super(...args);
        if (String(args[0]).startsWith("wss://api.mosi.cn/v1/realtime")) window.__mossSockets.push(this);
      }
    };
    return true;
  })()`);
  if (m8aRetryTimeout) await rp.evaluate(off, `(() => {
    window.__m8aRetryGate = { armed: false, delayedAt: null, socketIndex: null, delayedCount: 0 };
    const add = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function(type, listener, ...rest) {
      if (type !== "message" || typeof listener !== "function") return add.call(this, type, listener, ...rest);
      return add.call(this, type, function(event) {
        let packet;
        try { packet = typeof event.data === "string" ? JSON.parse(event.data) : null; } catch {}
        const gate = window.__m8aRetryGate;
        if (gate.armed && packet?.action === "session.updated"
          && (gate.socketIndex === null || gate.socketIndex === window.__mossSockets.indexOf(this))) {
          if (gate.socketIndex === null) {
            gate.socketIndex = window.__mossSockets.indexOf(this);
            gate.delayedAt = Date.now();
          }
          gate.delayedCount++;
          setTimeout(() => listener.call(this, event), 10_000);
          return;
        }
        return listener.call(this, event);
      }, ...rest);
    };
    return true;
  })()`);
  if (firstUtterance) await rp.evaluate(off, `(() => {
    window.__firstReadyGates=[];
    const add=WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener=function(type,listener,...rest){
      if(type!=='message'||typeof listener!=='function')return add.call(this,type,listener,...rest);
      return add.call(this,type,function(event){
        if(JSON.parse(event.data).type==='session.updated'){
          const gate={receivedAt:Date.now(),deliveredAt:null};window.__firstReadyGates.push(gate);
          setTimeout(()=>{gate.deliveredAt=Date.now();listener.call(this,event);},Math.max(0,window.__firstReadyTargetAt-Date.now()));
          return;
        }
        return listener.call(this,event);
      },...rest);
    };
    return true;
  })()`);
  let appended = false;
  const firstText = new Set<string>();
  const receivedBySecond = new Map<string, number>();
  const sessionIds: string[] = [];
  // 服务端回显的断句参数，确认 session.update 里的取值真的生效。
  let turnDetection: Json | undefined;
  const wire = { appends: 0, lastAppendAt: 0, received: 0, lastReceivedAt: 0, lastReceivedType: "", spokenSentMs: 0, screenFrames: 0, chunksPlayed: 0, playbackCompleted: 0, responseCompleted: 0, attached: false, attachments: 0, ttsRequests: 0, ttsStatus: 0, ttsCorrectKey: false, ttsModel: "" };
  const ttsTexts: string[] = [];
  const ttsTimeline: Array<{ at: number; text: string }> = [];
  const stops: Array<{ reason: string; playedMs: number }> = [];
  const mossProtocol: JsonRecord[] = [];
  const mossChunks: JsonRecord[] = [];
  const researchScreenFrames: number[] = [];
  const researchUpdates: Array<{ at: number; ackAt: number | null; firstBusiness: boolean; secondName: boolean; secondBusiness: boolean; thirdBusiness: boolean; error: boolean }> = [];
  const receivedAudioBytes = new Map<string, number>();
  let sentVoicedDuringResponse = 0;
  let firstResponseRun: string | null = null;
  let firstResponseActive = false;
  let audioRun: string | null = null;
  let m8aCut: number | null = null, m8aRestored: number | null = null;
  let m8aCutEarliest: number | null = null, m8aRestoreEarliest: number | null = null;
  let m8aAttachmentsDuringBlock: number | null = null, m8aErrorsDuringBlock: number | null = null;
  const ttsRequests = new Set<string>();
  rp.cdp.onEvent("Network.requestWillBeSent", (message: { sessionId?: string; params?: { requestId?: string; request?: { url?: string } } }) => {
    if (message.sessionId === off && message.params?.request?.url === "https://api.minimaxi.com/v1/t2a_v2" && message.params.requestId) {
      ttsRequests.add(message.params.requestId);
    }
  });
  rp.cdp.onEvent("Network.responseReceived", (message: { sessionId?: string; params?: { requestId?: string; response?: { status?: number } } }) => {
    if (message.sessionId === off && message.params?.requestId && ttsRequests.has(message.params.requestId)) wire.ttsStatus = message.params.response?.status ?? 0;
  });
  // 断线待播：夹具代发真实的核对请求，拿到完整回复后先断开语音，等侧栏察觉断线再交回，核对必然在断线期间完成。
  let goalCheckReleased = false, goalCheckReplyAt: number | null = null;
  let releaseGoalCheck = () => {};
  const goalCheckRelease = new Promise<void>(resolve => { releaseGoalCheck = () => { goalCheckReleased = true; resolve(); }; });
  let goalCheckArrived = () => {};
  const goalCheckReady = new Promise<void>(resolve => { goalCheckArrived = resolve; });
  const holdGoalCheck = async (requestId: string, url: string, headers: Record<string, string>, body: string) => {
    try {
      const forwarded = Object.fromEntries(Object.entries(headers).filter(([name]) => !["host", "content-length"].includes(name.toLowerCase())));
      const response = await fetch(url, { method: "POST", headers: forwarded, body });
      const text = await response.text();
      goalCheckReplyAt ??= Date.now();
      goalCheckArrived();
      await goalCheckRelease;
      await rp.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: response.status,
        responseHeaders: [{ name: "Content-Type", value: response.headers.get("content-type") ?? "text/event-stream" }],
        body: Buffer.from(text).toString("base64") }, off);
    } catch {
      await rp.cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" }, off).catch(() => {});
    }
  };
  if (mossVoice && (caseName === "mark" || bddResearch)) {
    await rp.cdp.send("Fetch.enable", { patterns: [
      { urlPattern: "https://api.minimaxi.com/v1/t2a_v2*", requestStage: "Request" },
      ...(scriptBrowserTask ? [{ urlPattern: "https://api.minimaxi.com/anthropic/v1/messages*", requestStage: "Request" }] : []),
    ] }, off);
    rp.cdp.onEvent("Fetch.requestPaused", (message: { sessionId?: string; params?: { requestId?: string; request?: { url?: string; headers?: Record<string, string>; postData?: string } } }) => {
      const request = message.params?.request;
      const requestId = message.params?.requestId;
      if (message.sessionId !== off || !requestId) return;
      if (m7Reconnect && !goalCheckReleased && request?.url?.startsWith("https://api.minimaxi.com/anthropic/v1/messages") && request.postData?.includes(GOAL_CHECK_MARK)) {
        void holdGoalCheck(requestId, request.url, request.headers ?? {}, request.postData);
        return;
      }
      if (scriptBrowserTask && request?.url?.startsWith("https://api.minimaxi.com/anthropic/v1/messages") && holdingModel) {
        void interceptBrowserTask(rp, off, requestId, request.postData, holdingModel.baseUrl, taskRouting);
        return;
      }
      if (request?.url !== "https://api.minimaxi.com/v1/t2a_v2") return;
      wire.ttsRequests++;
      const auth = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
      wire.ttsCorrectKey = auth === `Bearer ${fixtureSpeechKey}` && (wire.ttsRequests === 1 || wire.ttsCorrectKey);
      try {
        const body = JSON.parse(request.postData ?? "{}") as { model?: unknown; text?: unknown };
        wire.ttsModel = String(body.model ?? "");
        if (typeof body.text === "string") { ttsTexts.push(body.text); ttsTimeline.push({ at: Date.now(), text: body.text }); }
      } catch { wire.ttsModel = ""; }
      if (bddMark || m6Case || bddResearch && !m7Reconnect && !speechFormat) {
        void rp.cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" }, off);
        return;
      }
      if (realMinimax) {
        void rp.cdp.send(wire.ttsRequests <= 2 ? "Fetch.continueRequest" : "Fetch.failRequest", wire.ttsRequests <= 2 ? { requestId } : { requestId, errorReason: "Aborted" }, off);
        return;
      }
      const body = `data: ${JSON.stringify({ data: { audio: fixtureSpeechHex, status: 1 }, base_resp: { status_code: 0 } })}\n\ndata: ${JSON.stringify({ data: { status: 2 }, base_resp: { status_code: 0 } })}\n\n`;
      void rp.cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/event-stream" }], body: Buffer.from(body).toString("base64") }, off);
    });
  }
  const transportEvents: JsonRecord[] = [];
  for (const name of ["Network.webSocketCreated", "Network.webSocketHandshakeResponseReceived", "Network.webSocketFrameError", "Network.webSocketClosed"] as const) {
    rp.cdp.onEvent(name, (message: { sessionId?: string; params?: { response?: { status?: number }; errorMessage?: string } }) => {
      if (message.sessionId === off) transportEvents.push({ event: name, status: message.params?.response?.status ?? null, error: message.params?.errorMessage?.replaceAll(voiceKey, "[redacted]") ?? null });
    });
  }
  // 发给服务端的音频有多响：每 500 ms 一格记峰值（int16），判断是服务端没断句还是浏览器把声音压低了。
  const loudness: Array<{ at: number; peak: number }> = [];

  const onFrame = (dir: "sent" | "received") => (message: { sessionId?: string; params?: { response?: { opcode?: number; payloadData?: string } } }) => {
    if (message.sessionId !== off) return;
    if (dir === "sent" && message.params?.response?.opcode === 2) {
      const raw = Buffer.from(message.params.response.payloadData ?? "", "base64");
      if (raw[0] === 0x02 && raw.length > 100) {
        wire.screenFrames++;
        if (bddResearch) researchScreenFrames.push(Date.now());
      }
      if (raw[0] === 0x00 && raw.length === 641) {
        Object.assign(wire, { appends: wire.appends + 1, lastAppendAt: Date.now() });
        let peak = 0, sumSquares = 0;
        for (let i = 1; i + 1 < raw.length; i += 2) {
          const sample = raw.readInt16LE(i);
          peak = Math.max(peak, Math.abs(sample));
          if (m2bCase) sumSquares += sample * sample;
        }
        if (m2bCase && firstResponseActive && Math.sqrt(sumSquares / 320) / 32768 > 0.01) sentVoicedDuringResponse++;
        if (peak > SPEECH_PEAK) wire.spokenSentMs += 20;
        const cell = loudness.at(-1);
        if (cell && Date.now() - cell.at < 500) cell.peak = Math.max(cell.peak, peak);
        else if (loudness.length < 60) loudness.push({ at: Date.now(), peak });
      }
      return;
    }
    if (dir === "received" && message.params?.response?.opcode === 2) {
      if (m2bCase && audioRun) {
        const bytes = Buffer.from(message.params.response.payloadData ?? "", "base64").length;
        receivedAudioBytes.set(audioRun, (receivedAudioBytes.get(audioRun) ?? 0) + bytes);
      }
      return;
    }
    let e: JsonRecord;

    try { e = JSON.parse(message.params?.response?.payloadData ?? ""); } catch { return; }

    const type = String(e.type ?? e.action ?? "");
    if (bddResearchProgress && dir === "sent" && type === "session.update") {
      const session = e.session as JsonRecord | undefined;
      const instructions = typeof session?.instructions === "string" ? session.instructions : "";
      researchUpdates.push({ at: Date.now(), ackAt: null, firstBusiness: instructions.includes(RESEARCH_COMPANIES[0].business),
        secondName: instructions.includes(RESEARCH_COMPANIES[1].name), secondBusiness: instructions.includes(RESEARCH_COMPANIES[1].business),
        thirdBusiness: instructions.includes(RESEARCH_COMPANIES[2].business), error: false });
    }
    if (bddResearchProgress && dir === "received" && type === "session.updated") {
      const pending = researchUpdates.find(update => update.ackAt === null);
      if (pending) {
        const data = (e.data ?? e) as JsonRecord;
        pending.ackAt = Date.now();
        pending.error = !!data.error;
      }
    }
    if (m2bCase && dir === "received" && type === "response.audio.started" && !firstResponseRun) {
      const runId = (e.data as JsonRecord | undefined)?.run_id;
      if (typeof runId === "string") { firstResponseRun = runId; firstResponseActive = true; }
    }
    if (m2bCase && firstResponseRun && ((dir === "sent" && type === "playback.completed")
      || (dir === "received" && ["response.audio.stop", "response.interrupted"].includes(type)))) {
      const data = (e.data ?? e) as JsonRecord;
      if (!data.run_id || data.run_id === firstResponseRun) firstResponseActive = false;
    }
    if (m2bCase && dir === "received" && type === "response.audio.context") {
      const runId = (e.data as JsonRecord | undefined)?.run_id;
      audioRun = typeof runId === "string" ? runId : null;
    }
    if (m2bCase && (dir === "received" && type === "response.audio.context"
      || dir === "sent" && type === "playback.chunk.completed")) {
      const data = (e.data ?? e) as JsonRecord;
      mossChunks.push({ at: Date.now(), dir, type, runId: data.run_id, turnId: data.turn_id, chunkId: data.chunk_id });
    }
    if (mossVoice && ["session_attached", "input.speech.started", "input.speech.stopped", "input.transcript.done", "response.audio.started", "response.audio.stop", "response.audio.done", "response.interrupted", "response.ended", "playback.stopped", "playback.completed"].includes(type)) {
      const data = (e.data ?? e) as JsonRecord;
      mossProtocol.push({ at: Date.now(), dir, type, runId: data.run_id, turnId: data.turn_id, reason: data.reason, status: data.status, playedMs: data.played_audio_ms });
    }
    if (dir === "received" && type === "session_attached") {
      wire.attached = true;
      wire.attachments++;
      const id = (e.data as JsonRecord | undefined)?.session_id;
      if (typeof id === "string") sessionIds.push(id);
    }
    if (dir === "sent" && type === "playback.chunk.completed") wire.chunksPlayed++;
    if (dir === "sent" && type === "playback.completed") wire.playbackCompleted++;
    if (dir === "sent" && type === "playback.stopped") stops.push({ reason: String(e.reason ?? ""), playedMs: Number(e.played_audio_ms ?? 0) });
    if (dir === "received" && type === "response.ended" && (e.data as JsonRecord | undefined)?.status === "completed") wire.responseCompleted++;

    if (dir === "received" && type === "session.created") {
      // SAFETY: StepFun 的 session.created 按协议带 session 对象；只读 id，给供应商排查用。
      sessionIds.push(String((e.session as JsonRecord | undefined)?.id ?? ""));
    }

    if (dir === "received" && type === "session.updated") {
      // SAFETY: StepFun 的 session.updated 按协议带 session 对象；只读 turn_detection 字段。
      turnDetection = (e.session as JsonRecord | undefined)?.turn_detection;
    }

    if (dir === "received") {
      Object.assign(wire, { received: wire.received + 1, lastReceivedAt: Date.now(), lastReceivedType: type });
      // 按秒记收到的事件类型：分清「挂住」时服务端到底还在发什么。
      const second = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      receivedBySecond.set(`${second}:${type}`, (receivedBySecond.get(`${second}:${type}`) ?? 0) + 1);
    }

    if (type === "input_audio_buffer.append") {
      Object.assign(wire, { appends: wire.appends + 1, lastAppendAt: Date.now() });
      const pcm = Buffer.from(isText(e.audio) ? e.audio : "", "base64");
      let peak = 0;

      for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));

      for (let at = 0; at + 960 <= pcm.length; at += 960) {
        let windowPeak = 0;

        for (let i = at; i < at + 960; i += 2) windowPeak = Math.max(windowPeak, Math.abs(pcm.readInt16LE(i)));

        if (windowPeak > SPEECH_PEAK) wire.spokenSentMs += 20;
      }

      const cell = loudness.at(-1);

      if (cell && Date.now() - cell.at < 500) cell.peak = Math.max(cell.peak, peak);
      else if (loudness.length < 60) loudness.push({ at: Date.now(), peak });

      if (appended) return;
      appended = true;
    }

    if (type.startsWith("session.") || type.startsWith("input_audio_buffer.") || type.endsWith("transcription.completed")) {
      opening.push({ at: Date.now(), event: `${dir}:${type}`, text: isText(e.transcript) ? e.transcript : undefined });
    }

    // 回复与工具：看被切成两轮时第一轮的工具调用去了哪；文字通道只记每个回复的第一段，区分是读出来的还是只有文字。
    // SAFETY: StepFun Realtime 事件是 JSON 对象，response/item 字段按其事件协议为对象或缺省；只读取可选字段。
    const item = e.item as JsonRecord | undefined;
    // SAFETY: 同上。
    const responseId = String(e.response_id ?? (e.response as JsonRecord | undefined)?.id ?? "");
    const callName = isText(e.name) ? e.name : isText(item?.name) ? item.name : undefined;

    if (["response.created", "response.cancel", "response.cancelled", "response.done", "response.create", "response.function_call_arguments.done"].includes(type) || (type === "conversation.item.create" && item?.type === "function_call_output")) {
      opening.push({ at: Date.now(), event: `${dir}:${type}`, text: [responseId, callName, isText(e.arguments) ? e.arguments.slice(0, 160) : undefined, isText(item?.output) ? item.output.slice(0, 160) : undefined].filter(Boolean).join(" ") || undefined });
    }

    if ((type === "response.audio_transcript.delta" || type === "response.text.delta") && !firstText.has(`${type}:${responseId}`)) {
      firstText.add(`${type}:${responseId}`);
      opening.push({ at: Date.now(), event: `${dir}:${type}`, text: `${responseId} ${isText(e.delta) ? e.delta : ""}` });
    }
  };

  rp.cdp.onEvent("Network.webSocketFrameSent", onFrame("sent"));
  rp.cdp.onEvent("Network.webSocketFrameReceived", onFrame("received"));
  await rp.evaluate(panel, `(() => {
    const media = navigator.mediaDevices;
    const open = media.getUserMedia.bind(media);
    window.__micOpenedAt = null;
    window.__voiceOnsetAt = null;
    media.getUserMedia = async (constraints) => {
      const stream = await open(constraints);
      window.__micOpenedAt = Date.now();
      // 测试自己的音量计：麦克风里第一次出现人声的时刻（与产品丢不丢帧无关）。
      const context = new AudioContext();
      const meter = context.createAnalyser();
      context.createMediaStreamSource(stream.clone()).connect(meter);
      const buf = new Float32Array(meter.fftSize);
      const timer = setInterval(() => {
        meter.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
        if (rms > 0.01) { window.__voiceOnsetAt = Date.now(); clearInterval(timer); context.close(); }
      }, 20);
      return stream;
    };
    return true;
  })()`);

  if (caseName === "barge-in" || noticeBarge) {
    // 测试自己的两只耳朵，都不读产品状态：
    // 出声——侧栏把回答接到扬声器的那个节点上旁挂一个音量计，每 20 ms 记一次实际输出音量；
    // 开口——麦克风流上另挂音量计，记每段人声的起止（停顿超过 800 ms 才算新一段）。
    await rp.evaluate(panel, `(() => {
      window.__out = [];
      window.__segments = [];
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (target, ...rest) {
        if (this instanceof AnalyserNode && target instanceof AudioDestinationNode && !this.__tapped) {
          this.__tapped = true;
          const tap = this.context.createAnalyser();
          tap.fftSize = 512;
          connect.call(this, tap);
          const buf = new Float32Array(tap.fftSize);
          const timer = setInterval(() => {
            if (this.context.state === "closed") return clearInterval(timer);
            tap.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const x of buf) sum += x * x;
            window.__out.push([Date.now(), Math.sqrt(sum / buf.length)]);
          }, 20);
        }
        return connect.call(this, target, ...rest);
      };
      const media = navigator.mediaDevices;
      const open = media.getUserMedia.bind(media);
      media.getUserMedia = async (constraints) => {
        const stream = await open(constraints);
        const context = new AudioContext();
        const meter = context.createAnalyser();
        context.createMediaStreamSource(stream.clone()).connect(meter);
        const buf = new Float32Array(meter.fftSize);
        let lastVoice = 0;
        setInterval(() => {
          meter.getFloatTimeDomainData(buf);
          const rms = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
          const now = Date.now();
          if (rms <= 0.01) return;
          const open = window.__segments.at(-1);
          if (open && now - lastVoice <= 800) open[1] = now;
          else window.__segments.push([now, now]);
          lastVoice = now;
        }, 20);
        return stream;
      };
      return true;
    })()`);
  }

  const began = Date.now();

  if (caseName === "barge-in" || noticeBarge) recordBargeIn = async () => {
    // SAFETY: 上面注入的音量计只写 [Date.now(), rms] 数对和 [开始, 结束] 毫秒数对。
    const out = await rp.evaluate(panel, "window.__out") as Array<[number, number]>;
    // SAFETY: 同上。
    const segments = await rp.evaluate(panel, "window.__segments") as Array<[number, number]>;
    const LOUD = 0.005;
    const audibleMs = (from: number, to: number) => out.filter(([at, rms]) => at >= from && at < to && rms > LOUD).length * 20;
    const [onset, spokenEnd] = segments[1] ?? [0, 0];
    // 开口后从哪一刻起直到用户说完都没有声音（只看 400 ms 空档会被回答的句间停顿骗过，改前基线实测如此）。
    const silentFrom = onset ? out.find(([at]) => at >= onset && audibleMs(at, spokenEnd) === 0)?.[0] : undefined;
    // 看开口前 1.5 秒：长回答句与句之间的停顿会超过半秒。
    const playingAtOnset = onset ? audibleMs(onset - 1500, onset) : 0;
    const talkOverMs = onset ? audibleMs(onset + 1500, spokenEnd) : null;
    // 输出音量计的采样数和峰值：确认它真录到过回答的声音。
    const outPeak = Math.round(Math.max(0, ...out.map(([, rms]) => rms)) * 1000) / 1000;
    const timeline = { segments: segments.map(([a, b]) => [a - began, b - began]), playingAtOnsetMs: playingAtOnset, silencedAfterMs: silentFrom === undefined ? null : silentFrom - onset, talkOverMs, secondUtteranceMs: spokenEnd - onset, outSamples: out.length, outPeak };
    result.bargeIn = timeline;
    // 开口前旧回答没在出声时，后两条没有意义，一并判不通过，不算作停声成功。
    const valid = segments.length >= 2 && playingAtOnset >= 200;
    verdicts.answerPlayingWhenUserSpoke = verdict(valid, timeline);
    verdicts.oldAnswerSilenced = verdict(valid && silentFrom !== undefined && silentFrom - onset <= 1500, timeline);
    verdicts.noTalkOver = verdict(valid && talkOverMs !== null && talkOverMs <= 200, timeline);
  };

  recordOpening = async () => {
    // SAFETY: 上面注入的包装只把 __micOpenedAt 设成 null 或 Date.now() 数值。
    const micOpenedAt = await rp.evaluate(panel, "window.__micOpenedAt") as number | null;
    const t0 = micOpenedAt ?? began;
    // SAFETY: 同上，__voiceOnsetAt 只会是 null 或 Date.now() 数值。
    const voiceOnsetAt = await rp.evaluate(panel, "window.__voiceOnsetAt") as number | null;
    // 开口没被丢：发给服务端的人声至少是 WAV 里人声的八成（浏览器自动增益会让个别音节过线或不过线）。
    verdicts.speechDelivered = verdict(wire.spokenSentMs >= spokenMs * 0.8, { spokenMs, sentMs: wire.spokenSentMs });
    if (mossVoice) {
      verdicts.mossScreenStream = verdict(wire.screenFrames >= 3, { frames: wire.screenFrames });
      verdicts.mossPlayback = caseName === "mark" && !bddMark && !m6Case
        ? verdict((noticeBarge ? wire.ttsRequests >= 1 : wire.ttsRequests === 2) && wire.ttsStatus === 200 && wire.ttsCorrectKey && wire.ttsModel === "speech-2.8-hd" && states.includes("speaking") && states.at(-1) === "listening", { ttsRequests: wire.ttsRequests, ttsStatus: wire.ttsStatus, correctKey: wire.ttsCorrectKey, model: wire.ttsModel, provider: realMinimax ? "minimax" : "mock-minimax", texts: ttsTexts, states })
        : verdict(wire.chunksPlayed > 0 && wire.playbackCompleted > 0 && wire.responseCompleted > 0, { chunks: wire.chunksPlayed, completed: wire.playbackCompleted, responseCompleted: wire.responseCompleted });
      if (caseName === "barge-in") verdicts.mossStoppedAtPlayerProgress = verdict(stops.some(stop => stop.reason === "barge-in" && stop.playedMs > 0), { stops });
    }
    if (firstUtterance) {
      const gates = await rp.evaluate(off, "window.__firstReadyGates") as Array<{ receivedAt: number; deliveredAt: number | null }>;
      const readyAt = gates[0]?.deliveredAt ?? undefined;
      result.readyGates = gates;
      verdicts.speechCompletedBeforeReady = verdict(micOpenedAt !== null && readyAt !== undefined && micOpenedAt + speechEndMs < readyAt, {
        speechEndMs, readyMs: readyAt === undefined ? null : readyAt - t0,
      });
      const normalize = (text: string) => text.replace(/[\p{P}\s]/gu, "");
      const heard = String(await rp.evaluate(panel, "document.querySelector('.voice-question')?.textContent ?? ''"));
      verdicts.firstUtterancePreserved = verdict(normalize(heard).includes(normalize(QUESTION!)), { heard, expected: QUESTION });
    }
    result.receivedBySecond = [...receivedBySecond].map(([key, count]) => `${key}×${count}`).join(" ");
    result.transportEvents = transportEvents;
    result.providerSessionIds = sessionIds;
    if (mossVoice) result.mossProtocol = mossProtocol.map(event => ({ ...event, at: Number(event.at) - t0 }));
    if (m2bCase) result.mossChunks = mossChunks;
    result.opening = { turnDetection: turnDetection ?? null, leadMs: lead, micOpened: micOpenedAt !== null, wire: { ...wire, lastAppendAt: wire.lastAppendAt - t0, lastReceivedAt: wire.lastReceivedAt - t0 }, loudness: loudness.map((c) => `${c.at - t0}:${c.peak}`).join(" "), voiceOnsetMs: voiceOnsetAt === null ? null : voiceOnsetAt - t0, events: opening.map((o) => ({ ms: o.at - t0, event: o.event, text: o.text })) };
  };

  if (m8bCase) {
    await installRealtimeTiming(rp, panel);
    recordM8b = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      const start = voiced[0]?.at ?? null, lastVoice = voiced.at(-1)?.at ?? null;
      const end = lastVoice !== null && capture.frames.some(frame => frame.at >= lastVoice + 300) ? lastVoice : null;
      const afterSpeech = start === null ? [] : capture.statuses.filter(status => status.at >= start);
      const failed = (text: string) => /连不上|无法连接|连接失败|连接未能恢复|语音不可用/.test(text);
      const guidance = (text: string) => /(?:检查|核对).{0,30}(?:网络|设置|密钥|模型与语音)|(?:网络|设置|密钥).{0,20}(?:检查|核对)/.test(text);
      const errorText = afterSpeech.find(status => failed(status.text));
      const notice = afterSpeech.find(status => failed(status.text) && guidance(status.text));
      const delay = notice && start !== null ? notice.at - start : null;
      const blocked = !wire.attached && transportEvents.some(event => event.event === "Network.webSocketCreated")
        && (!blackholeProbe || stalledConnections > 0);
      const terminal = !!notice && capture.states.some(state => state.state === "error" && state.at >= notice.at);
      const correctness = blocked && !!notice && terminal;
      const individualTime = delay !== null && delay <= 20_000;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: capture.playback[0]?.at ?? null, t_stop: null,
        t_text: { failure: errorText?.at ?? null, guidance: notice?.at ?? null },
        t_mark: null, t_task: null, t_verified: null, blocked, terminal, notification: notice?.text ?? null,
        statuses: capture.statuses, states: capture.states, noticeDelayMs: delay, thresholdMs: 10_000, individualLimitMs: 20_000,
        transportEvents, stalledConnections, audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
      };
      result.acceptance = { id: blackholeProbe ? "M8b-blackhole-probe" : "M8b", layer: blackholeProbe ? "probe" : "L1", correctness, individualTime, ...evidence };
      verdicts.M8b = verdict(correctness && individualTime && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m1Case) {
    await installRealtimeTiming(rp, panel);
    recordM1 = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      const start = voiced[0]?.at ?? null;
      const end = voiced.at(-1)?.at ?? null;
      const lastFrame = capture.frames.at(-1)?.at ?? null;
      const normalized = (text: string) => text.replace(/[\p{P}\p{Z}\s]/gu, "");
      const beforeEnd = start !== null && end !== null
        ? capture.texts.find(text => text.at >= start && text.at < end)
        : undefined;
      const fullText = capture.texts.find(text => normalized(text.text).includes(normalized(QUESTION!)));
      const textDelay = fullText && end !== null ? fullText.at - end : null;
      const firstVoiceFrame = capture.frames.findIndex(frame => frame.rms > 0.01);
      const lastVoiceFrame = capture.frames.findLastIndex(frame => frame.rms > 0.01);
      const durationSamples = firstVoiceFrame < 0 ? null
        : capture.frames.slice(firstVoiceFrame, lastVoiceFrame + 1).reduce((sum, frame) => sum + frame.samples, 0);
      const duration = durationSamples === null ? null : durationSamples / 24;
      const durationWallMs = start !== null && end !== null ? end - start : null;
      const quietConfirmed = end !== null && lastFrame !== null && lastFrame - end >= 300;
      const complete = duration !== null && duration >= 3000 && quietConfirmed && !!beforeEnd && !!fullText;
      const individualTime = textDelay !== null && textDelay <= 1000;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: capture.playback[0]?.at ?? null,
        t_stop: null, t_text: { partial: beforeEnd?.at ?? null, complete: fullText?.at ?? null },
        t_mark: null, t_task: null, t_verified: null, durationMs: duration, durationSamples, durationWallMs, textDelayMs: textDelay,
        thresholdMs: 500, individualLimitMs: 1000, quietConfirmed, expected: QUESTION,
        textMutations: capture.texts, audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null,
        captureError: capture.error,
      };
      result.acceptance = { id: "M1", layer: "L1", correctness: complete, individualTime, ...evidence };
      verdicts.M1 = verdict(complete && individualTime && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m2aCase) {
    await installRealtimeTiming(rp, panel);
    recordM2a = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      const start = voiced[0]?.at ?? null, end = voiced.at(-1)?.at ?? null;
      const gaps = voiced.slice(1).map((frame, i) => frame.at - voiced[i]!.at);
      const pauseMs = gaps.length ? Math.max(...gaps) : null;
      const fixtureValid = pauseMs !== null && pauseMs >= 1200 && pauseMs <= 1320;
      const quietConfirmed = end !== null && capture.frames.some(frame => frame.at >= end + 300);
      const texts = start === null ? [] : capture.texts.filter(item => item.at >= start);
      const answers = start === null ? [] : capture.answers.filter(item => item.at >= start);
      const countGroups = (items: Array<{ text: string }>) => {
        let open = false, count = 0;
        for (const item of items) {
          if (!item.text) open = false;
          else if (!open) { count++; open = true; }
        }
        return count;
      };
      const shown = texts.at(-1)?.text ?? "";
      const userGroups = countGroups(texts), answerGroups = countGroups(answers);
      const audioStarts = start === null ? [] : capture.states.filter(item => item.state === "speaking" && item.at >= start);
      const firstSound = capture.playback[0]?.at ?? null;
      const firstAnswer = answers.find(item => item.text)?.at ?? null;
      const correctness = fixtureValid && quietConfirmed && userGroups === 1
        && shown.includes("页面") && shown.includes("备注") && answerGroups === 1 && audioStarts.length === 1
        && end !== null && firstSound !== null && firstSound >= end && firstAnswer !== null && firstAnswer >= end;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: firstSound, t_stop: null, t_text: firstAnswer,
        t_mark: null, t_task: null, t_verified: null, pauseMs, fixtureValid, quietConfirmed, userGroups, answerGroups,
        audibleAnswerCount: audioStarts.length, texts, answers, states: capture.states, playback: capture.playback,
        audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
      };
      result.acceptance = { id: "M2a", layer: "L1", correctness, ...evidence };
      if (pauseMs !== null && !fixtureValid) result.fixtureFailure = "句中停顿不在 1200–1320 ms";
      verdicts.M2a = verdict(correctness && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m2bCase) {
    await installRealtimeTiming(rp, panel);
    recordM2b = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const segments: Array<{ start: number; end: number; firstFrame: number; lastFrame: number }> = [];
      for (const [index, frame] of capture.frames.entries()) {
        if (frame.rms <= 0.01) continue;
        const last = segments.at(-1);
        if (!last || frame.at - last.end > 1200) segments.push({ start: frame.at, end: frame.at, firstFrame: index, lastFrame: index });
        else { last.end = frame.at; last.lastFrame = index; }
      }
      const hum = segments.length >= 2 ? segments.at(-1)! : null;
      const previous = segments.length >= 2 ? segments.at(-2)! : null;
      const humDurationMs = hum ? capture.frames.slice(hum.firstFrame, hum.lastFrame + 1).reduce((sum, frame) => sum + frame.samples, 0) / 24 : null;
      const humWallDurationMs = hum ? hum.end - hum.start + 20 : null;
      const gapMs = hum && previous ? hum.start - previous.end : null;
      const timingValid = humDurationMs !== null && humDurationMs >= 400 && humDurationMs <= 440
        && gapMs !== null && gapMs >= 3420 && gapMs <= 3800;
      const quietConfirmed = !!hum && capture.frames.some(frame => frame.at >= hum.end + 300);
      const sentHum = !!hum && sentVoicedDuringResponse > 0;
      const started = mossProtocol.find(event => event.dir === "received" && event.type === "response.audio.started");
      const runId = typeof started?.runId === "string" ? started.runId : null;
      const ended = mossProtocol.find(event => event.dir === "received" && event.type === "response.ended" && event.runId === runId);
      const startedIndex = started ? mossProtocol.indexOf(started) : -1;
      const stopped = startedIndex >= 0 ? mossProtocol.slice(startedIndex + 1).filter(event => event.dir === "received"
        && ["response.audio.stop", "response.interrupted"].includes(String(event.type))
        && (!event.runId || event.runId === runId)) : [];
      const speaking = capture.states.find(state => state.state === "speaking");
      const listening = speaking ? capture.states.find(state => state.state === "listening" && state.at > speaking.at) : undefined;
      const playedChunks = capture.playback.filter(chunk => speaking && chunk.at >= speaking.at - 50
        && (!listening || chunk.at <= listening.at));
      const playbackAtHum = !!hum && playedChunks.some(chunk => chunk.at <= hum.start
        && chunk.at + (chunk.playedDuration ?? chunk.duration) > hum.start);
      const fixtureValid = timingValid && playbackAtHum;
      const intervals = playedChunks.flatMap(chunk => {
        if (chunk.playedDuration === undefined) return [];
        const end = chunk.at + chunk.playedDuration;
        return end > chunk.at ? [[chunk.at, end] as [number, number]] : [];
      }).sort((a, b) => a[0] - b[0]);
      let playedMs = 0, intervalStart: number | null = null, intervalEnd: number | null = null;
      for (const [start, end] of intervals) {
        if (intervalStart === null || intervalEnd === null) { intervalStart = start; intervalEnd = end; }
        else if (start <= intervalEnd) intervalEnd = Math.max(intervalEnd, end);
        else { playedMs += intervalEnd - intervalStart; intervalStart = start; intervalEnd = end; }
      }
      if (intervalStart !== null && intervalEnd !== null) playedMs += intervalEnd - intervalStart;
      const expectedMs = runId ? (receivedAudioBytes.get(runId) ?? 0) / 96 : 0;
      const ratio = expectedMs > 0 ? playedMs / expectedMs : null;
      const completed = ended?.status === "completed" && mossProtocol.some(event => event.dir === "sent"
        && event.type === "playback.completed" && event.runId === runId);
      const correctness = fixtureValid && !!hum && quietConfirmed && sentHum && playbackAtHum && stopped.length === 0 && completed
        && ratio !== null && ratio >= 0.95;
      const evidence = {
        t_speech_start: hum?.start ?? null, t_end: hum && quietConfirmed ? hum.end : null,
        t_sound: playedChunks[0]?.at ?? null, t_stop: null, t_text: capture.answers[0]?.at ?? null,
        t_mark: null, t_task: null, t_verified: null, humDurationMs, humWallDurationMs, plannedHumDurationMs: 400, gapMs, plannedGapMs: 3800,
        fixtureValid, sentHum, sentVoicedDuringResponse, playbackAtHum, quietConfirmed,
        playedMs, expectedMs, playbackRatio: ratio, completed, stopped, segments, runId, states: capture.states,
        playback: playedChunks, answer: capture.answers.at(-1)?.text ?? "", audioRecorded: capture.audioRecorded,
        audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
      };
      result.acceptance = { id: "M2b", layer: "L1", correctness, ...evidence };
      if (hum && previous && !timingValid) result.fixtureFailure = "附和时长或插话间隔不符合夹具口径";
      else if (hum && playedChunks.length && !playbackAtHum) result.fixtureFailure = "附和没有发生在回答播放期间";
      verdicts.M2b = verdict(correctness && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m4Case) {
    await installRealtimeTiming(rp, panel);
    recordM4 = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const segments: Array<{ start: number; end: number }> = [];
      for (const frame of capture.frames.filter(item => item.rms > 0.01)) {
        const last = segments.at(-1);
        if (!last || frame.at - last.end > 1200) segments.push({ start: frame.at, end: frame.at });
        else last.end = frame.at;
      }
      const second = segments.length >= 2 ? segments.at(-1)! : null;
      const previous = segments.length >= 2 ? segments.at(-2)! : null;
      const gapMs = second && previous ? second.start - previous.end : null;
      const end = second && capture.frames.some(frame => frame.at >= second.end + 300) ? second.end : null;
      const speaking = capture.states.find(state => state.state === "speaking");
      const listening = speaking ? capture.states.find(state => state.state === "listening" && state.at > speaking.at) : undefined;
      const firstChunks = speaking ? capture.playback.filter(chunk => !listening || chunk.scheduledAt <= listening.at) : [];
      const playbackAtBarge = !!second && firstChunks.some(chunk => chunk.at <= second.start
        && chunk.at + (chunk.playedDuration ?? 0) > second.start);
      const ends = firstChunks.flatMap(chunk => {
        if (chunk.playedDuration === undefined || chunk.playedDuration <= 0) return [];
        return [Math.min(chunk.at + chunk.playedDuration, chunk.stoppedAt ?? Infinity)];
      });
      const stop = ends.length && firstChunks.every(chunk => chunk.playedDuration !== undefined) ? Math.max(...ends) : null;
      const stopDelayMs = second && stop !== null ? stop - second.start : null;
      const fixtureValid = gapMs !== null && gapMs >= 3420 && gapMs <= 3800 && playbackAtBarge;
      const heard = second ? capture.texts.filter(item => item.at >= second.start).at(-1)?.text ?? "" : "";
      const answer = end === null ? undefined : capture.answers.find(item => item.at >= end && item.text.includes(NOTE));
      const nextSound = end === null ? null : capture.playback.find(chunk => chunk.at >= end && (!listening || chunk.scheduledAt > listening.at))?.at ?? null;
      const initialHeard = second ? capture.texts.filter(item => item.at < second.start).at(-1)?.text ?? "" : "";
      const correctness = fixtureValid && /故事/.test(initialHeard) && heard.includes("备注")
        && !!answer && nextSound !== null && stopDelayMs !== null && stopDelayMs >= 0;
      const individualTime = stopDelayMs !== null && stopDelayMs <= 600;
      const evidence = {
        t_speech_start: second?.start ?? null, t_end: end, t_sound: nextSound, t_stop: stop,
        t_text: answer?.at ?? null, t_mark: null, t_task: null, t_verified: null,
        stopDelayMs, thresholdMs: 300, individualLimitMs: 600, gapMs, plannedGapMs: 3800, fixtureValid, playbackAtBarge,
        initialHeard, heard, answer: answer?.text ?? "", segments, firstPlayback: firstChunks, states: capture.states,
        audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
      };
      result.acceptance = { id: "M4", layer: "L1", correctness, individualTime, ...evidence };
      if (gapMs !== null && (gapMs < 3420 || gapMs > 3800)) result.fixtureFailure = "插话间隔不符合夹具口径";
      else if (second && firstChunks.length && firstChunks[0]!.at < second.start && !playbackAtBarge) result.fixtureFailure = "插话没有发生在回答播放期间";
      verdicts.M4 = verdict(correctness && individualTime && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m8aCase) {
    await installRealtimeTiming(rp, panel);
    await rp.evaluate(panel, `(() => {
      window.__m8aActions = [];
      for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, event => {
        window.__m8aActions.push({ at: Date.now(), type, target: event.target?.tagName ?? "" });
      }, true);
      return true;
    })()`);
    recordM8a = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const actions = await rp.evaluate(panel, "window.__m8aActions") as Array<{ at: number; type: string; target: string }>;
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      const second = m8aRestored === null ? [] : voiced.filter(frame => frame.at > m8aRestored!);
      const start = second[0]?.at ?? null, lastVoice = second.at(-1)?.at ?? null;
      const end = lastVoice !== null && capture.frames.some(frame => frame.at >= lastVoice + 300) ? lastVoice : null;
      const restoredAt = m8aRestored;
      const ready = restoredAt === null ? undefined : capture.states.find(state => state.state === "listening" && state.at >= restoredAt);
      const reconnectText = /重新连接|重连|正在恢复/;
      const notice = m8aCutEarliest === null || restoredAt === null ? undefined : capture.statuses.find(status =>
        status.at >= m8aCutEarliest! && status.at <= restoredAt && reconnectText.test(status.text));
      const clearance = notice && restoredAt !== null ? capture.statuses.find(status =>
        status.at >= restoredAt && status.at >= notice.at && !reconnectText.test(status.text)) : undefined;
      const recoveryAt = ready && clearance ? Math.max(ready.at, clearance.at) : null;
      const noticePersisted = !!notice && restoredAt !== null && capture.statuses
        .filter(status => status.at > notice.at && status.at < restoredAt).every(status => reconnectText.test(status.text));
      const noticeGone = !!clearance && capture.statuses
        .filter(status => status.at > clearance.at && (start === null || status.at < start)).every(status => !reconnectText.test(status.text));
      const initial = m8aCut === null ? "" : capture.texts.filter(item => item.at < m8aCut!).at(-1)?.text ?? "";
      const heard = start === null ? "" : capture.texts.filter(item => item.at >= start).at(-1)?.text ?? "";
      const answer = start === null ? undefined : capture.answers.filter(item => item.at >= start && /橘黄|橙色|橘色|橙黄/.test(item.text)).at(-1);
      const sound = start === null ? null : capture.playback.find(chunk => chunk.at >= start)?.at ?? null;
      const interveningActions = m8aCutEarliest === null ? [] : actions.filter(action => action.at >= m8aCutEarliest! && (!answer || action.at <= answer.at));
      const offlineMs = m8aCut !== null && restoredAt !== null ? restoredAt - m8aCut : null;
      const recoveryMs = recoveryAt !== null && m8aRestoreEarliest !== null ? recoveryAt - m8aRestoreEarliest : null;
      const answerDelayMs = sound !== null && end !== null ? sound - end : null;
      const offlineMinMs = m8aRestoreEarliest !== null && m8aCut !== null ? m8aRestoreEarliest - m8aCut : null;
      const offlineMaxMs = restoredAt !== null && m8aCutEarliest !== null ? restoredAt - m8aCutEarliest : null;
      const fixtureValid = offlineMinMs !== null && offlineMaxMs !== null && offlineMinMs >= 5000 && offlineMaxMs <= 5500;
      const blocked = m8aAttachmentsDuringBlock === 1 && (m8aErrorsDuringBlock ?? 0) >= 1;
      const correctness = fixtureValid && blocked && wire.attachments >= 2
        && !!notice && noticePersisted && noticeGone && interveningActions.length === 0 && recoveryAt !== null && start !== null && start > recoveryAt
        && /橘黄|橙色|橘色|橙黄/.test(initial) && /刚才/.test(heard) && /颜色/.test(heard)
        && !!answer && sound !== null && end !== null && sound >= end;
      const individualTime = recoveryMs !== null && recoveryMs <= 20_000;
      const answerIndividualTime = answerDelayMs !== null && answerDelayMs <= 4000;
      const retryGate = m8aRetryTimeout ? await rp.evaluate(off, "window.__m8aRetryGate") as { delayedAt: number | null } : null;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: sound, t_stop: null, t_text: answer?.at ?? null,
        t_mark: null, t_task: null, t_verified: null, t_cut: m8aCut, t_restore: restoredAt, t_recovered: recoveryAt,
        t_cut_earliest: m8aCutEarliest, t_restore_earliest: m8aRestoreEarliest,
        offlineMs, offlineMinMs, offlineMaxMs, fixtureValid, recoveryMs, answerDelayMs, thresholdMs: 10_000, individualLimitMs: 20_000,
        answerThresholdMs: 2000, answerIndividualLimitMs: 4000, answerIndividualTime, blocked, m8aAttachmentsDuringBlock,
        m8aErrorsDuringBlock, notice: notice?.text ?? null, noticePersisted, noticeGone,
        noticeClearedAt: clearance?.at ?? null, readyAt: ready?.at ?? null,
        interveningActions, initial, heard, answer: answer?.text ?? "", lastAnswer: capture.answers.at(-1)?.text ?? "",
        sessionIds, retryGate, states: capture.states,
        statuses: capture.statuses, audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null,
        captureError: capture.error,
      };
      const id = m8aRetryTimeout ? "M8a-retry-timeout" : m8aTranscriptProbe ? "M8a-transcript" : "M8a";
      result.acceptance = { id, layer: m8aRetryTimeout || m8aTranscriptProbe ? "calibration" : "L1", correctness, individualTime, ...evidence };
      if (m8aTranscriptProbe) {
        const boundary = { heard, initialLeaked: /我最喜欢的颜色是橘黄色/.test(heard), secondPresent: /刚才/.test(heard) && /颜色/.test(heard) };
        result.transcriptBoundary = boundary;
        verdicts.transcriptBoundary = verdict(!boundary.initialLeaked && boundary.secondPresent, boundary);
      }
      if (offlineMs !== null && !fixtureValid) result.fixtureFailure = "断网时间不在 5000–5500 ms";
      const resumedSameSession = !m8aRetryTimeout || !!retryGate?.delayedAt && sessionIds.length >= 3 && sessionIds.every(id => id === sessionIds[0]);
      verdicts.M8a = verdict(correctness && individualTime && (m8aRetryTimeout || answerIndividualTime)
        && resumedSameSession && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m5Case) {
    await installRealtimeTiming(rp, panel);
    recordM5 = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const pageState = await rp.evaluate(page, "window.__m5 ?? null") as {
        oldShownAt: number; oldText: string; changedAt: number | null; newText: string | null;
      } | null;
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      const start = voiced[0]?.at ?? null, lastVoice = voiced.at(-1)?.at ?? null;
      const end = lastVoice !== null && capture.frames.some(frame => frame.at >= lastVoice + 300) ? lastVoice : null;
      const change = pageState?.changedAt ?? null;
      const intervalMs = start !== null && change !== null ? start - change : null;
      const oldVisibleMs = pageState && change !== null ? change - pageState.oldShownAt : null;
      const fixtureValid = pageState?.oldText === NOTE && pageState.newText === M5_NOTE
        && oldVisibleMs !== null && oldVisibleMs >= 3000 && intervalMs !== null && intervalMs >= 1000 && intervalMs <= 1100;
      const answer = capture.answers.at(-1)?.text ?? "";
      const answerAt = capture.answers.find(item => item.text.includes("蓝色") && item.text.includes("包装"))?.at ?? null;
      const sound = capture.playback[0]?.at ?? null;
      const heard = capture.texts.at(-1)?.text ?? "";
      const correctness = fixtureValid && heard.includes("备注") && answer.includes("蓝色") && answer.includes("包装")
        && answerAt !== null && sound !== null && end !== null;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: sound, t_stop: null, t_text: answerAt,
        t_mark: null, t_task: null, t_verified: null, t_change: change, oldVisibleMs, intervalMs,
        fixtureValid, oldText: pageState?.oldText ?? "", newText: pageState?.newText ?? "", heard, answer,
        states: capture.states, audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null,
        captureError: capture.error,
      };
      result.acceptance = { id: "M5", layer: "L1", correctness, ...evidence };
      if (pageState && change !== null && !fixtureValid) result.fixtureFailure = "页面变化与开口的时序不符合夹具口径";
      verdicts.M5 = verdict(correctness && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m3Case || m8cCase || bddObserve) {
    await installRealtimeTiming(rp, panel);
    if (bddObserve) await installReadOnlyTiming(rp, panel, page);
    recordAnswerLatency = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const readOnly = bddObserve ? await readReadOnlyTiming(rp, panel, page) : null;
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      const start = voiced[0]?.at ?? null, end = voiced.at(-1)?.at ?? null;
      const quietConfirmed = end !== null && capture.frames.some(frame => frame.at >= end + 300);
      const firstSound = capture.playback[0]?.at ?? null;
      const delay = firstSound !== null && end !== null ? firstSound - end : null;
      const expected = bddObserve ? "耐磨橡胶" : NOTE;
      const answer = capture.answers.at(-1)?.text ?? "";
      const heard = capture.texts.at(-1)?.text ?? "";
      const readyAt = capture.states.find(state => state.state === "listening")?.at ?? null;
      const idleMs = start !== null && readyAt !== null ? start - readyAt : null;
      const idleStates = readyAt !== null && start !== null
        ? capture.states.filter(state => state.at > readyAt && state.at <= start) : [];
      const connectingDuringIdle = idleStates.filter(state => state.state === "connecting");
      const attachesDuringIdle = readyAt !== null && start !== null
        ? mossProtocol.filter(event => event.dir === "received" && event.type === "session_attached" && Number(event.at) > readyAt && Number(event.at) <= start) : [];
      const connectionAtSpeech = start === null || readyAt === null ? null : {
        remainedReadyThroughoutSilence: connectingDuringIdle.length === 0 && attachesDuringIdle.length === 0,
        connectingDuringSilence: connectingDuringIdle,
        attachesDuringSilence: attachesDuringIdle,
        lastStateBeforeSpeech: idleStates.at(-1) ?? { at: readyAt, state: "listening" },
        connectingAfterSpeech: capture.states.filter(state => state.state === "connecting" && state.at > start
          && (firstSound === null || state.at <= firstSound)),
        attachesAfterSpeech: mossProtocol.filter(event => event.dir === "received" && event.type === "session_attached"
          && Number(event.at) > start && (firstSound === null || Number(event.at) <= firstSound)),
        sessionAttachments: wire.attachments,
      };
      const correct = answer.includes(expected) && heard.includes(bddObserve ? "鞋底" : "备注")
        && (!bddObserve || readOnly?.materialInDom === false)
        && (!m8cCase || idleMs !== null && idleMs >= 7_200_000);
      const individualTime = delay !== null && delay <= (m8cCase ? 2000 : 4000) && quietConfirmed;
      const firstText = capture.answers.find(item => item.text.includes(expected))?.at ?? null;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: firstSound, t_stop: null, t_text: firstText,
        t_mark: null, t_task: null, t_verified: null, answerDelayMs: delay, thresholdMs: 2000, individualLimitMs: m8cCase ? 2000 : 4000,
        expected, answer, heard, quietConfirmed, readyAt, idleMs, connectionAtSpeech, readOnly, playback: capture.playback, states: capture.states,
        audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
      };
      const id = bddObserve ? "1.1" : m8cCase ? "M8c" : "M3";
      result.acceptance = { id, layer: "L1", correctness: correct, individualTime, ...evidence };
      verdicts[id] = verdict(correct && individualTime && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (bddMark) {
    await installRealtimeTiming(rp, panel);
    await installMarkTiming(rp, panel, page, pageUrl);
    recordBddMark = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const pageCapture = await readMarkTiming(rp, page);
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      const start = voiced[0]?.at ?? null, lastVoice = voiced.at(-1)?.at ?? null;
      const quietConfirmed = lastVoice !== null && capture.frames.some(frame => frame.at >= lastVoice + 300);
      const end = quietConfirmed ? lastVoice : null;
      const mark = pageCapture.marks[0];
      const target = mark?.target;
      const targetArea = target ? target.width * target.height : 0;
      const markArea = mark ? mark.rect.width * mark.rect.height : 0;
      const intersection = mark && target
        ? Math.max(0, Math.min(mark.rect.x + mark.rect.width, target.x + target.width) - Math.max(mark.rect.x, target.x))
          * Math.max(0, Math.min(mark.rect.y + mark.rect.height, target.y + target.height) - Math.max(mark.rect.y, target.y))
        : 0;
      const coverage = targetArea ? intersection / targetArea : 0;
      const areaRatio = targetArea ? markArea / targetArea : null;
      const firstSound = capture.playback[0]?.at ?? null;
      const firstListening = firstSound === null ? undefined : capture.states.find(state => state.state === "listening" && state.at >= firstSound);
      const answerEnds = firstListening ? capture.playback.filter(item => item.at < firstListening.at && item.endedAt !== undefined).map(item => item.endedAt!) : [];
      const answerEnd = answerEnds.length ? Math.max(...answerEnds) : null;
      const delay = mark && end !== null ? mark.at - end : null;
      const voiceServicesReal = wire.ttsRequests === 0 && wire.chunksPlayed > 0 && wire.playbackCompleted > 0 && wire.responseCompleted > 0;
      const realClassification = classifierTraceVerified && (!holdingModel || scriptBrowserTask)
        && (!scriptBrowserTask || taskRouting.scripted > 0 && taskRouting.forwarded > 0 && taskRouting.failed === 0);
      const correctness = coverage >= 0.8 && areaRatio !== null && areaRatio <= 2 && pageCapture.interactions.length === 0
        && mark !== undefined && answerEnd !== null && mark.at < answerEnd && voiceServicesReal && realClassification;
      const individualTime = delay !== null && delay <= 4000;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: firstSound, t_stop: answerEnd, t_text: null,
        t_mark: mark?.at ?? null, t_task: null, t_verified: null, markDelayMs: delay, thresholdMs: 2000, individualLimitMs: 4000,
        coverage, areaRatio, quietConfirmed, interactions: pageCapture.interactions, marks: pageCapture.marks, answers: capture.answers,
        firstListeningAt: firstListening?.at ?? null, playback: capture.playback, states: capture.states,
        ttsRequests: wire.ttsRequests, voiceServicesReal, realClassification, taskRouting,
        audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null,
        captureError: capture.error,
      };
      result.acceptance = { id: "1.2", layer: "L1", correctness, individualTime, ...evidence };
      verdicts.bddMark = verdict(correctness && individualTime && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (speechFormat) {
    await installRealtimeTiming(rp, panel);
    await installTaskTiming(rp, panel);
    recordTaskVoice = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const task = await readTaskTiming(rp, panel);
      const verified = task.checks[0];
      const requests = ttsTimeline.filter(item => verified && item.at >= verified.at);
      const request = requests[0];
      const text = request?.text ?? "";
      const sound = request ? capture.playback.find(item => item.at >= request.at)?.at ?? null : null;
      const panelEvidence = await rp.evaluate(panel, `(() => ({answer: document.querySelector('.voice-answer')?.textContent?.trim() ?? '', rows: document.querySelectorAll('#messages table tbody tr').length, copy: (document.querySelector('#messages')?.innerText ?? '').includes('复制为表格')}))()`) as {answer:string;rows:number;copy:boolean};
      const clean = !/(?:\||-{2,}|[*#`]|\]\(|<[a-z/])/i.test(text);
      const expected = RESEARCH_COMPANIES.every(c => text.includes(c.name) && text.includes(c.business) && text.includes(c.funding));
      const ordered = RESEARCH_COMPANIES.every((c, i) => { const start = text.indexOf(c.name), end = i < 2 ? text.indexOf(RESEARCH_COMPANIES[i + 1].name) : text.length; return start >= 0 && end > start && text.slice(start, end).includes(c.business) && text.slice(start, end).includes(c.funding); });
      const longOk = longHeard.every(x => text.includes(x)) && longCut.every(x => !text.includes(x)) && /另外还有\s*3\s*项，完整内容在侧栏/.test(text);
      const mixedOk = ['三家公司调研结果', '结论', '调研页', ...RESEARCH_COMPANIES.map(c => c.name), '代码在侧栏', '融资未公开的是丙林虚构公司', '以上来自各公司详情页'].every(x => text.includes(x)) && !/127\.0\.0\.1|https?:|fundingKey/.test(text);
      const correctness = clean && requests.length === 1 && panelEvidence.answer === text && (speechFormat === 'mixed' ? mixedOk : (speechFormat === 'long' ? longOk : expected && ordered) && panelEvidence.rows === (speechFormat === 'long' ? 8 : 3) && panelEvidence.copy);
      const delayMs = sound !== null && verified ? sound - verified.at : null;
      const individualTime = delayMs !== null && delayMs >= 0 && delayMs <= 3000;
      const evidence = { text, requests, panelEvidence, clean, expected, ordered, longOk, mixedOk, delayMs, verified, sound, task, playback: capture.playback, audioRecorded: capture.audioRecorded, captureError: capture.error };
      result.acceptance = { id: `speech-${speechFormat}`, layer: "L1", correctness, individualTime, ...evidence };
      verdicts.speechFormat = verdict(correctness && individualTime && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m7Reconnect) {
    await installRealtimeTiming(rp, panel);
    await installTaskTiming(rp, panel);
    recordTaskVoice = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const task = await readTaskTiming(rp, panel);
      const [first, second] = outages;
      const verified = task.checks[0];
      const resultRequests = ttsTimeline.filter(item => RESEARCH_COMPANIES.filter(company => item.text.includes(company.name)).length >= 2);
      const resultRequest = resultRequests[0];
      const resultSound = resultRequest ? capture.playback.find(chunk => chunk.at >= resultRequest.at)?.at ?? null : null;
      // 侧栏察觉断线（进入重连）之后、重新回到「在听」之前核对完成，才算走到「断线期间完成」的交接路径。
      const noticedDrop = first ? capture.states.find(item => item.at >= first.cut && item.state === "connecting")?.at ?? null : null;
      const resumed = noticedDrop !== null ? capture.states.find(item => item.at > noticedDrop && item.state === "listening")?.at ?? null : null;
      const fixtureValid = !!first && !!verified && noticedDrop !== null && resumed !== null && verified.at > noticedDrop && verified.at < resumed && first.attachmentsDuringBlock === 0;
      const playedOnce = resultRequests.length === 1 && resultSound !== null && !!verified && resultSound >= verified.at;
      const notReplayed = !!second && second.reattachedAt !== null && resultRequests.every(item => item.at < second.cut);
      const evidence = {
        t_goal_check_reply: goalCheckReplyAt, t_noticed_drop: noticedDrop, t_resumed: resumed, t_verified: verified?.at ?? null, t_sound: resultSound, outages, researchVisits, resultRequests, ttsTimeline,
        fixtureValid, playedOnce, notReplayed, runIds: [...new Set(task.cards.map(card => card.runId))], task,
        provider: "mock-minimax", taskRouting, playback: capture.playback, states: capture.states,
        audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
      };
      result.acceptance = { id: "818-auto", layer: "L1", correctness: fixtureValid && playedOnce && notReplayed, ...evidence };
      if (!fixtureValid) result.fixtureFailure = "任务核对完成不在第一次断线期间";
      verdicts.reconnectDelivery = verdict(fixtureValid && playedOnce && notReplayed && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (bddResearch && !m7Reconnect && !speechFormat) {
    await installRealtimeTiming(rp, panel);
    await installTaskTiming(rp, panel);
    await rp.evaluate(panel, `(() => {
      const runs = window.__researchRuns = [];
      const seen = new Set();
      const observe = () => {
        for (const node of document.querySelectorAll(".run-steps[data-run-id], .ai-task-card[data-run-id]")) {
          const id = node.dataset.runId;
          if (id && !seen.has(id)) { seen.add(id); runs.push({ runId: id, at: Date.now() }); }
        }
      };
      new MutationObserver(observe).observe(document, { subtree: true, childList: true, attributes: true });
      observe();
      return true;
    })()`);
    recordBddResearch = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const task = await readTaskTiming(rp, panel);
      const runs = await rp.evaluate(panel, "window.__researchRuns") as Array<{ runId: string; at: number }>;
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      if (bddResearchProgress) {
        const segments: Array<{ start: number; end: number }> = [];
        for (const frame of voiced) {
          const segment = segments.at(-1);
          if (!segment || frame.at - segment.end > 5000) segments.push({ start: frame.at, end: frame.at });
          else segment.end = frame.at;
        }
        const first = segments[0], question = segments[1], card = task.cards[0];
        const toolResults = traceEvents.filter(entry => entry.type === "tool_execution_end" && entry.runId === card?.runId)
          .map(entry => {
            const text = JSON.stringify(entry.data.result ?? "");
            const target = text.match(/Navigation result: (https?:\/\/[^ ]+)/)?.[1];
            return { at: entry.at, tool: String(entry.data.toolName ?? ""), text, path: target ? new URL(target).pathname : null };
          });
        const beforeQuestion = toolResults.filter(entry => question && entry.at <= question.start);
        const visitedSecond = beforeQuestion.some(entry => entry.tool === "navigate" && entry.path === "/research/yi");
        const visitedThird = beforeQuestion.some(entry => entry.tool === "navigate" && entry.path === "/research/bing");
        const firstRead = beforeQuestion.some(entry => entry.text.includes(RESEARCH_COMPANIES[0].business));
        const fixtureValid = !!first && !!question && segments.length === 2 && researchFixture !== null
          && researchFixture.at <= first.start && visitedSecond && !visitedThird && firstRead;
        const firstSound = question ? capture.playback.find(item => item.at >= question.end)?.at ?? null : null;
        const answer = question ? capture.answers.filter(item => item.at >= question.start).at(-1)?.text ?? "" : "";
        const knownFacts = RESEARCH_COMPANIES.slice(0, 2).flatMap(company => [company.business, company.funding])
          .filter(fact => toolResults.some(entry => entry.at <= (firstSound ?? question?.end ?? 0) && entry.text.includes(fact)));
        const knownFactInAnswer = knownFacts.some(fact => answer.includes(fact));
        const unreadThirdMentioned = [RESEARCH_COMPANIES[2].name, "丙林", RESEARCH_COMPANIES[2].business]
          .some(value => answer.includes(value));
        const realClassification = !!question && traceEvents.some(entry => entry.at >= question.start && entry.type === "side_call"
          && entry.data.purpose === "voice_plan" && entry.data.model === modelArg && entry.data.outcome === "ok");
        const voiceServicesReal = wire.ttsRequests === 0 && wire.chunksPlayed > 0 && wire.responseCompleted >= 2;
        const correctness = fixtureValid && !!card && runs.length === 1 && runs[0]?.runId === card.runId
          && answer.includes("乙河") && knownFactInAnswer && !unreadThirdMentioned && realClassification && voiceServicesReal;
        const soundDelayMs = firstSound !== null && question ? firstSound - question.end : null;
        const individualTime = soundDelayMs !== null && soundDelayMs >= 0 && soundDelayMs <= 4000;
        const evidence = {
          t_speech_start: question?.start ?? null, t_end: question?.end ?? null, t_sound: firstSound,
          t_stop: null, t_text: capture.answers.find(item => question && item.at >= question.start)?.at ?? null,
          t_mark: null, t_task: card?.at ?? null, t_verified: null, soundDelayMs, fixtureValid,
          visitedSecond, visitedThird, firstRead, researchFixture, researchScreenFrames: [...researchScreenFrames],
          researchUpdates: researchUpdates.map(update => ({ ...update })), segments, runs, task, answer, knownFacts,
          knownFactInAnswer, unreadThirdMentioned, realClassification, voiceServicesReal,
          taskRouting: { ...taskRouting }, ttsRequests: wire.ttsRequests, playback: capture.playback,
          audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
        };
        if (!fixtureValid) result.fixtureFailure = "追问时未处于第二家公司或缺少第一家已读事实";
        result.acceptance = { id: "2.2", layer: "L1", correctness, individualTime, ...evidence };
        verdicts.bddResearch = verdict(correctness && individualTime && capture.audioRecorded && !capture.error, evidence);
        return;
      }
      const start = voiced[0]?.at ?? null, lastVoice = voiced.at(-1)?.at ?? null;
      const quietConfirmed = lastVoice !== null && capture.frames.some(frame => frame.at >= lastVoice + 300);
      const end = quietConfirmed ? lastVoice : null;
      const firstSound = capture.playback[0]?.at ?? null, card = task.cards[0];
      const soundDelayMs = firstSound !== null && end !== null ? firstSound - end : null;
      const taskDelayMs = card && end !== null ? card.at - end : null;
      const answer = capture.answers.at(-1)?.text ?? "";
      const acknowledgment = /好|收到|我来|帮你|调研|查|对比/.test(answer)
        && !/没收到|无法|不能|失败|不知道/.test(answer);
      const voiceServicesReal = wire.ttsRequests === 0 && wire.chunksPlayed > 0 && wire.playbackCompleted > 0 && wire.responseCompleted > 0;
      const routing = { ...taskRouting };
      const realClassification = classifierTraceVerified && routing.scripted > 0 && routing.forwarded > 0 && routing.failed === 0;
      const fixtureValid = researchFixture !== null && start !== null && researchFixture.at <= start
        && researchScreenFrames.some(at => at >= researchFixture!.at && at <= start);
      const correctness = fixtureValid && !!card && runs.length === 1 && runs[0]?.runId === card.runId
        && firstSound !== null && firstSound <= card.at && acknowledgment && voiceServicesReal && realClassification;
      const individualTime = soundDelayMs !== null && soundDelayMs >= 0 && soundDelayMs <= 4000
        && taskDelayMs !== null && taskDelayMs >= 0 && taskDelayMs <= 4000;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: firstSound, t_stop: null,
        t_text: capture.answers[0]?.at ?? null, t_mark: null, t_task: card?.at ?? null, t_verified: null,
        soundDelayMs, taskDelayMs, fixtureValid, researchFixture, researchScreenFrames, runs, task, answer, acknowledgment, voiceServicesReal, realClassification,
        taskRouting: routing, ttsRequests: wire.ttsRequests, playback: capture.playback, states: capture.states,
        audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
      };
      result.acceptance = { id: "2.1", layer: "L1", correctness, individualTime, ...evidence };
      verdicts.bddResearch = verdict(correctness && individualTime && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (m6Case || m7Case) {
    await installRealtimeTiming(rp, panel);
    await installTaskTiming(rp, panel);
    await installMarkTiming(rp, panel, page, pageUrl, "#save");
    recordTaskVoice = async () => {
      const audioPath = join(artifacts, "assistant.webm");
      const capture = await finishRealtimeTiming(rp, panel, audioPath);
      const task = await readTaskTiming(rp, panel);
      const pageCapture = await readMarkTiming(rp, page);
      const voiced = capture.frames.filter(frame => frame.rms > 0.01);
      const start = voiced[0]?.at ?? null, lastVoice = voiced.at(-1)?.at ?? null;
      const quietConfirmed = lastVoice !== null && capture.frames.some(frame => frame.at >= lastVoice + 300);
      const end = quietConfirmed ? lastVoice : null;
      const firstSound = capture.playback[0]?.at ?? null;
      const card = task.cards[0];
      const verified = task.checks[0];
      const resultRequest = ttsTimeline.find((item, index) => index > 0 && item.text.includes("已圈出保存按钮"));
      const resultSound = resultRequest ? capture.playback.find(chunk => chunk.at >= resultRequest.at)?.at ?? null : null;
      const mark = pageCapture.marks[0], target = mark?.target;
      const marked = !!mark && !!target && mark.rect.x <= target.x + target.width / 2
        && mark.rect.x + mark.rect.width >= target.x + target.width / 2
        && mark.rect.y <= target.y + target.height / 2 && mark.rect.y + mark.rect.height >= target.y + target.height / 2;
      const heard = capture.texts.at(-1)?.text ?? "";
      const answerText = capture.answers.map(item => item.text).join(" ");
      const acknowledgment = /好|收到|我来|帮你|圈|标记/.test(m6Case ? answerText : `${ttsTexts[0] ?? ""} ${answerText}`);
      const voiceServicesReal = m6Case
        ? wire.ttsRequests === 0 && wire.chunksPlayed > 0 && wire.playbackCompleted > 0 && wire.responseCompleted > 0
        : realMinimax && wire.ttsStatus === 200 && wire.ttsCorrectKey && wire.ttsModel === "speech-2.8-hd";
      const realClassification = classifierTraceVerified && (!holdingModel || scriptBrowserTask)
        && (!scriptBrowserTask || taskRouting.scripted > 0 && taskRouting.forwarded > 0 && taskRouting.failed === 0);
      const soundDelayMs = firstSound !== null && end !== null ? firstSound - end : null;
      const taskDelayMs = card && end !== null ? card.at - end : null;
      const resultDelayMs = resultSound !== null && verified ? resultSound - verified.at : null;
      const resultBeforeVerified = resultSound !== null && verified && resultSound < verified.at;
      const correctness = m6Case
        ? heard.includes("保存") && acknowledgment && !!card && firstSound !== null && firstSound <= card.at && voiceServicesReal && realClassification
        : heard.includes("保存") && !!verified && end !== null && end < verified.at && !!resultRequest && resultSound !== null
          && !resultBeforeVerified && marked && pageCapture.interactions.length === 0 && voiceServicesReal;
      const individualTime = m6Case
        ? soundDelayMs !== null && soundDelayMs <= 4000 && taskDelayMs !== null && taskDelayMs <= 4000
        : resultDelayMs !== null && resultDelayMs >= 0 && resultDelayMs <= 6000;
      const evidence = {
        t_speech_start: start, t_end: end, t_sound: m6Case ? firstSound : resultSound,
        t_audible: firstAudiblePlayback(capture.playback, m6Case ? -Infinity : resultRequest?.at), t_stop: null,
        t_text: capture.answers[0]?.at ?? null, t_mark: mark?.at ?? null, t_task: card?.at ?? null,
        t_verified: verified?.at ?? null, soundDelayMs, taskDelayMs, resultDelayMs,
        thresholdMs: m6Case ? { sound: 2000, task: 2000 } : 3000,
        individualLimitMs: m6Case ? { sound: 4000, task: 4000 } : 6000,
        heard, acknowledgment, resultBeforeVerified, marked, pageCapture, task, ttsTimeline,
        voiceServicesReal, realClassification, taskRouting, playback: capture.playback, states: capture.states,
        audioRecorded: capture.audioRecorded, audioPath: capture.audioRecorded ? audioPath : null, captureError: capture.error,
      };
      const id = m6Case ? "M6" : "M7";
      result.acceptance = { id, layer: "L1", correctness, individualTime, ...evidence };
      verdicts[id] = verdict(correctness && individualTime && capture.audioRecorded && !capture.error, evidence);
    };
  }
  if (firstUtterance) await rp.evaluate(off, "window.__firstReadyTargetAt=Date.now()+12000;true");
  await rp.click(panel, "#input");
  await rp.click(panel, ".voice-start");
  if (m5Case) {
    const openedAt = await until(async () => Number(await rp.evaluate(panel, "window.__micOpenedAt")) || undefined, 10_000, "麦克风开启");
    await rp.evaluate(page, `(() => {
      const note = document.querySelector("#note");
      if (!note || !note.getClientRects().length) throw new Error("页面备注不可见");
      const state = window.__m5 = { oldShownAt: Date.now(), oldText: note.value, changedAt: null, newText: null };
      const target = ${openedAt + lead - 1050};
      setTimeout(() => {
        state.changedAt = Date.now();
        note.value = ${JSON.stringify(M5_NOTE)};
        state.newText = note.value;
        note.dispatchEvent(new Event("input", { bubbles: true }));
      }, Math.max(0, target - Date.now()));
      return true;
    })()`);
  }
  if (m8aCase) {
    await until(async () => {
      const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;
      return wire.attachments === 1 && wire.playbackCompleted > 0 && state.voiceState === "listening"
        && /橘黄|橙色|橘色|橙黄/.test(state.heard) && !!state.answer ? true : undefined;
    }, 50_000, "首次对话完整结束", 250);
    const errorsBefore = transportEvents.filter(event => event.event === "Network.webSocketFrameError").length;
    m8aCutEarliest = Number(await rp.evaluate(panel, "Date.now()"));
    await rp.cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, off);
    await rp.evaluate(off, `(() => { const socket = window.__mossSockets.at(-1); if (!socket) throw Error("缺少连接"); socket.close(4000, "test interruption"); return true; })()`);
    m8aCut = Number(await rp.evaluate(panel, "Date.now()"));
    let elapsed = Number(await rp.evaluate(panel, "Date.now()")) - m8aCut;
    while (elapsed < 5000) {
      await new Promise<void>(resolve => setTimeout(resolve, 5000 - elapsed));
      elapsed = Number(await rp.evaluate(panel, "Date.now()")) - m8aCut;
    }
    m8aAttachmentsDuringBlock = wire.attachments;
    m8aErrorsDuringBlock = transportEvents.filter(event => event.event === "Network.webSocketFrameError").length - errorsBefore;
    m8aRestoreEarliest = Number(await rp.evaluate(panel, "Date.now()"));
    if (m8aRetryTimeout) await rp.evaluate(off, "window.__m8aRetryGate.armed = true");
    await rp.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, off);
    m8aRestored = Number(await rp.evaluate(panel, "Date.now()"));
    await until(async () => {
      const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;
      const reconnectVisible = await rp.evaluate(panel, `(() => {
        const region = document.querySelector(".voice-progress");
        if (!region || region.hidden || !region.getClientRects().length) return false;
        return [...region.querySelectorAll(".voice-state, .voice-state-detail")]
          .some(node => node.getClientRects().length && /重新连接|重连|正在恢复/.test(node.textContent ?? ""));
      })()`);
      return wire.attachments >= 2 && state.voiceState === "listening" && !reconnectVisible || undefined;
    }, 25_000, "恢复网络后自动连接并清除提示");
  }
  // 结果由 MiniMax 在侧栏播放，不经 MOSS，不会有 playback.completed；以侧栏里请求之后那段声音播完为准。
  const resultPlayed = async (requestAt: number): Promise<boolean> => !!await rp.evaluate(panel, `(window.__realtimeTiming?.playback ?? []).some(item => item.at >= ${requestAt} && item.endedAt !== undefined)`);
  const outages: Array<{ cut: number; restored: number; attachmentsBefore: number; attachmentsDuringBlock: number; reattachedAt: number | null }> = [];
  const voiceOutage = async (afterCut?: () => Promise<void>) => {
    const attachmentsBefore = wire.attachments;
    await rp.evaluate(off, `(() => { const socket = window.__mossSockets.at(-1); if (!socket) throw Error("缺少连接"); window.__mossBlocked = true; socket.close(4000, "test interruption"); return true; })()`);
    const cut = Number(await rp.evaluate(panel, "Date.now()"));
    if (afterCut) await afterCut();
    let elapsed = Number(await rp.evaluate(panel, "Date.now()")) - cut;
    while (elapsed < 5000) {
      await new Promise<void>(resolve => setTimeout(resolve, 5000 - elapsed));
      elapsed = Number(await rp.evaluate(panel, "Date.now()")) - cut;
    }
    const attachmentsDuringBlock = wire.attachments - attachmentsBefore;
    await rp.evaluate(off, "window.__mossBlocked = false; true");
    const outage = { cut, restored: Number(await rp.evaluate(panel, "Date.now()")), attachmentsBefore, attachmentsDuringBlock, reattachedAt: null as number | null };
    outages.push(outage);
    await until(async () => wire.attachments > attachmentsBefore && (await rp.evaluate(panel, PANEL_STATE) as PanelState).voiceState === "listening" || undefined, 30_000, "断线后重新连接");
    outage.reattachedAt = Number(await rp.evaluate(panel, "Date.now()"));
  };
  if (m7Reconnect) {
    await Promise.race([goalCheckReady, new Promise((_, reject) => setTimeout(() => reject(new Error("等待超时（150 秒）：任务核对请求")), 150_000))]);
    await voiceOutage(async () => {
      await until(async () => (await rp.evaluate(panel, PANEL_STATE) as PanelState).voiceState === "connecting" || undefined, 4000, "侧栏察觉断线");
      releaseGoalCheck();
    });
  }
  if (mossReconnect) {
    await until(async () => wire.attachments >= 1 && (await rp.evaluate(panel, PANEL_STATE) as PanelState).voiceState === "listening" || undefined, 25_000, "首次连接");
    await rp.evaluate(off, `(() => { const socket = window.__mossSockets.at(-1); if (!socket) throw Error("缺少连接"); socket.close(4000, "test interruption"); return true; })()`);
    await until(async () => wire.attachments >= 2 && (await rp.evaluate(panel, PANEL_STATE) as PanelState).voiceState === "listening" || undefined, 25_000, "断线后重新连接");
    verdicts.connectionRecovered = verdict(wire.attachments >= 2, { attachments: wire.attachments, sameSession: !!sessionIds[0] && sessionIds[0] === sessionIds[1] });
  }
  let settled = 0;
  let lastPanelStatus = "";
  await until(async () => {
    await readMarks().catch(() => {});
    // SAFETY: PANEL_STATE 返回 PanelState。
    const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;
    last = state;
    if (firstUtterance && /再说一遍|重说/.test(state.voiceStatus)) throw new Error(`第一句话没有自动处理，要求用户重说：${state.voiceStatus}`);

    if (state.voiceState && states.at(-1) !== state.voiceState) states.push(state.voiceState);

    // 状态和状态文字都记：挂住重连后「请再说一遍」是同一个 listening 状态下的文字变化。
    if (state.voiceState && `${state.voiceState}|${state.voiceStatus}` !== lastPanelStatus) {
      lastPanelStatus = `${state.voiceState}|${state.voiceStatus}`;
      opening.push({ at: Date.now(), event: `panel:${state.voiceState}`, text: state.voiceStatus });
    }

    if (state.voiceState === "error") return true;
    if (m2bCase) {
      const humOccurred = await rp.evaluate(panel, `(() => {
        const frames = window.__realtimeTiming?.frames?.filter(frame => frame.rms > 0.01) ?? [];
        return frames.some((frame, i) => i > 0 && frame.at - frames[i - 1].at > 1200);
      })()`);
      const runId = mossProtocol.find(event => event.dir === "received" && event.type === "response.audio.started")?.runId;
      const finished = mossProtocol.some(event => event.dir === "received" && event.runId === runId
        && ["response.ended", "response.audio.stop", "response.interrupted"].includes(String(event.type)));
      settled = humOccurred && runId && finished && state.voiceState === "listening" ? settled + 1 : 0;
      return settled >= 4 ? true : undefined;
    }
    if (mossVoice && caseName === "mark" && wire.ttsStatus >= 400 && state.answer) return true;
    if (mossVoice && caseName === "mark" && state.voiceStatus.includes("MiniMax 朗读没有成功")) return true;
    if (m7Reconnect) {
      const checks = (await readTaskTiming(rp, panel)).checks.length;
      const requested = ttsTimeline.some(item => RESEARCH_COMPANIES.filter(company => item.text.includes(company.name)).length >= 2);
      const resultAt = ttsTimeline.find(item => RESEARCH_COMPANIES.filter(company => item.text.includes(company.name)).length >= 2)?.at;
      settled = checks > 0 && resultAt !== undefined && await resultPlayed(resultAt) && state.voiceState === "listening" ? settled + 1 : 0;
      return settled >= 4 ? true : undefined;
    }
    if (speechFormat) {
      const verified = (await readTaskTiming(rp, panel)).checks[0];
      const resultAt = verified ? ttsTimeline.find(item => item.at >= verified.at)?.at : undefined;
      settled = resultAt !== undefined && await resultPlayed(resultAt) && state.voiceState === "listening" ? settled + 1 : 0;
      return settled >= 4 ? true : undefined;
    }
    if (bddResearch) {
      const task = await readTaskTiming(rp, panel);
      if (bddResearchProgress && state.heard.includes("哪一步") && state.voiceStatus.includes("语音服务没有答上")) return true;
      const answered = bddResearchProgress ? state.heard.includes("哪一步") && wire.responseCompleted >= 2 : wire.responseCompleted > 0;
      settled = task.cards.length > 0 && taskRouting.scripted > 0 && answered
        && state.voiceState === "listening" ? settled + 1 : 0;
      return settled >= 4 ? true : undefined;
    }
    if (m6Case) {
      const checks = await rp.evaluate(panel, "window.__taskTiming?.checks?.length ?? 0") as number;
      settled = checks > 0 && wire.responseCompleted > 0 && state.voiceState === "listening" ? settled + 1 : 0;
      return settled >= 4 ? true : undefined;
    }
    if (m7Case) {
      const checks = await rp.evaluate(panel, "window.__taskTiming?.checks?.length ?? 0") as number;
      const resultRequested = ttsTimeline.some((item, index) => index > 0 && item.text.includes("已圈出保存按钮"));
      settled = checks > 0 && resultRequested && state.voiceState === "listening" ? settled + 1 : 0;
      return settled >= 4 ? true : undefined;
    }
    // 插话用例要等第二句的回答：假麦克风放完、侧栏听到的是第二句之后才开始算回答稳定。
    const secondTurn = m8aCase ? state.heard.includes("刚才") : m4Case || m2aCase || noticeBarge ? state.heard.includes("备注") : caseName !== "barge-in" || (state.heard.includes("备注") && Date.now() - began > lead + 40_000);
    const answerMatches = m8aCase ? /橘黄|橙色|橘色|橙黄/.test(state.answer)
      : m5Case ? state.answer.includes("蓝色") && state.answer.includes("包装")
      : m2aCase || bddObserve || (caseName !== "question" && !noticeBarge) || state.answer.includes(NOTE);
    const answered = secondTurn && (answerMatches || (m8aRetryTimeout || m8aTranscriptProbe) && wire.responseCompleted >= 2)
      && !!state.answer && state.voiceState === "listening" && states.includes("speaking");
    settled = answered ? settled + 1 : 0;

    return settled >= 4 ? true : undefined;
  }, m8bCase ? 50_000 : noticeBarge ? 45_000 : TURN_LIMIT_MS, m8bCase ? "无法连接提示和重试结束" : "语音回答", 500);
  if (m7Reconnect) {
    await voiceOutage();
    await new Promise<void>(resolve => setTimeout(resolve, 8000));
  }
  result.turnSeconds = Math.round((Date.now() - began) / 1000);
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  await rp.screenshot(page, join(artifacts, "page.png"));

  // SAFETY: last 只从 PANEL_STATE 读数赋值。
  const final = last as PanelState | null;
  await writeFile(join(artifacts, "panel-transcript.txt"), final?.transcript ?? "");
  verdicts.voiceListening = verdict(states.includes("listening"), { states, status: final?.voiceStatus ?? "" });
  verdicts.heardQuestion = verdict(!!final?.heard.includes(bddResearchProgress ? "哪一步" : bddResearch ? "调研" : noticeBarge ? "备注" : bddObserve ? "鞋底" : bddMark ? "尺码" : caseName === "mark" ? "保存" : caseName === "chat" ? "累" : caseName === "opinion" ? "页面" : "备注"), { heard: final?.heard ?? "" });
  verdicts.noVoiceError = verdict(!states.includes("error"), { states, status: final?.voiceStatus ?? "" });
  if (noticeBarge) verdicts.answerAfterInterruption = verdict(!!final?.answer.includes(NOTE), { answer: final?.answer ?? "" });

  if (personaArg) {
    const expected = personaArg === "custom" ? CUSTOM_PERSONA : VOICE_PERSONAS.find((p) => p.id === personaArg)!.text;
    const instructions = sentInstructions ?? "";
    verdicts.providerGotPersona = verdict(!!sentInstructions && (expected ? instructions.includes(expected) : !instructions.includes("你的性格和口吻：")), { persona: personaArg, tail: instructions.slice(-240) });
  }

  if (voiceArg) verdicts.providerUsedPickedVoice = verdict(voiceFrames.requested === voiceArg && voiceFrames.confirmed === voiceArg, { picked: voiceArg, ...voiceFrames });

  {
    // 语音鉴权头规则只该作用于本扩展发起的连接：普通网页自己连 StepFun/MOSS，服务端不应认出它已鉴权。
    // SAFETY: 这段页面脚本只返回下面四种字符串之一。
    const targetWsUrl = mossVoice ? "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0" : `wss://api.stepfun.com/v1/realtime?model=${MODEL}`;
    const borrowed = await rp.evaluate(page, `new Promise((done) => {
      const socket = new WebSocket(${JSON.stringify(targetWsUrl)});
      const timer = setTimeout(() => { socket.close(); done("timeout"); }, 8000);
      socket.onopen = () => { if (${JSON.stringify(mossVoice)}) socket.send(JSON.stringify({ action: "attach_session" })); };
      socket.onmessage = (e) => { clearTimeout(timer); socket.close(); const s = String(e.data); done(s.includes("session.created") || s.includes("session_attached") ? "session.created" : "other-message"); };
      socket.onclose = (e) => { clearTimeout(timer); done("closed:" + e.code); };
    })`, { timeoutMs: 15_000 }) as string;

    const evidence = { pageOrigin: new URL(pageUrl).origin, outcome: borrowed, extensionAuthenticated: wire.attached };
    // MOSS 拒绝网页 Origin：握手失败不能证明请求里没有被注入密钥。
    verdicts.pageCannotBorrowKey = mossVoice && borrowed !== "session.created"
      ? { status: "unverified", evidence }
      : verdict(borrowed.startsWith("closed:") && borrowed !== "closed:1000", evidence);
  }

  {
    // 语音日常记录：像用户一样从设置页导出，读下载下来的文件。日常模式与本机一致只记 asr / forward / text
    // （逐帧的 ready / append / commit 只在诊断模式产生，见 realtime-voice-session.ts）；识别文字要写进记录，
    // 每行可解析，且不含语音密钥。
    const { exportStatus, voice, traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
    classifierTraceVerified = classifierVerified(traces);
    const lines = voice.split("\n").filter(Boolean).map(parseVoiceLine);
    const types = new Set(lines.map((line) => line?.type));
    const recognized = lines.filter((line) => line && (line.type === "asr" || line.type === "text") && line.text).map((line) => line?.text ?? "");
    // 记录要如实反映侧栏听到的那句话；听得准不准由 heardQuestion 单独判。
    const heard = (final?.heard ?? "").replace(/^你：/, "").trim();
    const pass = ["asr", "text"].every((type) => types.has(type)) && !!heard && recognized.some((text) => text.includes(heard)) && !lines.includes(null) && !voice.includes(voiceKey);
    verdicts.voiceRecordExported = verdict(pass, { heard, exportStatus, lines: lines.length, types: [...types].map(String), recognized: recognized.slice(0, 4), malformed: lines.filter((line) => !line).length });
  }

  if (caseName === "question" || caseName === "barge-in") verdicts.answerFromPage = verdict(!!final?.answer.includes(bddObserve ? "耐磨橡胶" : NOTE), { answer: final?.answer ?? "" });
  else if (caseName === "chat" || caseName === "opinion" || bddMark || bddResearch) {
    // 闲聊只留回答原文给人判断人设语气；机器只查有回答。
    verdicts.answered = verdict(!!final?.answer.trim(), { answer: final?.answer ?? "" });
    result.answer = final?.answer ?? "";
  } else {
    // 判据独立于产品定位逻辑：用 Chrome 自己算的盒子比较圈和按钮。
    // SAFETY: DOM.getDocument/querySelector/getBoxModel 的返回形状见 CDP 规范。
    const { root } = await rp.cdp.send("DOM.getDocument", { depth: 1 }, page) as { root: { nodeId: number } };
    // SAFETY: 同上。
    const { nodeId } = await rp.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#save" }, page) as { nodeId: number };
    // SAFETY: 同上。
    const saveBox = (await rp.cdp.send("DOM.getBoxModel", { nodeId }, page) as { model: { border: number[] } }).model.border;
    const rect = (q: number[]) => ({ x0: Math.min(q[0] ?? 0, q[6] ?? 0), y0: Math.min(q[1] ?? 0, q[3] ?? 0), x1: Math.max(q[2] ?? 0, q[4] ?? 0), y1: Math.max(q[5] ?? 0, q[7] ?? 0) });
    const s = rect(saveBox);
    const covering = [...marks.values()].flatMap((q) => [rect(q)]).filter((m) => m.x0 <= s.x0 + 2 && m.y0 <= s.y0 + 2 && m.x1 >= s.x1 - 2 && m.y1 >= s.y1 - 2 && m.x1 - m.x0 < (s.x1 - s.x0) * 3);
    const receipts = await rp.evaluate(page, "window.receipts");
    verdicts.markCoversSave = verdict(covering.length > 0, { save: s, marks: [...marks.values()].map(rect) });
    verdicts.saveNotClicked = verdict(receipts.save.length === 0 && receipts.cancel.length === 0, { receipts });
    result.answer = final?.answer ?? "";
  }
  }
  if (speechFormat && process.argv.includes("--speech-extra")) {
    if (recordTaskVoice) { await recordTaskVoice(); recordTaskVoice = null; }
    const beforeReplay = (await rp.evaluate(panel, PANEL_STATE) as PanelState).answer;
    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, panel);
    const dark = await rp.evaluate(panel, 'matchMedia("(prefers-color-scheme: dark)").matches');
    await rp.screenshot(panel, join(artifacts, "panel-dark.png"));
    await rp.cdp.send("Page.reload", {}, panel);
    const replay = await until(async () => {
      const state = await rp.evaluate(panel, PANEL_STATE) as PanelState;
      return state.answer === beforeReplay && state.answer ? state.answer : undefined;
    }, 20_000, "侧栏记录重放口语结果");
    const clean = !/(?:\||-{2,}|[*#`]|\]\(|<[a-z/])/i.test(replay);
    result.speechExtra = { dark, beforeReplay, replay, clean, screenshot: join(artifacts, "panel-dark.png") };
    verdicts.speechReplay = verdict(!!dark && clean && replay === beforeReplay, result.speechExtra as JsonRecord);
  }
} catch (error) {
  result.error = error instanceof Error ? error.stack ?? error.message : String(error);
  // SAFETY: last 只从 PANEL_STATE 读数赋值。
  const seen = last as PanelState | null;
  result.lastPanel = { states, voiceState: seen?.voiceState ?? null, voiceStatus: seen?.voiceStatus ?? "", heard: seen?.heard ?? "", answer: seen?.answer ?? "" };

  if ((caseName === "stop-task" || caseName === "ask-status") && panelSession) result.stopTaskProtocol = await rp.evaluate(panelSession, "window.__stopProbe?.frames ?? []").catch(() => []);

  // 语音连不上、出错的底层原因只进诊断记录：失败时导出一份，留下出错的几行。
  if (panelSession) result.voiceErrors = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads")).then(({ voice, traces }) => {
    classifierTraceVerified = classifierVerified(traces);
    return voice.split("\n").filter((line) => /socket_error|fatal|"close|error/i.test(line)).slice(-10);
  }).catch((error: unknown) => `诊断导出失败：${String(error)}`);

  if (panelSession) await rp.screenshot(panelSession, join(artifacts, "panel-failed.png")).catch(() => {});
} finally {
  if (recordBddMark) await recordBddMark().catch(error => {
    result.error ??= `用例 1.2 取证失败：${String(error)}`;
  });
  if (recordBddResearch) await recordBddResearch().catch(error => {
    result.error ??= `调研任务取证失败：${String(error)}`;
  });
  if (recordTaskVoice) await recordTaskVoice().catch(error => {
    result.error ??= `任务语音计时取证失败：${String(error)}`;
  });
  if (recordM2a) await recordM2a().catch(error => {
    result.error ??= `M2a 取证失败：${String(error)}`;
  });
  if (recordM2b) await recordM2b().catch(error => {
    result.error ??= `M2b 取证失败：${String(error)}`;
  });
  if (recordM4) await recordM4().catch(error => {
    result.error ??= `M4 取证失败：${String(error)}`;
  });
  if (recordM5) await recordM5().catch(error => {
    result.error ??= `M5 取证失败：${String(error)}`;
  });
  if (recordM8a) await recordM8a().catch(error => {
    result.error ??= `M8a 取证失败：${String(error)}`;
  });
  if (recordM8b) await recordM8b().catch(error => {
    result.error ??= `M8b 取证失败：${String(error)}`;
  });
  if (recordAnswerLatency) await recordAnswerLatency().catch(error => {
    result.error ??= `回答计时取证失败：${String(error)}`;
  });
  if (recordM1) await recordM1().catch(error => {
    result.error ??= `M1 取证失败：${String(error)}`;
  });
  await recordOpening?.().catch(error => {
    if (firstUtterance) result.error ??= `首句取证失败：${String(error)}`;
  });
  await recordBargeIn?.().catch((error: Error) => { result.bargeInError = String(error); });
  await writeFile(join(artifacts, "chrome-stderr.log"), rp.chromeStderr()).catch(() => {});
  const closed = await rp.close();
  if (m1Case || m2aCase || m2bCase || m3Case || m4Case || m5Case || m6Case || m7Case || m8aCase || m8bCase || m8cCase || bddMark || bddObserve || bddResearch) {
    const videoPath = join(artifacts, "recording", "run.mp4");
    const videoRecorded = (await stat(videoPath).catch(() => null))?.size;
    const prior = m1Case ? verdicts.M1 : m2aCase ? verdicts.M2a : m2bCase ? verdicts.M2b : m3Case ? verdicts.M3 : m4Case ? verdicts.M4 : m5Case ? verdicts.M5 : m6Case ? verdicts.M6 : m7Reconnect ? verdicts.reconnectDelivery : m7Case ? verdicts.M7 : m8aCase ? verdicts.M8a : m8bCase ? verdicts.M8b : m8cCase ? verdicts.M8c : bddObserve ? verdicts["1.1"] : speechFormat ? verdicts.speechFormat : bddResearch ? verdicts.bddResearch : verdicts.bddMark;
    if (prior) {
      prior.evidence.videoPath = videoRecorded ? videoPath : null;
      prior.evidence.videoRecorded = !!videoRecorded;
      if (!videoRecorded) prior.status = "no";
    }
    const acceptance = result.acceptance;
    if (acceptance && typeof acceptance === "object" && !Array.isArray(acceptance)) {
      acceptance.videoPath = videoRecorded ? videoPath : null;
      acceptance.videoRecorded = !!videoRecorded;
    }
  }
  await holdingModel?.close();
  for (const socket of stalledSockets) socket.destroy();
  stalledServer?.close();

  verdicts.noLocalHost = verdict((closed?.hostPids ?? []).length === 0, { hostPids: closed?.hostPids ?? [] });
  site.close();
}

if (providerTimeline.length) {
  const t0 = Number(providerTimeline[0]!.ms);
  result.providerTimeline = providerTimeline.map((f) => ({ ...f, ms: Number(f.ms) - t0 }));
}

result.verdicts = verdicts;

result.finishedAt = new Date().toISOString();

result.ok = !result.error && (!process.argv.includes("--speech-extra") || verdicts.speechReplay?.status === "yes") && (m1Case ? verdicts.M1?.status === "yes" : m2aCase ? verdicts.M2a?.status === "yes" : m2bCase ? verdicts.M2b?.status === "yes" : m3Case ? verdicts.M3?.status === "yes" : m4Case ? verdicts.M4?.status === "yes" : m5Case ? verdicts.M5?.status === "yes" : m6Case ? verdicts.M6?.status === "yes" : m7Reconnect ? verdicts.reconnectDelivery?.status === "yes" : m7Case ? verdicts.M7?.status === "yes" : m8aCase ? verdicts.M8a?.status === "yes" : m8bCase ? verdicts.M8b?.status === "yes" : m8cCase ? verdicts.M8c?.status === "yes" : bddObserve ? verdicts["1.1"]?.status === "yes" : speechFormat ? verdicts.speechFormat?.status === "yes" : bddResearch ? verdicts.bddResearch?.status === "yes" : bddMark ? verdicts.bddMark?.status === "yes" : Object.values(verdicts).every((v) => v.status === "yes"));

await writeFile(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

await rp.remove();

console.log(`\n结果：${result.ok ? "通过" : "未通过"}  用时：${String(result.turnSeconds ?? "-")} 秒  产物：${artifacts}`);

for (const [name, v] of Object.entries(verdicts)) console.log(`  ${v.status.padEnd(4)} ${name}  ${JSON.stringify(v.evidence).slice(0, 300)}`);

if (result.error) console.log(`  错误：${String(result.error).split("\n")[0]}`);

process.exit(result.ok ? 0 : 1);
