/**
 * 动作效果证据的后台接线：注入 content-effect.js、取基线、早停收集、清理。
 * 效果证据失败（页面禁止注入、导航换文档、SW 重启）绝不能拖垮动作本身：
 * 所有入口都吞掉异常并返回 undefined，让调用方按「没有证据」处理。
 */
import { settleEffectReport, type EffectReport } from "../../../../shared/effect.js";

const CONTENT_FILE = "content-effect.js";

interface EffectInput {
  token: string;
  point?: [number, number];
  selector?: string;
}

async function callPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Awaited<Result>> {
  const results = await chrome.scripting.executeScript<Args, Result>({ target: { tabId }, world: "ISOLATED", func, args });
  const first = results[0];
  if (!first) throw new Error("页面脚本未返回结果");
  return first.result as Awaited<Result>;
}

export async function ensureEffectScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE], world: "ISOLATED" });
}

/** 动作前取基线；返回 token，失败返回 null（调用方跳过效果证据）。 */
export async function beginEffect(
  tabId: number,
  input: { point?: [number, number]; selector?: string } = {},
): Promise<string | null> {
  const token = crypto.randomUUID();
  try {
    await ensureEffectScript(tabId);
    const payload: EffectInput = { token, ...input };
    // 必须拿到页面侧确认才算基线成立：脚本未注入/版本不符时不能给 token，
    // 否则后面的轮询会空转到超时，把「没采集」当成「没变化」。
    const ack = await callPage<[EffectInput], Promise<{ ok?: boolean } | undefined> | { ok?: boolean } | undefined>(
      tabId,
      (i: EffectInput) => window.__sideagent?.effect?.begin(i),
      [payload],
    );
    return ack?.ok ? token : null;
  } catch {
    return null;
  }
}

/** 动作后收集：有强证据立即返回，否则等到超时；拿不到任何读数返回 undefined。 */
export async function collectEffect(tabId: number, token: string | null): Promise<EffectReport | undefined> {
  if (!token) return undefined;
  try {
    const report = await settleEffectReport(async () => {
      try {
        return await callPage(tabId, (t: string) => window.__sideagent?.effect?.diff?.(t) ?? null, [token]);
      } catch {
        return null;
      }
    });
    return report;
  } finally {
    try {
      await callPage(tabId, (t: string) => window.__sideagent?.effect?.end(t), [token]);
    } catch {
      /* 页面已经换了文档，会话自然消失 */
    }
  }
}
