// V2.2 影子实验：只验证「请求开始时预判是否需要语音」（spoken_result_0）是否可行。
// 真实 Jev、每句一次、不重跑、共 9 句（dailyLimit=9 硬上限，两问+新问仍在同一次请求内）。
// 不调用 StepFun、不运行浏览器、不生成音频；RouteShadow 仍为 observability-only，
// 结果只记录，不控制语音/工具/路由/任务状态。日志写入本目录下的隔离 shadow-log，
// 不触碰 ~/.sideagent/route-shadow 的日常影子数据与日预算。
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { RouteShadow } from '../../agent/src/route-shadow.js';
import { readTypeSafeKey } from '../../agent/src/typesafe-auth.js';

const GROUPS = [
  {
    group: 1,
    expect: 'false（页面变化+胶囊即可满足）',
    texts: ['切到测试标签页。', '帮我换到测试标签页。', '去测试标签页。'],
  },
  {
    group: 2,
    expect: 'true（动作之外还有明确答案）',
    texts: ['切到测试标签页，顺便告诉我一加一等于几。', '切过去，然后告诉我一加一是多少。', '换到测试标签页，再告诉我现在有几个标签页。'],
  },
  {
    group: 3,
    expect: 'true（要求检查和汇报）',
    texts: ['切到测试标签页，看看页面还需要什么。', '切过去检查一下还有什么需要我处理，并告诉我。', '打开测试页，看看是不是需要登录。'],
  },
] as const;

const DAILY_LIMIT = 9;

const RECORDED_WAIT_MS = 8_000; // Jev 内部超时 4s，留 2 倍余量等 skipped 记录落盘

if (!readTypeSafeKey()) throw new Error('BLOCKED: 缺 Jev 凭据（TYPESAFE_API_KEY 或 ~/.sideagent/typesafe.env），不自行新建');

const out = resolve(`out/acceptance/route-shadow-spoken-result-${Date.now()}`);

const shadowRoot = join(out, 'shadow-log');

await mkdir(shadowRoot, { recursive: true });

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const dayKey = (at: number): string => {
  const d = new Date(at);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const dayFile = (at: number): string => join(shadowRoot, `${dayKey(at)}.jsonl`);

const readLines = async (at: number): Promise<Array<Record<string, unknown>>> => {
  try {
    return (await readFile(dayFile(at), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
};

// A1 现场证据：包装 fetch 计数并抓取每次请求的 questions 键（不改请求内容）。
const fetchProbe = { calls: 0, questionKeys: [] as string[][] };

const probedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  fetchProbe.calls++;

  try { fetchProbe.questionKeys.push(Object.keys(JSON.parse(String(init?.body)).questions).sort()); } catch { fetchProbe.questionKeys.push(['<unparsable>']); }

  return fetch(url, init);
}) as typeof fetch;

const shadow = new RouteShadow({
  enabled: () => true,
  dailyLimit: () => DAILY_LIMIT,
  root: shadowRoot,
  key: () => readTypeSafeKey(),
  fetch: probedFetch,
});

interface SentenceResult {
  id: number; group: number; text: string; expected: string;
  recordType: string | null;
  lane: string | null;
  pageChange: number | null;
  spokenResult: number | null;
  requestMs: number | null;
  skipReason: string | null;
  waitedMs: number;
  directionOk: boolean | null;
}

const results: SentenceResult[] = [];

let id = 0;

for (const bucket of GROUPS) {
  for (const text of bucket.texts) {
    id++;
    const before = (await readLines(Date.now())).length;
    const started = Date.now();
    shadow.observe({
      channel: 'voice', conversationId: 'v22-spoken-result-shadow', voiceId: 'shadow-exp',
      turn: id, itemId: `exp-${id}`, text, previous: [], taskRunning: 'unknown',
    });
    let record: Record<string, unknown> | null = null;
    const deadline = Date.now() + RECORDED_WAIT_MS;

    while (Date.now() < deadline) {
      const lines = await readLines(started);

      if (lines.length > before) { record = lines[lines.length - 1]!; break; }

      await sleep(100);
    }

    const waitedMs = Date.now() - started;
    const jev = (record?.jev ?? {}) as {lane?: string; pageChange?: number; spokenResult?: number; requestMs?: number};
    const spokenResult = typeof jev.spokenResult === 'number' ? jev.spokenResult : null;
    results.push({
      id, group: bucket.group, text, expected: bucket.expect,
      recordType: record ? String(record.type) : null,
      lane: typeof jev.lane === 'string' ? jev.lane : null,
      pageChange: typeof jev.pageChange === 'number' ? jev.pageChange : null,
      spokenResult,
      requestMs: typeof jev.requestMs === 'number' ? jev.requestMs : null,
      skipReason: record?.type === 'skipped' ? String(record.reason) : record === null ? 'no_record' : null,
      waitedMs,
      directionOk: spokenResult === null ? null
        : bucket.group === 1 ? spokenResult < 0.5
        : spokenResult >= 0.5,
    });
  }
}

// ── 结果裁决（只回答两个问题，不选生产阈值） ────────────────────────────────
const valid = results.filter(r => r.spokenResult !== null);

const latencies = valid.flatMap(r => { const v = r.requestMs!;

 return typeof v === 'number' && Number.isFinite(v) ? [v] : []; }).sort((a, b) => a - b);

const median = latencies.length ? (latencies.length % 2 ? latencies[(latencies.length - 1) / 2]! : Math.round((latencies[latencies.length / 2 - 1]! + latencies[latencies.length / 2]!) / 2)) : null;

const verdict = {
  recordsValid: `${valid.length}/${results.length}`,
  allRecorded: valid.length === results.length,
  group1AllBelow05: results.filter(r => r.group === 1).length === 3 && results.filter(r => r.group === 1).every(r => r.directionOk === true),
  groups23AllAtLeast05: results.filter(r => r.group >= 2).length === 6 && results.filter(r => r.group >= 2).every(r => r.directionOk === true),
  directionErrors: results.flatMap(r => r.directionOk === false ? [{ id: r.id, text: r.text, spokenResult: r.spokenResult }] : []),
  noResponseOrInvalid: results.flatMap(r => r.spokenResult === null ? [{ id: r.id, text: r.text, skipReason: r.skipReason }] : []),
  latencyMs: { min: latencies[0] ?? null, median, max: latencies[latencies.length - 1] ?? null, n: latencies.length },
};

const version = (async () => {
  const headRef = (await readFile('.git/HEAD', 'utf8')).trim();
  const head = headRef.startsWith('ref: ') ? (await readFile(join('.git', headRef.slice(5)), 'utf8')).trim() : headRef;

  return {
    head,
    routeShadowSha256: await sha256(resolve('agent/src/route-shadow.ts')),
    routeShadowTestSha256: await sha256(resolve('agent/test/route-shadow.test.ts')),
    credentials: 'Jev 凭据存在（未打印）；未使用 STEPFUN_API_KEY；未连接 StepFun/浏览器',
  };
})();

const evidence = {
  markers: {
    model: 'jev-1.13.0（RouteShadow 原生端点）',
    requests: '每句一次 observe() → 恰好一次 fetch，含 lane_0/pagechange_0/spoken_result_0；不重跑',
    cap: `dailyLimit=${DAILY_LIMIT}（本目录隔离日志，不触碰日常影子数据与日预算）`,
    notUsed: '未调用 StepFun、未运行浏览器、未生成音频；observability-only，不控制任何产品行为',
    reference: '397–572ms 为已有真实工具首回执样本，非同轮严格对照，仅参考',
  },
  fetchProbe,
  results,
  verdict,
  version: await version,
};

await writeFile(join(out, 'result.json'), JSON.stringify(evidence, null, 2));

console.log(JSON.stringify({ out, fetchProbe, results, verdict }, null, 2));

process.exitCode = verdict.allRecorded ? 0 : 1;
