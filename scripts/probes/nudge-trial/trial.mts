// 主动卡真实模型试跑：真网页（无头 Chrome 打开、照内容脚本取正文）+ 几张本机仿造的私人页面，逐个交给真实模型判断要不要出卡。
// NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--conditions=import npx tsx scripts/probes/nudge-trial/trial.mts --headless [--model=openai-codex/gpt-6-luna]
// 结果写 out/probes/nudge-trial/result.json：每页的正文长度、模型原话、过没过核对、卡长什么样、耗时。凭据只在内存里，不刷新令牌。
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { judgeNudge } from "../../../agent/src/nudge.ts";
import type { NudgeContext, NudgeRecentPage } from "../../../shared/nudge.ts";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep } from "../../acceptance/real-path/harness.mts";
import { loadModelPlan } from "../../acceptance/real-path/inproc-config.mts";

requireHeadless();

const out = join(REPO, "out/probes/nudge-trial");

await mkdir(out, { recursive: true });

// 仿造的私人页面：真网页里拿不到的邮件、短信、行程单。
const FAKE: Record<string, [string, string]> = {
  "/hotel": ["订单确认 - 全季酒店北京国贸店", "尊敬的李先生，您的订单已确认。全季酒店 北京国贸店，高级大床房 1 间，入住 2026 年 10 月 8 日，离店 10 月 9 日，退房时间 12:00。订单号 HT20261008331。如需延迟退房、加床或开发票，请联系前台 010-8577 6600 或回复本邮件。房费 ¥568 已在线支付。取消政策：入住前一天 18:00 前可免费取消。"],
  "/water": ["缴费通知", "【北京自来水】尊敬的用户，您的户号 0103877214 本期（9 月）水费 ¥31.97，用水量 6 吨，缴费截止 2026-10-20。可通过支付宝、微信或网上营业厅缴纳，逾期将产生滞纳金。上期已缴 ¥28.40。"],
  "/flight": ["行程单 - 航旅纵横", "旅客 李明，国航 CA1831，北京首都 T3 → 上海虹桥 T2，2026-10-09 08:15 起飞 10:30 到达，经济舱 座位未选。票号 999-2381120345。航班可在起飞前 24 小时内网上值机，行李额 20kg。"],
  "/invite": ["会议邀请：Q4 规划评审", "王敏 邀请你参加：Q4 规划评审。时间 2026 年 10 月 10 日（周五）15:00–16:00，地点 国贸三期 22 层 2203 会议室，线上 腾讯会议 482-339-110。议程：1. Q3 复盘 2. Q4 目标 3. 预算。请在 10 月 9 日前回复是否参加。"],
};

const REAL = [
  "https://www.apple.com.cn/airpods-pro/",
  "https://www.amazon.com/dp/B0D1XD1ZV3",
  "https://en.wikipedia.org/wiki/Retrieval-augmented_generation",
  "https://arxiv.org/abs/2005.11401",
  "https://zh.wikipedia.org/wiki/大型语言模型",
  "https://paulgraham.com/greatwork.html",
  "https://github.com/anthropics/anthropic-sdk-python",
  "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
  "https://docs.python.org/3/tutorial/controlflow.html",
  "https://www.bbcgoodfood.com/recipes/classic-lasagne-0",
  "https://news.ycombinator.com/",
  "https://www.google.com/search?q=airpods+pro",
  "https://sspai.com/",
  "https://www.thepaper.cn/",
  "https://www.bilibili.com/",
  "https://www.ruanyifeng.com/blog/",
  "https://www.douban.com/",
  "https://www.zhihu.com/",
];

// 有「最近看过的页」的场景：先看 before，再看 page。
const PAIRS: Array<[before: string, page: string]> = [
  ["https://en.wikipedia.org/wiki/Retrieval-augmented_generation", "https://arxiv.org/abs/2005.11401"],
  ["https://www.apple.com.cn/airpods-pro/", "https://www.amazon.com/dp/B0D1XD1ZV3"],
  ["/flight", "/hotel"],
];

const site = createServer((q, r) => {
  const page = FAKE[q.url ?? ""];

  r.writeHead(page ? 200 : 404, { "content-type": "text/html;charset=utf-8" }).end(page ? `<!doctype html><meta charset="utf-8"><title>${page[0]}</title><article><p>${page[1]}</p></article>` : "");
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const full = (u: string) => (u.startsWith("/") ? origin + u : u);

// 一、取正文：和内容脚本同一套规则（article → main → body，压空白，截 4000 字）。
type Page = { url: string; title: string; text: string; error?: string };
const pages = new Map<string, Page>();
const rp = await launchRealPath();

try {
  const tab = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);

  for (const u of [...REAL, ...Object.keys(FAKE)]) {
    const url = full(u);

    try {
      await rp.cdp.send("Page.navigate", { url }, tab);
      await sleep(5000);
      const got = await rp.evaluate(tab, "(() => { const root = document.querySelector('article') ?? document.querySelector('main,[role=main]') ?? document.body; return { title: document.title, url: location.href, text: (root?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 4000) }; })()");
      pages.set(u, { url: got.url, title: got.title, text: got.text });
    } catch (e) {
      pages.set(u, { url, title: "", text: "", error: (e as Error).message });
    }
    console.log("取", u, pages.get(u)!.text.length);
  }
} finally {
  await rp.close().catch(() => undefined);
  site.close();
}

// 二、判断：真实模型，一页一次；记下模型原话（核对没过时也看得到它想出什么卡）。
const plan = await loadModelPlan(process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? "openai-codex/gpt-6-luna");
const credentials = new InMemoryCredentialStore();
const models = builtinModels({ credentials });
const provider = models.getProvider(plan.providerId)!;

if (provider.auth.oauth) models.setProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth, refresh: async () => { throw new Error("probe: refresh disabled"); } } } });
// SAFETY: loadModelPlan 返回的 credential 就是 pi-ai 凭据的两种形状之一。
await credentials.modify(plan.providerId, async () => plan.credential as never);
const model = models.getModel(plan.providerId, plan.modelId)!;

let raw = "";
const host = {
  models: new Proxy(models, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);

      if (key !== "completeSimple" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;

      return async (...args: unknown[]) => {
        const reply = await value.apply(target, args);
        // SAFETY: completeSimple 回的是助手消息，content 里文字块带 text。
        raw = ((reply as { content?: Array<{ type: string; text?: string }> }).content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");

        return reply;
      };
    },
  }),
};

const recent = (u: string): NudgeRecentPage => { const p = pages.get(u)!; return { title: p.title, url: p.url, excerpt: p.text.slice(0, 300) }; };
const scenarios: Array<{ page: string; before?: string }> = [...REAL.map((page) => ({ page })), ...Object.keys(FAKE).map((page) => ({ page })), ...PAIRS.map(([before, page]) => ({ page, before }))];
const results = [];

for (const s of scenarios) {
  const p = pages.get(s.page)!;

  if (p.error || p.text.length < 100) { results.push({ ...s, title: p.title, chars: p.text.length, skipped: p.error ?? "正文不足 100 字，真插件也不会判断" }); continue; }
  const context: NudgeContext = { page: { title: p.title, url: p.url, text: p.text }, recent: s.before ? [recent(s.before)] : [] };
  raw = "";
  const t0 = performance.now();
  const card = await judgeNudge(host as never, model, context).catch((e: Error) => ({ error: e.message }));
  const ms = Math.round(performance.now() - t0);
  results.push({ ...s, title: p.title, chars: p.text.length, ms, raw, card });
  console.log(ms, "ms", s.before ? `${s.before} → ` : "", s.page, raw.slice(0, 160));
}

await writeFile(join(out, "result.json"), JSON.stringify({ model: `${plan.providerId}/${plan.modelId}`, at: new Date().toISOString(), results }, null, 1));
console.log("写入", join(out, "result.json"));
