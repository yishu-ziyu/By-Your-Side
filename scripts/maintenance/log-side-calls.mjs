const timeOf = event => Date.parse(event.time ?? '');
const percentile = (values, share) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))];
const seconds = ms => (ms / 1000).toFixed(1);

function waitWindows(events) {
  const runs = new Map();
  for (const event of events) {
    if (!event.runId) continue;
    const run = runs.get(event.runId) ?? {};
    if (event.type === 'run_start') run.start ??= timeOf(event);
    if (event.type === 'first_response') run.first ??= timeOf(event);
    if (event.type === 'agent_end') run.end = timeOf(event);
    if (event.type === 'agent_settled') run.settled = timeOf(event);
    runs.set(event.runId, run);
  }
  return runs;
}

const overlap = (from, to, start, end) => start === undefined || end === undefined ? 0 : Math.max(0, Math.min(to, end) - Math.max(from, start));

export function printSideCalls(events) {
  const runs = waitWindows(events);
  const groups = new Map();
  for (const event of events) {
    if (event.type !== 'side_call' || !event.data?.purpose) continue;
    const group = groups.get(event.data.purpose) ?? { count: 0, failed: 0, ms: [], first: 0, delivery: 0, outside: 0 };
    group.count += 1;
    if (event.data.outcome === 'failed') group.failed += 1;
    if (typeof event.data.ms === 'number') {
      group.ms.push(event.data.ms);
      const to = timeOf(event), from = to - event.data.ms, run = runs.get(event.runId);
      if (run) {
        group.first += overlap(from, to, run.start, run.first);
        group.delivery += overlap(from, to, run.end, run.settled);
      } else group.outside += event.data.ms;
    }
    groups.set(event.data.purpose, group);
  }
  if (!groups.size) { console.log('这段时间没有辅助模型调用。'); return; }
  const total = group => group.ms.reduce((sum, ms) => sum + ms, 0);
  console.table([...groups].sort(([, a], [, b]) => total(b) - total(a)).map(([purpose, group]) => ({
    用途: purpose,
    次数: group.count,
    失败: group.failed,
    有耗时: group.ms.length,
    P50秒: group.ms.length ? seconds(percentile(group.ms, 0.5)) : '-',
    P95秒: group.ms.length ? seconds(percentile(group.ms, 0.95)) : '-',
    总秒: seconds(total(group)),
    等首句时重叠秒: seconds(group.first),
    等交付时重叠秒: seconds(group.delivery),
    不属于任务秒: seconds(group.outside),
  })));
  console.log('重叠只说明调用发生在用户等待期内，不等于它拖慢了这段等待。');
}
