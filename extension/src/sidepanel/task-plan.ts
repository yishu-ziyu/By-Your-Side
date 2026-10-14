/**
 * A3：要写页面或跨站时，在任务条上放一行计划「会去 … · 不会做 …」，任务照常马上开始。
 * 不停下来等「开始」（10-13 用户定）：快、少等优先；要拦就点停止。付款和发消息前助手仍会先停下问。
 * 「会做」就是用户气泡里的原话，这一行不再说一遍。
 */
import { hostOf } from "./tab-mentions.js";

export interface TaskPlanLines {
  go: string;
  dont: string;
}

export interface TaskPlan {
  shouldAsk: (text: string, pages: Array<{ url: string }>, currentUrl: string) => boolean;
  /** 任务已经发出：放上这次的计划行。 */
  announce: (text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string) => void;
  /** 这一轮结束：收起计划行。 */
  endRun: () => void;
  reset: () => void;
}

const WRITE = /填|写进|写入|改成|改掉|点一?下|点击|提交|删除|输入|粘贴|勾选|下单|购买|发帖|发表|保存到|填到|填进/;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function uniqueHosts(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const host = hostOf(url);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/** 网站在界面上的名字：一般写主机名；本机地址写页面标题。 */
export function siteName(url: string, title?: string): string {
  const host = hostOf(url);
  if (!host || /^(localhost|127\.|0\.0\.0\.0)/.test(host)) return clip((title ?? "").replace(/\s+/g, " "), 12) || host || "当前页";
  return host;
}

export function planLines(text: string, pages: Array<{ title: string; url: string }>, currentUrl: string, currentTitle?: string): TaskPlanLines {
  const names: string[] = [];
  for (const item of [{ url: currentUrl, title: currentTitle ?? "" }, ...pages]) {
    const name = siteName(item.url, item.title);
    if (name && !names.includes(name)) names.push(name);
  }
  const go = names.join("、") || "当前页";
  return { go, dont: notAuthorized(text) };
}

/**
 * 「不会做」只列用户这句话没授权的动作：助手把原话里的「提交」「下单」当授权（agent/src/prompt.ts），
 * 计划行不能一边写「不会做 提交」一边让它真去提交。
 */
function notAuthorized(text: string): string {
  // 先去掉名词（「报名表」「订单」不是要提交），再去掉否定说法（「不要直接提交」不是授权）。
  const asked = text
    .replace(/报名表|报名页|订单|订阅/g, "")
    .replace(/(?:不要|别|不用|不需要|先不|无需|不)(?:直接|马上|帮我|去|点击|点)*(?:提交|报名|预订|预约|订|付款|支付|下单|购买|发帖|发表|发送)/g, "");
  const left = [
    !/提交|报名|预订|预约|订|发帖|发表|发送|下单/.test(asked) && "提交",
    !/付款|支付|下单|购买|买下/.test(asked) && "付款",
  ].filter(Boolean);
  return left.length ? left.join("、") : "你没说的事";
}

export function needsTaskPlan(text: string, pages: Array<{ url: string }>, currentUrl: string): boolean {
  const hosts = uniqueHosts([currentUrl, ...pages.map((p) => p.url)]);
  return hosts.length > 1 || WRITE.test(text);
}

export function mountTaskPlan(opts: { root: HTMLElement }): TaskPlan {
  let goal: HTMLElement | null = null;
  const clear = (): void => { goal?.remove(); goal = null; };

  return {
    shouldAsk: needsTaskPlan,
    announce: (text, pages, currentUrl, currentTitle) => {
      clear();
      const lines = planLines(text, pages, currentUrl, currentTitle);
      const row = document.createElement("div");
      row.className = "task-plan-goal";
      row.setAttribute("aria-label", "这次的计划");
      row.textContent = `会去 ${lines.go} · 不会做 ${lines.dont}`;
      opts.root.prepend(row);
      goal = row;
    },
    endRun: clear,
    reset: clear,
  };
}
