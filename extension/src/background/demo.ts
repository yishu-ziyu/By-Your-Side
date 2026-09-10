/**
 * 示范录制（background 侧）：谁在录、录到哪一步、什么时候必须停手。
 *
 * 三条约定：
 *   - 示范期间系统不动手：写类工具在这段时间被硬闸门拒绝（见 index.ts 的 execute）。
 *   - 缓冲只在内存：不写 chrome.storage（配额教训：按会话大量落盘会把扩展存储写满）。
 *   - 服务 worker 重启即丢：如实告诉用户「示范中断」，不静默补录。
 */
import { byteLength, recordingHint, type DemoStep } from "../../../shared/demo-record.js";

export interface DemoSession {
  conversationId: string;
  tabId: number;
  steps: DemoStep[];
  truncated: boolean;
  startedAt: number;
  /** 已收工：不再接收上行，但记录留着给用户看（点收起才清） */
  stopped?: boolean;
}

/** 每个会话同时只有一个示范。 */
const sessions = new Map<string, DemoSession>();

/** 单次示范的缓冲上限：内存态，够用即止。 */
const MAX_STEPS = 200;

export function demoSession(conversationId: string): DemoSession | undefined {
  return sessions.get(conversationId);
}

export function isRecording(conversationId: string): boolean {
  const session = sessions.get(conversationId);
  return Boolean(session && !session.stopped);
}

/** 收工后仍留在内存里的这份记录（用户没点收起就一直留着）。 */
export function finishedDemo(conversationId: string): DemoSession | undefined {
  const session = sessions.get(conversationId);
  return session?.stopped ? session : undefined;
}

/** 用户点「收起」：这份记录不再出现。 */
export function dismissDemo(conversationId: string): void {
  sessions.delete(conversationId);
}

/** 录制中的标签页；工具闸门据此拦住"边示范边操作"。 */
export function recordingTabId(conversationId: string): number | undefined {
  return isRecording(conversationId) ? sessions.get(conversationId)?.tabId : undefined;
}

/**
 * 按标签页反查正在录的会话。
 * 页面侧上行只有 sender.tab，而示范页常常还没有任何任务绑定，
 * 因此不能靠 tab→session 绑定去找会话。
 */
export function conversationForRecordingTab(tabId: number): string | undefined {
  for (const session of sessions.values()) if (session.tabId === tabId && !session.stopped) return session.conversationId;
  return undefined;
}

export function demoHint(conversationId: string): string | undefined {
  const s = sessions.get(conversationId);
  return s ? recordingHint(s.steps, s.truncated) : undefined;
}

/**
 * 页面加载完成后接着录：示范常常要跨页（筛选 → 点进详情 → 回来），
 * 而内容脚本随导航一起消失。这里把已记下的步骤与已过时间喂回去，续录而不是重开。
 */
export async function resumeDemoIfRecording(tabId: number): Promise<void> {
  const conversationId = conversationForRecordingTab(tabId);
  if (!conversationId) return;
  const session = sessions.get(conversationId);
  if (!session) return;
  const seed = { steps: session.steps, elapsedMs: Date.now() - session.startedAt };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-record.js"], world: "ISOLATED" });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: (input: { steps: DemoStep[]; elapsedMs: number }) => window.__sideagent?.record?.start?.(input) ?? { ok: false },
      args: [seed],
    });
  } catch {
    /* 这一页注入不了（chrome:// 等）：等下一页再续 */
  }
}

export async function startDemo(conversationId: string, tabId: number): Promise<{ ok: boolean; error?: string }> {
  if (isRecording(conversationId)) return { ok: true };
  sessions.delete(conversationId); // 上一份已收工的记录让位给这次示范
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-record.js"], world: "ISOLATED" });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => window.__sideagent?.record?.start() ?? { ok: false },
    });
    if (results[0]?.result?.ok !== true) return { ok: false, error: "页面脚本没有进入示范模式" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  sessions.set(conversationId, { conversationId, tabId, steps: [], truncated: false, startedAt: Date.now() });
  return { ok: true };
}

export async function stopDemo(conversationId: string): Promise<DemoSession | undefined> {
  const session = sessions.get(conversationId);
  if (!session || session.stopped) return undefined;
  let pageCount: number | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: session.tabId },
      world: "ISOLATED",
      func: () => window.__sideagent?.record?.stop() ?? { ok: false, count: 0 },
    });
    const result = results[0]?.result as { ok?: boolean; count?: number } | undefined;
    if (result?.ok === true && typeof result.count === "number") pageCount = result.count;
  } catch {
    /* 页面已关闭/不可注入：示范结果仍然有效 */
  }
  // 页面 stop() 会立刻补发最后一批；先别删会话，否则这一批会被当成无主消息丢掉。
  if (pageCount !== undefined) {
    const deadline = Date.now() + 800;
    while (session.steps.length < pageCount && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  session.stopped = true; // 记录留着给用户看；点收起才清
  return session;
}

/** 页面侧上行的一批步骤：整批替换，避免丢包造成步骤错位。 */
export function receiveSteps(conversationId: string, steps: DemoStep[], truncated: boolean): void {
  const session = sessions.get(conversationId);
  if (!session || session.stopped) return;
  if (steps.length > MAX_STEPS) {
    session.steps = steps.slice(0, MAX_STEPS);
    session.truncated = true;
    return;
  }
  session.steps = steps;
  session.truncated = session.truncated || truncated || byteLength(steps) > 512_000;
}

/** 供测试与本地审计：当前缓冲的真实步骤数。 */
export function bufferedSteps(conversationId: string): DemoStep[] {
  return sessions.get(conversationId)?.steps ?? [];
}
