import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EARLY_HOLD_LINE, safeEarlyText } from "../src/voice-early.js";
import { controlConfirmMessage, isControlConfirm, isControlReject } from "../src/voice-confirm.js";

const voiceSession = readFileSync(resolve(__dirname, "../src/voice-session.ts"), "utf-8");
const session = readFileSync(resolve(__dirname, "../src/session.ts"), "utf-8");

describe("接话安全台词（① 抢答）", () => {
  it("实测编造过的那两句被拦下", () => {
    // 2026-09-11 14:15–14:17 面板上真实出现过的接话
    expect(safeEarlyText("哎，我刚才没说清楚。这是 Chrome 的扩展管理页，我没法直接帮你把网页标签切过去。你得先去 BOSS 直聘的页面，然后告诉我你想把它移到哪个文件夹里？")).toBeNull();
    expect(safeEarlyText("这是 Chrome 的扩展管理页")).toBeNull();
    expect(safeEarlyText("你想把它移到哪个文件夹里")).toBeNull();
  });

  it("具体对象、数字、拉丁词、动作结果都不许说", () => {
    for (const bad of [
      "我看一下这个页面",
      "稍等，我打开那个标签",
      "我先切换到第 2 个窗口",
      "我看看 BOSS 那边的职位",
      "已经帮你暂停了",
      "收到，马上执行",
      "好的。我确认一下。然后再回答你。",
      "",
      "   ",
    ]) {
      expect(safeEarlyText(bad), bad).toBeNull();
    }
  });

  it("短句准备语照样放行，闲聊不被误伤", () => {
    expect(safeEarlyText("嗯，我看一下。")).toBe("嗯，我看一下。");
    expect(safeEarlyText("好的，我确认一下。")).toBe("好的，我确认一下。");
    expect(safeEarlyText("嗨，我在呢。")).toBe("嗨，我在呢。");
    // 说"打算做什么"是接话本分，不算报事实
    expect(safeEarlyText("我来处理这个修改。")).toBe("我来处理这个修改。");
  });

  it("固定台词本身是安全的", () => {
    expect(safeEarlyText(EARLY_HOLD_LINE)).toBe(EARLY_HOLD_LINE);
  });

  it("接话先攒音频，过校验才播；拦下就换固定台词", () => {
    expect(voiceSession).toMatch(/import \{EARLY_HOLD_LINE,safeEarlyText\} from '\.\/voice-early\.js'/);
    // 攒：early 响应落定前不播（落定后直发，拦下的直接丢）
    expect(voiceSession).toMatch(/else if\(response\.early\)\{if\(response\.earlyDecided\)\{if\(response\.audio\)this\.deps\.emit\(frame\);\}else\{\(response\.earlyAudio\?\?=\[\]\)\.push\(frame\);\}\}/);
    expect(voiceSession).toMatch(/else if\(response\.early\)\{\s*response\.earlyTranscript=text\.slice\(0,2000\);/);
    // 判：整句转写一到就落定（不等 response.done），response.done 再兜一次
    expect(voiceSession.match(/this\.settleEarlyReply\(response\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // 回执到了才是"有依据的接话"（开场确认），不拦；只有还在猜的时候才校验
    expect(voiceSession).toMatch(/const safe=this\.routeReceipt\?said:safeEarlyText\(said\);/);
    expect(voiceSession).toMatch(/this\.diagnostic\('early_reply_blocked',\{characters:said\.length\}\);/);
    expect(voiceSession).toMatch(/this\.pendingHoldLine=EARLY_HOLD_LINE;/);
    // 播：固定台词走"原样朗读 + 校验"，第一次生成、之后走音频缓存
    expect(voiceSession).toMatch(/if\(this\.pendingHoldLine\)\{/);
    expect(voiceSession).toMatch(/const cached=this\.receiptAudioCache\.get\(line\);/);
    // 回执已经到手就不补"我看一下"，直接按回执回答
    expect(voiceSession).toMatch(/if\(receiptSpeech\(this\.routeReceipt\)\)\{\s*this\.diagnostic\('early_hold_line',\{cached:false,skipped:'receipt-ready'\}\);/);
    expect(voiceSession).toMatch(/const expected=this\.response\.early\?null:\(this\.holdExpected\?\?receiptSpeech\(this\.routeReceipt\)\);/);
  });
});

describe("纠正类插话补一次当前页观察（#3）", () => {
  it("页面指代 / 纠正信号才补观察", () => {
    const steerNeeds = (text: string) =>
      /(这|那|当前|刚才|上面|页面|标签|网页|屏幕|截图|不是|不对|其实|改看|别看)/.test(text);
    // 实测踩坑的那句，以及它的前一句
    expect(steerNeeds("不是chrome的扩展管理页了。")).toBe(true);
    expect(steerNeeds("我想把我现在的当前的这个页面切到那个标签页里去。")).toBe(true);
    // 纯参数修改不必补观察，省掉每次插话的页面 token
    expect(steerNeeds("预算改成600")).toBe(false);
  });

  it("插话路径真的会附上观察，且 trace 标了 phase", () => {
    expect(session).toMatch(/const observation = steerNeedsPageObservation\(text\) \? await this\.readUserPageForPrompt\(context, "steer"\) : null;/);
    expect(session).toMatch(/const input = observation \? `\$\{withPageContext\(text, context\)\}\\n\\n\$\{observation\}` : withPageContext\(text, context\);/);
    expect(session).toMatch(/private async readUserPageForPrompt\(context: PageContext \| undefined, phase: "task" \| "steer"\)/);
    expect(session).toMatch(/this\.runTrace\.record\("pre_observation", \{ phase, tabId/);
  });
});

describe("控制句先复述确认（#1）", () => {
  const manager = readFileSync(resolve(__dirname, "../src/conversation-manager.ts"), "utf-8");

  it("对/不认得出来，别的话不当确认", () => {
    for (const yes of ["对", "对的", "是", "嗯", "确认", "好的", "可以", "没错", "就这样。", "照做"]) {
      expect(isControlConfirm(yes), yes).toBe(true);
    }
    for (const no of ["不", "不是", "不对", "算了", "取消", "先别", "别动。"]) {
      expect(isControlReject(no), no).toBe(true);
    }
    // 新的一句委托不能被当成"对"：既不确认也不拒绝，走正常判定
    for (const other of ["打开邮箱", "再改一下预算", "这是什么"]) {
      expect(isControlConfirm(other), other).toBe(false);
      expect(isControlReject(other), other).toBe(false);
    }
  });

  it("复述用用户自己的原话，转写错了才看得见", () => {
    expect(controlConfirmMessage("让位是你把它切过去，就是。")).toBe("你是说“让位是你把它切过去，就是。”，对吗？确认后我就照做。");
  });

  it("改正在跑的任务先问一句，不直接落动作", () => {
    expect(manager).toMatch(/private readonly controlConfirmations=new Map<string,\{voiceId:string;turn:number;expiresAt:number;action:'steer'\|'abort';text:string;expectedRunId:string\|null\}>\(\)/);
    expect(manager).toMatch(/if\(\(step\.action==='steer'\|\|step\.action==='abort'\)&&plan\.steps\.length===1&&targetId===id&&before\.state==='running'&&route\)\{/);
    expect(manager).toMatch(/return \{kind:'clarify',message:controlConfirmMessage\(step\.text\)\};/);
  });

  it("下一轮的对/不决定动作落不落，超时不认", () => {
    expect(manager).toMatch(/Date\.now\(\)\+CONTROL_CONFIRM_TTL_MS/);
    expect(manager).toMatch(/control\.voiceId===route\.voiceId&&route\.turn===control\.turn\+1&&Date\.now\(\)<control\.expiresAt/);
    expect(manager).toMatch(/if\(isControlReject\(text\)\)return \{kind:'clarify',message:'好，那我不动它。'\};/);
    expect(manager).toMatch(/action:control\.action,expectedRunId:control\.expectedRunId,expectedControlVersion:route\.controlVersion\?\?before\.controlVersion\?\?0,text:control\.text/);
    // 只对当前会话、单步的控制句确认；别的会话/多步计划照旧
    expect(manager).toMatch(/plan\.steps\.length===1&&targetId===id/);
  });
});
