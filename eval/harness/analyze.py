#!/usr/bin/env python3
"""Aggregate a run: judge verdicts + trace usage -> report.json, report_models.csv, report_per_task.csv.
Groups by whatever model specs the run used (main[+fast], provider/modelId); nothing is hardcoded per provider.
usage: analyze.py <runDir>

Cost: tokens come from assistant `message_end` usage in each job's exported trace (main-model calls only;
`side_call` lines carry no usage, so fast-model judgments are counted, not tokenized).
- If a price table exists (env BYS_PRICES, else eval/harness/prices.json), cost_usd = tokens x that table,
  keyed "provider/modelId" -> {"input","output","cacheRead","cacheWrite"} USD per 1M tokens.
- Otherwise cost_usd is null and only tokens are reported. The trace's own usage.cost (pi-ai catalog API list
  price) is reported separately as catalog_list_usd; it is not what a Token Plan subscription is billed.
"""
import json, glob, os, re, sys, statistics, collections, csv
from datetime import datetime, timezone

RUN = os.path.abspath(sys.argv[1])
HERE = os.path.dirname(os.path.abspath(__file__))
TASKS = {json.loads(l)['id']: json.loads(l) for l in open(os.environ.get('BYS_TASKS') or os.path.join(HERE, '..', 'tasks', 'tasks.jsonl')) if l.strip()}
PRICE_FILE = os.environ.get('BYS_PRICES') or os.path.join(HERE, 'prices.json')
PRICE = json.load(open(PRICE_FILE)) if os.path.exists(PRICE_FILE) else None

def usage_cost(trace_path):
    tok = collections.Counter(); cost = 0.0; priced = PRICE is not None; catalog = 0.0; calls = 0
    kinds = collections.Counter(); side = collections.Counter()
    for l in open(trace_path):
        if not l.strip(): continue
        e = json.loads(l); kinds[e['type']] += 1
        if e['type'] == 'side_call': side[f"{e['data'].get('purpose')}@{e['data'].get('model')}"] += 1
        if e['type'] != 'message_end': continue
        m = e['data'].get('message', {})
        if m.get('role') != 'assistant' or not m.get('usage'): continue
        u = m['usage']; calls += 1
        for k in ('input', 'output', 'cacheRead', 'cacheWrite'): tok[k] += u.get(k, 0) or 0
        catalog += (u.get('cost') or {}).get('total', 0) or 0
        p = (PRICE or {}).get(f"{m.get('provider')}/{m.get('model')}")
        if p: cost += sum((u.get(k, 0) or 0) * p.get(k, 0) for k in ('input', 'output', 'cacheRead', 'cacheWrite')) / 1e6
        else: priced = False
    return dict(tokens=dict(tok), cost_usd=(cost if priced and calls else None), catalog_list_usd=catalog, model_calls=calls,
                n_model_request=kinds['model_request'], n_side_call=kinds['side_call'], n_effort_change=kinds['effort_change'], side_calls=dict(side))

def pct(xs, q):
    xs = sorted(x for x in xs if x is not None)
    if not xs: return None
    k = (len(xs) - 1) * q; f = int(k); c = min(f + 1, len(xs) - 1)
    return round(xs[f] + (xs[c] - xs[f]) * (k - f), 1)

rows = {}  # (model, task) -> row
for jf in sorted(glob.glob(f'{RUN}/*/BYS-*.json')):
    slug = os.path.basename(os.path.dirname(jf))
    if slug == 'judge' or slug.startswith('_') or not re.search(r'/BYS-\d+\.json$', jf): continue
    tr = json.load(open(jf))
    if tr.get('status') == 'setup_error' or any('额度用完' in e for e in tr.get('errors', [])): continue
    jpath = f'{RUN}/judge/{slug}/{tr["id"]}.json'
    if not os.path.exists(jpath): continue
    j = json.load(open(jpath))
    tp = jf[:-5] + '.trace.jsonl'
    uc = usage_cost(tp) if os.path.exists(tp) else usage_cost(os.devnull)
    rows[(tr['model'], tr['id'])] = dict(model=tr['model'], main_model=tr.get('main_model'), fast_model=tr.get('fast_model'), task=tr['id'], category=TASKS[tr['id']]['category'],
        pass_=j.get('pass') is True, verdict=j.get('verdict'), reason=j.get('reason', ''), judge_method=j.get('method'), environment_evidence=j.get('environment'), status=tr['status'],
        total=tr.get('seconds_total'), first=tr.get('seconds_to_first_output'), n_steps=tr.get('n_steps'), **uc)

models = sorted({m for (m, _) in rows})
common = sorted(t for t in TASKS if models and all((m, t) in rows and rows[(m, t)]['verdict'] in ('pass', 'fail', 'undeterminable') for m in models))
NO_SETUP = sorted(t for t in TASKS if TASKS[t].get('setup'))
cats = sorted({TASKS[t]['category'] for t in TASKS})
# 能力档位（docs/ROADMAP.md 第 11 条）：按档报通过率与目标差距。
TIERS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tasks', 'tiers.json')))['tiers']

def tier_summary(rs):
    out = {}
    for t, spec in TIERS.items():
        tj = [r for r in rs if r['category'] in spec['categories'] and r['verdict'] in ('pass', 'fail', 'undeterminable')]
        environment = sum(r['verdict'] == 'environment' for r in rs if r['category'] in spec['categories'])
        if tj or environment:
            rate = round(sum(r['pass_'] for r in tj) / len(tj), 3) if tj else None
            out[t] = dict(name=spec['name'], environment=sum(r['verdict'] == 'environment' for r in rs if r['category'] in spec['categories']), n_judged=len(tj), pass_rate=rate, target=spec['target'], gap=(round(rate - spec['target'], 3) if spec['target'] and rate is not None else None))
    return out

def summarize(m, ids):
    rs = [rows[(m, t)] for t in ids if (m, t) in rows]
    if not rs: return None
    n = len(rs); p = sum(r['pass_'] for r in rs)
    judged = [r for r in rs if r['verdict'] in ('pass', 'fail', 'undeterminable')]
    costs = [r['cost_usd'] for r in rs]; cost = sum(costs) if all(c is not None for c in costs) else None
    by_cat = {}
    for c in cats:
        cr = [r for r in rs if r['category'] == c]
        cj = [r for r in cr if r['verdict'] in ('pass', 'fail', 'undeterminable')]
        if cr: by_cat[c] = dict(n=len(cr), n_judged=len(cj), passed=sum(r['pass_'] for r in cr), pass_rate=(round(sum(r['pass_'] for r in cj) / len(cj), 3) if cj else None))
    mean = lambda k: round(statistics.mean(r['tokens'].get(k, 0) for r in rs), 1)
    return dict(environment=sum(r['verdict'] == 'environment' for r in rs), model=m, main_model=rs[0]['main_model'], fast_model=rs[0]['fast_model'], n=n, n_judged=len(judged), passed=p,
        pass_rate=(round(p / len(judged), 3) if judged else None),
        undeterminable=sum(r['verdict'] == 'undeterminable' for r in rs), judge_errors=sum(r['verdict'] == 'judge_error' for r in rs),
        median_total_s=pct([r['total'] for r in rs], .5), p90_total_s=pct([r['total'] for r in rs], .9), median_first_output_s=pct([r['first'] for r in rs], .5),
        mean_tokens_input=mean('input'), mean_tokens_output=mean('output'), mean_tokens_cached=mean('cacheRead'), mean_tokens_cache_write=mean('cacheWrite'),
        mean_tokens_total=round(statistics.mean(sum(r['tokens'].get(k, 0) for k in ('input', 'output', 'cacheRead', 'cacheWrite')) for r in rs), 1),
        mean_model_calls=round(statistics.mean(r['model_calls'] for r in rs), 2), mean_side_calls=round(statistics.mean(r['n_side_call'] for r in rs), 2),
        effort_changes=sum(r['n_effort_change'] for r in rs),
        mean_cost_usd=(round(cost / n, 6) if cost is not None else None), total_cost_usd=(round(cost, 5) if cost is not None else None),
        cost_per_pass_usd=(round(cost / p, 6) if cost is not None and p else None),
        catalog_list_total_usd=round(sum(r['catalog_list_usd'] for r in rs), 6),
        timeouts=sum(r['status'] == 'timeout' for r in rs), by_category=by_cat, by_tier=tier_summary(rs))

report = dict(run=os.path.basename(RUN), generated_at=datetime.now(timezone.utc).isoformat(),
    notes=['Only valid results (no quota errors, no harness setup_error) that have a judge file are counted. environment verdicts are listed separately and excluded; pass_rate = passed / n_judged (verdict pass|fail|undeterminable; undeterminable counts as not passed). judge_error rows are listed but excluded from pass_rate (the judge did not run); pass_rate is null when nothing was judged.',
           'head_to_head = task ids where every model spec in this run has a valid judged result; all_valid = every valid result per model spec.',
           'A model spec is main[+fast]; fast defaults to main.',
           'Tokens = assistant message_end usage in the exported extension trace (main-model calls). side_call lines (fast-model judgments) carry no usage and are only counted.',
           ('Cost from price table ' + PRICE_FILE) if PRICE else 'No price table (BYS_PRICES / harness/prices.json): cost_usd is null, compare tokens. Token Plans are subscriptions; per-token cost is not their bill.',
           'catalog_list_total_usd = sum of the trace usage.cost fields (pi-ai catalog API list price). Models missing from the catalog inherit the template model price, so treat it as indicative only.',
           'HARNESS LIMITATION: task `setup` steps (text selection + Ctrl+J, extra tabs, memory preconditions) are NOT performed by the harness; results for setup_not_applied_task_ids are not faithful.'],
    models=models, head_to_head_task_ids=common, setup_not_applied_task_ids=NO_SETUP,
    head_to_head={m: summarize(m, common) for m in models},
    all_valid={m: summarize(m, sorted(t for (mm, t) in rows if mm == m)) for m in models})

dis = []
for t in common:
    res = {m: rows[(m, t)]['pass_'] for m in models}
    if len(set(res.values())) > 1:
        dis.append(dict(task=t, category=TASKS[t]['category'], passed=[m for m in models if res[m]], failed=[m for m in models if not res[m]],
                        reasons={m: rows[(m, t)]['reason'][:200] for m in models}))
report['disagreements'] = dis
report['failures'] = {m: [dict(task=t, category=rows[(m, t)]['category'], status=rows[(m, t)]['status'], verdict=rows[(m, t)]['verdict'], reason=rows[(m, t)]['reason'][:200])
                          for t in sorted(t for (mm, t) in rows if mm == m) if not rows[(m, t)]['pass_'] and rows[(m, t)]['verdict'] != 'environment'] for m in models}
report['per_task'] = [dict(model=r['model'], task=r['task'], category=r['category'], pass_=r['pass_'], verdict=r['verdict'], status=r['status'], total_s=r['total'], first_s=r['first'],
                           n_steps=r['n_steps'], model_calls=r['model_calls'], side_calls=r['side_calls'], n_model_request=r['n_model_request'], n_effort_change=r['n_effort_change'],
                           tokens=r['tokens'], cost_usd=(round(r['cost_usd'], 6) if r['cost_usd'] is not None else None), catalog_list_usd=round(r['catalog_list_usd'], 6), environment=r['environment_evidence'], reason=r['reason'][:200])
                      for r in sorted(rows.values(), key=lambda r: (r['task'], r['model']))]
if os.path.exists(f'{RUN}/_failure_clusters.json'): report['top_failure_reasons'] = json.load(open(f'{RUN}/_failure_clusters.json'))
json.dump(report, open(f'{RUN}/report.json', 'w'), ensure_ascii=False, indent=2)

keys = ['n', 'environment', 'n_judged', 'passed', 'pass_rate', 'undeterminable', 'judge_errors', 'median_total_s', 'p90_total_s', 'median_first_output_s', 'mean_tokens_input', 'mean_tokens_output', 'mean_tokens_cached',
        'mean_tokens_total', 'mean_model_calls', 'mean_side_calls', 'mean_cost_usd', 'cost_per_pass_usd', 'total_cost_usd', 'catalog_list_total_usd', 'timeouts']
with open(f'{RUN}/report_models.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['set', 'model'] + keys + [f'pass_rate:{c}' for c in cats])
    for sname in ('head_to_head', 'all_valid'):
        for m, s in report[sname].items():
            if s: w.writerow([sname, m] + [s[k] for k in keys] + [s['by_category'].get(c, {}).get('pass_rate', '') for c in cats])
with open(f'{RUN}/report_per_task.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['task', 'model', 'category', 'pass', 'verdict', 'status', 'seconds_total', 'seconds_to_first_output', 'n_steps', 'model_calls', 'side_calls', 'tok_in', 'tok_out', 'tok_cached', 'cost_usd', 'catalog_list_usd', 'reason'])
    for r in report['per_task']:
        w.writerow([r['task'], r['model'], r['category'], r['pass_'], r['verdict'], r['status'], r['total_s'], r['first_s'], r['n_steps'], r['model_calls'], sum(r['side_calls'].values()),
                    r['tokens'].get('input', 0), r['tokens'].get('output', 0), r['tokens'].get('cacheRead', 0), r['cost_usd'], r['catalog_list_usd'], r['reason']])
print(json.dumps({m: (s and {kk: s[kk] for kk in keys}) for m, s in report['head_to_head'].items()}, indent=1))
print('models', len(models), 'common', len(common), 'disagreements', len(dis))
