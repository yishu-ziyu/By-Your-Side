#!/usr/bin/env python3
"""Aggregate a run: judge verdicts + trace usage -> report.json, report_models.csv, report_categories.csv.
usage: analyze.py <runDir>"""
import json, glob, os, sys, statistics, collections, csv
from datetime import datetime, timezone

RUN = os.path.abspath(sys.argv[1])
TASKS = {json.loads(l)['id']: json.loads(l) for l in open(os.environ.get('BYS_TASKS') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tasks', 'tasks.jsonl')) if l.strip()}
PAID = ['opencode-go/mimo-v2.6-flash', 'opencode-go/deepseek-v4-flash', 'opencode-go/deepseek-v4.1-flash']
FREE = ['opencode-go/space-bunny-free']
VARIANTS = ['opencode-go-nothink/mimo-v2.6-flash:off']  # MiMo with thinking disabled (body thinking.type=disabled)
# USD per 1M tokens (OpenCode Go). DeepSeek doubles at peak (weekday 01-04 & 06-10 UTC). cacheWrite not priced -> 0.
PRICE = {
  'mimo-v2.6-flash': dict(input=0.14, output=0.28, cacheRead=0.0028, peak=False),
  'deepseek-v4-flash': dict(input=0.15, output=0.60, cacheRead=0.003, peak=True),
  'deepseek-v4.1-flash': dict(input=0.15, output=0.60, cacheRead=0.003, peak=True),
  'space-bunny-free': dict(input=0, output=0, cacheRead=0, peak=False),
}
POOL = {'mimo-v2.6-flash:off': 60, 'mimo-v2.6-flash': 60, 'deepseek-v4-flash': 30, 'deepseek-v4.1-flash': 60, 'space-bunny-free': None}

def is_peak(ts):
    d = datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(timezone.utc)
    return d.weekday() < 5 and (1 <= d.hour < 4 or 6 <= d.hour < 10)

def usage_cost(trace_path):
    tok = collections.Counter(); cost = 0.0; trace_cost = 0.0; calls = 0; peak_calls = 0
    for l in open(trace_path):
        if not l.strip(): continue
        e = json.loads(l)
        if e['type'] != 'message_end': continue
        m = e['data'].get('message', {})
        if m.get('role') != 'assistant' or not m.get('usage'): continue
        u = m['usage']; p = PRICE[m.get('model')]
        mult = 2 if (p['peak'] and is_peak(e['time'])) else 1
        peak_calls += mult == 2; calls += 1
        for k in ('input', 'output', 'cacheRead', 'cacheWrite'): tok[k] += u.get(k, 0) or 0
        cost += mult * ((u.get('input', 0) or 0) * p['input'] + (u.get('output', 0) or 0) * p['output'] + (u.get('cacheRead', 0) or 0) * p['cacheRead']) / 1e6
        trace_cost += (u.get('cost') or {}).get('total', 0) or 0
    return dict(tokens=dict(tok), cost_usd=cost, trace_cost_field_usd=trace_cost, model_calls=calls, peak_calls=peak_calls)

def pct(xs, q):
    xs = sorted(x for x in xs if x is not None)
    if not xs: return None
    k = (len(xs) - 1) * q; f = int(k); c = min(f + 1, len(xs) - 1)
    return round(xs[f] + (xs[c] - xs[f]) * (k - f), 1)

rows = {}  # (model, task) -> row
for jf in [p for p in glob.glob(f'{RUN}/opencode-go*_*/BYS-*.json') if __import__('re').search(r'/BYS-\d+\.json$', p)]:
    tr = json.load(open(jf)); slug = os.path.basename(os.path.dirname(jf))
    if tr.get('status') == 'setup_error' or any('额度用完' in e for e in tr.get('errors', [])): continue
    jpath = f'{RUN}/judge/{slug}/{tr["id"]}.json'
    if not os.path.exists(jpath): continue
    j = json.load(open(jpath))
    tp = jf[:-5] + '.trace.jsonl'
    uc = usage_cost(tp) if os.path.exists(tp) else dict(tokens={}, cost_usd=0, trace_cost_field_usd=0, model_calls=0, peak_calls=0)
    rows[(tr['model'], tr['id'])] = dict(model=tr['model'], task=tr['id'], category=TASKS[tr['id']]['category'], pass_=bool(j['pass']), reason=j['reason'],
        judge_method=j.get('method'), status=tr['status'], total=tr.get('seconds_total'), first=tr.get('seconds_to_first_output'), n_steps=tr.get('n_steps'), **uc)

models = [m for m in PAID + FREE + VARIANTS if any(k[0] == m for k in rows)]
common = sorted(t for t in TASKS if all((m, t) in rows for m in PAID))
four = sorted(t for t in common if all((m, t) in rows for m in FREE))
nothink_common = sorted(t for t in common if all((m, t) in rows for m in VARIANTS))
NO_SETUP = sorted(t for t in TASKS if TASKS[t].get('setup'))
cats = sorted({TASKS[t]['category'] for t in TASKS})

def summarize(m, ids):
    rs = [rows[(m, t)] for t in ids if (m, t) in rows]
    if not rs: return None
    n = len(rs); p = sum(r['pass_'] for r in rs); short = m.split('/')[-1]
    cost = sum(r['cost_usd'] for r in rs)
    by_cat = {}
    for c in cats:
        cr = [r for r in rs if r['category'] == c]
        if cr: by_cat[c] = dict(n=len(cr), passed=sum(r['pass_'] for r in cr), pass_rate=round(sum(r['pass_'] for r in cr) / len(cr), 3))
    mean = lambda k: round(statistics.mean(r['tokens'].get(k, 0) for r in rs), 1)
    return dict(model=m, n=n, passed=p, pass_rate=round(p / n, 3),
        median_total_s=pct([r['total'] for r in rs], .5), p90_total_s=pct([r['total'] for r in rs], .9), median_first_output_s=pct([r['first'] for r in rs], .5),
        mean_tokens_input=mean('input'), mean_tokens_output=mean('output'), mean_tokens_cached=mean('cacheRead'), mean_tokens_cache_write=mean('cacheWrite'),
        mean_model_calls=round(statistics.mean(r['model_calls'] for r in rs), 2),
        mean_cost_usd=round(cost / n, 6), total_cost_usd=round(cost, 5), cost_per_pass_usd=round(cost / p, 6) if p else None,
        trace_cost_field_total_usd=round(sum(r['trace_cost_field_usd'] for r in rs), 6), peak_calls=sum(r['peak_calls'] for r in rs),
        go_monthly_pool_usd=POOL[short], tasks_per_pool=(round(POOL[short] / (cost / n)) if POOL[short] and cost else None),
        passes_per_pool=(round(POOL[short] / (cost / p)) if POOL[short] and cost and p else None),
        timeouts=sum(r['status'] == 'timeout' for r in rs), by_category=by_cat)

report = dict(run=os.path.basename(RUN), generated_at=datetime.now(timezone.utc).isoformat(),
    notes=['Only valid results (no quota errors, no harness setup_error) that have a judge verdict are counted.',
           'head_to_head = task ids where all 3 paid models have a valid result; all_valid = every valid result per model.',
           'Cost = sum over assistant message_end usage in the companion trace (input/output/cacheRead; cacheWrite unpriced). Model calls outside the traced agent session (if any) are not counted.',
           'Trace usage.cost fields are present but always 0 (models.json has no cost entries), so they cannot be compared numerically; see trace_cost_field_total_usd.',
           'Peak pricing: DeepSeek x2 on weekdays 01-04 & 06-10 UTC per call timestamp; see peak_calls.',
           'HARNESS LIMITATION: task `setup` steps (text selection + Ctrl+J, extra tabs, memory preconditions) are NOT performed by the harness; results for setup_not_applied_task_ids are not faithful.',
           'Go $10 plan pools: deepseek-v4-flash $30/month, others $60; space-bunny-free is free until 10/05 (cost 0).'],
    head_to_head_task_ids=common, four_way_task_ids=four,
    setup_not_applied_task_ids=NO_SETUP,
    four_way={m: summarize(m, four) for m in models},
    nothink_vs_mimo_task_ids=nothink_common,
    nothink_vs_mimo={m: summarize(m, nothink_common) for m in ['opencode-go/mimo-v2.6-flash'] + VARIANTS if nothink_common},
    head_to_head={m: summarize(m, common) for m in models},
    all_valid={m: summarize(m, sorted(t for (mm, t) in rows if mm == m)) for m in models})

# disagreements on the head-to-head set (plus free model if it has the task)
dis = []
for t in common:
    ms = [m for m in models if (m, t) in rows]
    res = {m: rows[(m, t)]['pass_'] for m in ms}
    if len(set(res.values())) > 1:
        dis.append(dict(task=t, category=TASKS[t]['category'], passed=[m.split('/')[-1] for m in ms if res[m]], failed=[m.split('/')[-1] for m in ms if not res[m]],
                        reasons={m.split('/')[-1]: rows[(m, t)]['reason'][:200] for m in ms}))
report['disagreements'] = dis
report['failures'] = {m: [dict(task=t, category=rows[(m, t)]['category'], status=rows[(m, t)]['status'], reason=rows[(m, t)]['reason'][:200])
                          for t in sorted(t for (mm, t) in rows if mm == m) if not rows[(m, t)]['pass_']] for m in models}
report['per_task'] = [dict(model=r['model'], task=r['task'], category=r['category'], pass_=r['pass_'], total_s=r['total'], first_s=r['first'], n_steps=r['n_steps'],
                           model_calls=r['model_calls'], tokens=r['tokens'], cost_usd=round(r['cost_usd'], 6), trace_cost_field_usd=r['trace_cost_field_usd'], reason=r['reason'][:200])
                      for r in sorted(rows.values(), key=lambda r: (r['task'], r['model']))]
if os.path.exists(f'{RUN}/_failure_clusters.json'): report['top_failure_reasons'] = json.load(open(f'{RUN}/_failure_clusters.json'))
json.dump(report, open(f'{RUN}/report.json', 'w'), ensure_ascii=False, indent=2)

keys = ['n', 'passed', 'pass_rate', 'median_total_s', 'p90_total_s', 'median_first_output_s', 'mean_tokens_input', 'mean_tokens_output', 'mean_tokens_cached',
        'mean_cost_usd', 'cost_per_pass_usd', 'total_cost_usd', 'tasks_per_pool', 'passes_per_pool', 'timeouts']
with open(f'{RUN}/report_models.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['set', 'model'] + keys + [f'pass_rate:{c}' for c in cats])
    for sname in ('head_to_head', 'four_way', 'nothink_vs_mimo', 'all_valid'):
        for m, s in report[sname].items():
            if s: w.writerow([sname, m] + [s[k] for k in keys] + [s['by_category'].get(c, {}).get('pass_rate', '') for c in cats])
with open(f'{RUN}/report_per_task.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['task', 'model', 'category', 'pass', 'seconds_total', 'seconds_to_first_output', 'n_steps', 'model_calls', 'tok_in', 'tok_out', 'tok_cached', 'cost_usd', 'reason'])
    for r in report['per_task']:
        w.writerow([r['task'], r['model'], r['category'], r['pass_'], r['total_s'], r['first_s'], r['n_steps'], r['model_calls'], r['tokens'].get('input', 0), r['tokens'].get('output', 0), r['tokens'].get('cacheRead', 0), r['cost_usd'], r['reason']])
print(json.dumps({k: {m: (s and {kk: s[kk] for kk in keys}) for m, s in report[k].items()} for k in ('head_to_head', 'four_way')}, indent=1))
print('common', len(common), 'four', len(four), 'disagreements', len(dis))
