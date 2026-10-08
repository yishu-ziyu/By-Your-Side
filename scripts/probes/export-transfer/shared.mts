/**
 * 导出迁移实验共用：知识与动作原文、种记忆与读记忆、抓发给模型的请求原文、读下载文件与判分（docs/evals/20261008-export-transfer-ab.md）。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { sleep, until, type launchRealPath } from "../../acceptance/real-path/harness.mts";
import { CUSTOMERS, PAGE_SIZE, type SiteEvent } from "./site.mts";

type RealPath = Awaited<ReturnType<typeof launchRealPath>>;

/** 用户 10-08 确认的知识原文；改了就是另一个实验。 */
export const KNOWLEDGE = "当用户要求导出全部数据时，先确认当前网站的导出范围。如果默认只导出当前页，就寻找全量导出方式；如果默认已经导出全部，就直接执行。完成后核对数据完整性。";

/** 动作组：网站 A 上成功的那串步骤，只记做了什么，不记为什么、什么时候适用（用户 10-08 选加这一组）。 */
export const ACTION = "导出客户数据时，先勾选表头的「全选」，再点「选择全部 200 位客户」，然后点「导出」。";

/** 每组记忆里种的那一条；对照组不种。 */
export const SEEDS = { knowledge: KNOWLEDGE, action: ACTION, control: null } as const;

const idbOpen = `async () => {
  const exists = (await indexedDB.databases()).some((d) => d.name === "sideagent-memory");
  return await new Promise((res, rej) => {
    const r = exists ? indexedDB.open("sideagent-memory") : indexedDB.open("sideagent-memory", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("kv")) r.result.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}`;

/**
 * 记忆里只种这一条「到处适用的做事方法」（text 为 null 时清空）；过往任务都清空。库名与键同 memory-used-line.mts。
 * 知识和动作都种成到处适用：两组只差内容。产品真实的做法记忆按网站存，那样测的是范围拦截，不是 Agent 的判断。
 */
export async function seedKnowledge(rp: RealPath, text: string | null): Promise<void> {
  const now = Date.now();
  const entry = { id: "seed-export-knowledge", factId: "seed-export-knowledge", version: 1, text: text ?? "", scope: { kind: "all" }, sourceConversationId: "seed", createdAt: now - 60_000, updatedAt: now - 60_000, kind: "method", status: "active", sourceQuote: text ?? "", useCount: 0, formatVersion: 3 };
  const docs = { memories: JSON.stringify({ format: 3, rev: 1, entries: text ? [entry] : [] }) + "\n", tasks: JSON.stringify({ format: 1, tasks: [] }) + "\n" };
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html`, background: true })).targetId as string;

  try {
    const ext = await rp.attach(target);
    // 新标签页先是 about:blank：确认已经是扩展页再碰 IndexedDB（否则 SecurityError）。
    await until(async () => (await rp.evaluate(ext, `location.protocol === "chrome-extension:" && document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
    await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const tx = db.transaction("kv", "readwrite");
      for (const [k, v] of Object.entries(${JSON.stringify(docs)})) tx.objectStore("kv").put(v, k);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); db.close(); return true; })()`);
  } finally {
    await rp.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
  }
}

/** 扩展内 agent（offscreen inproc.html）发出的每个 POST 的请求原文，按发出顺序。 */
export async function captureModelBodies(rp: RealPath) {
  const target = await until(async () => (await rp.targets()).find((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`), 30_000, "扩展内 agent 的 offscreen 文档");
  const session = await rp.attach(target.targetId);
  const list: Array<{ requestId: string; inline?: string; body?: string }> = [];

  rp.cdp.onEvent("Network.requestWillBeSent", (message: { sessionId?: string; params: { requestId: string; request: { method: string; postData?: string } } }) => {
    if (message.sessionId === session && message.params.request.method === "POST") list.push({ requestId: message.params.requestId, inline: message.params.request.postData });
  });
  await rp.cdp.send("Network.enable", { maxPostDataSize: 4_000_000 }, session);

  return {
    list,
    /** 取齐每条原文（取不到的记空串，判据里会算作「不含知识」）。 */
    texts: async (): Promise<string[]> => {
      for (const item of list) {
        if (item.body !== undefined) continue;
        item.body = item.inline ?? (await rp.cdp.send("Network.getRequestPostData", { requestId: item.requestId }, session).then((r: { postData: string }) => r.postData).catch(() => ""));
      }

      return list.map((item) => item.body ?? "");
    },
  };
}

/** 等下载落盘，返回 before 之后新下载的最后一个 CSV 的编号列（没有新文件为 null）。只判最后一个，导出次数另由网站记录。 */
export async function lastNewCsv(dir: string, before: Set<string>): Promise<{ file: string; ids: string[]; newFiles: number } | null> {
  await sleep(2000);
  await until(async () => !(await readdir(dir)).some((f) => f.endsWith(".crdownload")) || undefined, 15_000, "下载完");
  const fresh = await Promise.all((await readdir(dir)).filter((f) => f.endsWith(".csv") && !before.has(f)).map(async (f) => ({ f, mtime: (await stat(join(dir, f))).mtimeMs })));
  const last = fresh.sort((a, b) => a.mtime - b.mtime).at(-1);

  if (!last) return null;

  return { file: last.f, ids: (await readFile(join(dir, last.f), "utf8")).trim().split("\n").slice(1).map((l) => l.split(",")[0]!), newFiles: fresh.length };
}

/** 判分（规则见验收文件 R1–R3）：ids 是最后一个文件的编号，events 只含这次任务期间网站记下的事。 */
export function judge(task: "T1" | "T2" | "T3", ids: string[], events: SiteEvent[]): Record<string, "PASS" | "FAIL"> {
  const want = task === "T3" ? CUSTOMERS.slice(0, PAGE_SIZE).map((c) => c.id) : CUSTOMERS.map((c) => c.id);
  const exact = ids.length === want.length && new Set(ids).size === ids.length && want.every((id) => ids.includes(id));
  const headTouched = events.some((e) => (e.type === "select-page" && e.checked === true) || (e.type === "export" && e.head === true));
  const verdicts: Record<string, "PASS" | "FAIL"> = {};

  if (task === "T3") verdicts.R2 = exact && events.filter((e) => e.type === "export").at(-1)?.mode === "page" ? "PASS" : "FAIL";
  else verdicts.R1 = exact ? "PASS" : "FAIL";
  if (task === "T2") verdicts.R3 = headTouched ? "FAIL" : "PASS";

  return verdicts;
}

/** 扩展 IndexedDB 里生效的记忆（只读）。 */
export async function readMemories(rp: RealPath): Promise<Array<{ id: string; text: string; kind: string; status: string; scope: { kind: string; hostname?: string } }>> {
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html`, background: true })).targetId as string;

  try {
    const ext = await rp.attach(target);
    await until(async () => (await rp.evaluate(ext, `location.protocol === "chrome-extension:" && document.readyState === "complete"`)) || undefined, 10_000, "扩展页");
    const text = await rp.evaluate(ext, `(async () => { const db = await (${idbOpen})(); const v = await new Promise((res, rej) => { const r = db.transaction("kv").objectStore("kv").get("memories"); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); }); db.close(); return v; })()`);

    // SAFETY: 这个键里只有产品写入的记忆 JSON 文本 { format, rev, entries }。
    return text ? ((JSON.parse(String(text)) as { entries?: Array<{ id: string; text: string; kind: string; status: string; scope: { kind: string; hostname?: string } }> }).entries ?? []).filter((e) => e.status === "active") : [];
  } finally {
    await rp.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
  }
}

const IDLE = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

/**
 * 等这一轮真正结束：回答之后宿主会核对目标，没做完就自己接着做（标题「还没做完，接着做」），中间有几秒看起来空闲。
 * 只看一次空闲会在这个空档提前收卷（10-08 实测截断过 T3），所以要连续空闲 quietMs。返回最后一行过程标题，供事后核对。
 */
export async function waitDone(rp: RealPath, panel: string, label: string, { timeoutMs = 300_000, quietMs = 15_000 } = {}): Promise<string> {
  const started = Date.now();
  let idleSince: number | null = null;

  while (Date.now() - started < timeoutMs) {
    const idle = await rp.evaluate(panel, IDLE).catch(() => false);
    idleSince = idle ? idleSince ?? Date.now() : null;
    if (idleSince !== null && Date.now() - idleSince >= quietMs) return String(await rp.evaluate(panel, `[...document.querySelectorAll(".run-title")].at(-1)?.innerText.trim() ?? ""`).catch(() => ""));
    await sleep(500);
  }

  throw new Error(`${label}：${timeoutMs / 1000} 秒内没有结束`);
}

/**
 * 回答否认文件存在或已保存（「尚未生成」「无法确认文件已保存」）。只说「读不到内容、不能确认里面有 200 条」不算：
 * 那是没核对内容，不是否认下载（10-08 修正：原写法把这类也判成了「说没生成」）。
 */
const DENIES = /尚未(生成|导出|下载|保存)|(没有|未能|没能)(生成|下载|导出)(文件)?|文件还没|(无法|不能)确认.{0,6}(已保存|已下载|已导出|已生成|下载成功|保存成功)|没有可确认的(文件|下载)/;

/** 回答里说已经全部完成。 */
const CLAIMS_ALL = /(已|成功).{0,20}(全部|200 ?(条|位))/;

/**
 * D2、D3（docs/evals/20261008-download-result.md）。files 是下载目录里的文件名；events 是这次任务期间网站记下的事。
 * D3 只在出现过「满足要求的导出」时判；之后再有导出就是重复。
 */
export function judgeReport(task: "T1" | "T2" | "T3", ids: string[], files: string[], reply: string, events: SiteEvent[]): Record<string, string> {
  const csvs = files.filter((f) => f.endsWith(".csv"));
  const want = task === "T3" ? PAGE_SIZE : CUSTOMERS.length;
  // 名字常紧贴着中文写（「已保存为客户列表.csv」）：提到的名字以某个真实文件名结尾，或反过来，都算对得上。
  const named = reply.match(/[^\s「」“”"'（）()，。：:、；！？]+\.csv/g) ?? [];
  const fakeName = named.find((n) => !csvs.some((f) => f === n || f.endsWith(n) || n.endsWith(f)));
  const deny = csvs.length > 0 && DENIES.test(reply);
  const overclaim = task !== "T3" && ids.length !== want && CLAIMS_ALL.test(reply) && !DENIES.test(reply);
  const exports = events.filter((e) => e.type === "export");
  const firstRight = exports.findIndex((e) => task === "T3" ? e.mode === "page" && e.page === 1 && e.count === PAGE_SIZE : e.count === want);

  return {
    D2: deny || overclaim || fakeName ? `FAIL${deny ? "（说没生成）" : ""}${overclaim ? "（说全部完成）" : ""}${fakeName ? `（编造文件名 ${fakeName}）` : ""}` : "PASS",
    D3: firstRight < 0 ? "N/A" : exports.length > firstRight + 1 ? `FAIL（做对后又导出 ${exports.length - firstRight - 1} 次）` : "PASS",
  };
}

/** 诊断记录里每次工具调用：工具名、出没出错、结果开头。 */
export function toolTrail(traces: string): string[] {
  return traces.split("\n").filter(Boolean).flatMap((line) => {
    // SAFETY: 诊断记录每行是 { type, data } 的 JSON。
    const l = JSON.parse(line) as { type: string; data?: { toolName?: string; isError?: boolean; result?: { content?: Array<{ text?: string }> } } };
    if (l.type === "goal_check") return [`[核对] ${JSON.stringify(l.data).slice(0, 200)}`];
    if (l.type !== "tool_execution_end") return [];

    return [`${l.data?.isError ? "✗ " : ""}${l.data?.toolName ?? "?"}: ${(l.data?.result?.content?.[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 240)}`];
  });
}
