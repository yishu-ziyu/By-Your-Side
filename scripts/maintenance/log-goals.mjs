const timeOf = e => Date.parse(e.time ?? '');
const short = (text, max = 80) => String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
const isRun = e => typeof e.runId === 'string' && !!e.runId;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

function resultText(result) {
  return (Array.isArray(result?.content) ? result.content : []).filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n');
}

function errorSignature(event) {
  const data = event.data ?? {};
  const lines = resultText(data.result).split('\n').map(s => s.trim());
  const index = lines.findIndex(s => s && !/^<\/?(?:harness|error)>$/i.test(s));
  if (index < 0) return null;
  const line = lines[index];
  const fields = /Validation failed for tool/i.test(line) ? lines.slice(index + 1).filter(s => /^-\s/.test(s)) : [];
  return `${data.toolName ?? '?'}\0${[line, ...fields].join(' ').replace(/\s+/g, ' ').slice(0, 500)}`;
}

function modelNames(event) {
  const d = event.data ?? {}, message = d.message ?? {};
  const main = typeof d.model === 'string' ? d.model : typeof d.model?.id === 'string' ? [d.model.provider, d.model.id].filter(Boolean).join('/') : '';
  const reply = typeof message.model === 'string' ? [message.provider, message.model].filter(Boolean).join('/') : '';
  return [main, reply].filter(Boolean);
}

function deepLinks(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const matches = text.match(/https?:\/\/[^\s"'<>\\]+/gi) ?? [];
  return matches.flatMap(raw => {
    try {
      const url = new URL(raw.replace(/[),.;\]}]+$/, ''));
      if (!url.pathname.split('/').some(part => part.length >= 12 && /\d/.test(part) && /^[a-z0-9_-]+$/i.test(part))) return [];
      return [`${url.hostname.toLowerCase()}${url.pathname}`];
    } catch { return []; }
  });
}

const COMMON_WORDS = new Set(['https', 'http', 'about', 'please', 'using', 'with', 'from', 'their', 'these', 'this', 'that', 'would', 'could', 'should']);
function intentWords(text) {
  return new Set((String(text).replace(/https?:\/\/[^\s]+/gi, ' ').toLowerCase().match(/[a-z]{5,}/g) ?? []).filter(word => !COMMON_WORDS.has(word)));
}

function nearlySame(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) !== 1 || Math.min(a.length, b.length) < 7) return false;
  const [small, large] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < large.length; i++) if (large.slice(0, i) + large.slice(i + 1) === small) return true;
  return false;
}

function inferredRelation(a, b) {
  const distance = Math.max(0, Math.max(a.first, b.first) - Math.min(a.last, b.last));
  if (distance > 3 * 60 * 60 * 1000) return false;
  const sameResource = [...a.explicit].some(link => b.observed.has(link)) || [...b.explicit].some(link => a.observed.has(link));
  if (!sameResource) return false;
  const matched = [...a.words].filter(word => [...b.words].some(other => nearlySame(word, other)));
  return matched.length >= 2 && matched.some(word => b.words.has(word));
}

export function summarizeGoals(input, since = null) {
  const seen = new Set();
  let invalid = 0, duplicates = 0;
  const events = [];
  for (const e of input) {
    if (!e || !Number.isFinite(timeOf(e))) { invalid++; continue; }
    if (since && timeOf(e) < since.getTime()) continue;
    const key = canonical(e);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); events.push(e);
  }
  events.sort((a, b) => timeOf(a) - timeOf(b));
  const runs = new Map();
  for (const e of events) {
    if (e.type !== 'run_start' || !isRun(e) || runs.has(e.runId)) continue;
    runs.set(e.runId, { id: e.runId, start: e, events: [], parent: e.runId });
  }
  const orphanIds = new Set();
  for (const e of events) {
    if (!isRun(e)) continue;
    const run = runs.get(e.runId);
    if (run) run.events.push(e);
    else orphanIds.add(e.runId);
  }
  const root = id => {
    const run = runs.get(id);
    if (run.parent !== id) run.parent = root(run.parent);
    return run.parent;
  };
  const join = (a, b) => { const x = root(a), y = root(b); if (x !== y) runs.get(y).parent = x; };
  const revisions = new Map();
  for (const run of runs.values()) {
    const session = run.start.sessionId;
    const ownRevisions = new Set(run.events.filter(e => e.sessionId === session && typeof e.goalRevision === 'string' && e.goalRevision).map(e => e.goalRevision));
    for (const revision of ownRevisions) {
      if (revisions.has(revision)) join(revisions.get(revision), run.id);
      else revisions.set(revision, run.id);
    }
    for (const event of run.events) {
      if (event.type === 'restart_resume' && runs.has(event.data?.originalRunId)) join(event.data.originalRunId, run.id);
    }
  }
  const previous = new Map();
  for (const run of runs.values()) {
    const session = run.start.sessionId;
    if (/^\s*\[接着原任务\]/.test(String(run.start.data?.text ?? '')) && previous.has(session)) join(previous.get(session), run.id);
    if (session) previous.set(session, run.id);
  }
  let groups = new Map();
  for (const run of runs.values()) {
    const key = root(run.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const certainGroups = [...groups.values()];
  const signals = certainGroups.map(group => {
    const all = group.flatMap(run => run.events);
    const user = all.filter(e => e.type === 'run_start' || e.type === 'steer').map(e => String(e.data?.text ?? ''));
    const explicit = new Set(user.flatMap(deepLinks));
    const observed = new Set([...explicit]);
    for (const e of all) {
      if (e.type === 'tool_execution_start') for (const link of deepLinks(e.data?.args)) observed.add(link);
      if (e.type === 'tool_execution_end') for (const link of deepLinks(e.data?.result?.details)) observed.add(link);
    }
    const times = group.map(run => timeOf(run.start));
    return { first: Math.min(...times), last: Math.max(...times), explicit, observed, words: intentWords(user.join('\n')) };
  });
  for (let i = 0; i < certainGroups.length; i++) for (let j = i + 1; j < certainGroups.length; j++) {
    if (inferredRelation(signals[i], signals[j])) join(certainGroups[i][0].id, certainGroups[j][0].id);
  }
  groups = new Map();
  for (const group of certainGroups) {
    const key = root(group[0].id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(group);
  }
  const goals = [...groups.values()].map(parts => {
    const group = parts.flat();
    group.sort((a,b) => timeOf(a.start) - timeOf(b.start));
    const all = group.flatMap(run => run.events).sort((a,b) => timeOf(a) - timeOf(b));
    const models = [...new Set(all.flatMap(modelNames))];
    const active = new Map(); let activeMs = 0, pairs = 0, unpaired = 0;
    const errors = new Map(); let firstTimeouts = 0, unknownErrors = 0;
    for (const e of all) {
      const key = `${e.runId}\0${e.sessionId ?? ''}`;
      if (e.type === 'agent_start') {
        if (active.has(key)) unpaired++;
        active.set(key, timeOf(e));
      } else if (e.type === 'agent_end') {
        if (active.has(key) && timeOf(e) >= active.get(key)) { activeMs += timeOf(e) - active.get(key); pairs++; active.delete(key); }
        else unpaired++;
      }
      if (e.type === 'message_end' && e.data?.message?.role === 'assistant' && /first response timeout/i.test(String(e.data.message.errorMessage ?? ''))) firstTimeouts++;
      if (e.type === 'tool_execution_end' && e.data?.isError === true) {
        const signature = errorSignature(e);
        if (signature) errors.set(signature, (errors.get(signature) ?? 0) + 1);
        else unknownErrors++;
      }
    }
    unpaired += active.size;
    const repeated = [...errors].filter(([,n]) => n > 1).map(([key,n]) => ({ tool: key.split('\0')[0], occurrences: n, repeats: n - 1 }));
    const lastCheck = all.filter(e => e.type === 'goal_check' && typeof e.data?.status === 'string').at(-1)?.data.status;
    const verdict = lastCheck === 'done' ? 'done' : ['continue', 'open', 'needs_user', 'blocked'].includes(lastCheck) ? '未完成' : '无';
    const missingParents = group.filter(r => r.events.some(e => e.type === 'restart_resume' && e.data?.originalRunId && !runs.has(e.data.originalRunId))).length;
    const addition = all.find(e => e.type === 'steer' && typeof e.data?.text === 'string')?.data.text;
    const explicitRuns = Math.max(...parts.map(part => part.length));
    return { first: group[0].start.time, last: group.at(-1).start.time, goal: short(group[0].start.data?.text).replace(/^\[接着原任务\]\s*/, ''), addition: short(addition, 60), explicitRuns,
      runs: group.map(r => r.id), models, activeMs, pairs, unpaired, firstTimeouts, repeated, unknownErrors, verdict, lastCheck: lastCheck ?? null, missingParents };
  }).sort((a,b) => Date.parse(b.last) - Date.parse(a.last));
  return { goals, invalid, duplicates, orphanRunIds: orphanIds.size, eventCount: events.length };
}

export function printGoals(events, since = null) {
  const report = summarizeGoals(events, since);
  console.log(`按目标汇总：${report.goals.length} 项；${report.eventCount} 条有效事件，去重 ${report.duplicates} 条，缺时间/未解析 ${report.invalid} 条；${report.orphanRunIds} 个 run 缺起点。`);
  console.log('累计助手耗时=有起止配对的 agent 运行区间之和，缺失不估算；同目标指纹可能是独立重复任务。');
  console.log('推测关联=3小时内相同具体页面链接且用户目标至少两个词相近；可能是独立任务，须查看原始运行确认。');
  for (const g of report.goals) {
    const when = new Date(g.first).toLocaleString('sv-SE');
    const duration = g.pairs ? `${(g.activeMs / 1000).toFixed(1)}s${g.unpaired ? `+${g.unpaired}段缺记录` : ''}` : '无法判断';
    const repeats = `${g.repeated.length ? g.repeated.map(r => `${r.tool}重复${r.repeats}次`).join('、') : '0次'}${g.unknownErrors ? `，${g.unknownErrors}条错误缺内容` : ''}`;
    const relation = g.explicitRuns < g.runs.length ? `${g.runs.length}段（${g.explicitRuns}段指纹或续做关联、${g.runs.length - g.explicitRuns}段推测关联）` : `${g.runs.length}段`;
    console.log(`${when}  ${g.goal || '（原提问缺失）'}${g.addition ? `；补充：${g.addition}` : ''}  |  ${relation}  |  模型：${g.models.join('、') || '无法判断'}  |  助手：${duration}  |  首响应超时：${g.firstTimeouts}次  |  同错：${repeats}  |  末次核对：${g.verdict}${g.missingParents ? '  |  原片段缺失' : ''}  |  ${g.runs.map(id => id.slice(0,8)).join(',')}`);
  }
  if (!report.goals.length) console.log('这段时间没有带起点的运行。');
}
