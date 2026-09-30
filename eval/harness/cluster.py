#!/usr/bin/env python3
"""Cluster judged failures per model with codex -> <run>/_failure_clusters.json. Usage: cluster.py <runDir> [scope-key]"""
import json, sys, subprocess, tempfile, os, re
RUN = sys.argv[1]; r = json.load(open(f'{RUN}/report.json'))
fails = r['failures']
lines = []
for m, fs in fails.items():
    for f in fs: lines.append(f"{m}\t{f['task']}\t{f['category']}\t{f['status']}\t{f['reason'][:300]}")
prompt = ("下面是浏览器 agent 评测中每个模型失败任务的列表（model\\ttask\\tcategory\\tstatus\\treason）。"
 "请把失败原因归纳成 4-7 个跨模型通用的简短中文类别（每个 ≤10 字），然后为每个模型给出各类别的计数和任务列表。"
 "每个失败必须且只能归入一个类别。只输出 JSON：{\"clusters\": {\"<model>\": [{\"cluster\": str, \"count\": int, \"tasks\": [str]}]}}，每个模型按 count 降序。\n\n" + "\n".join(lines))
with tempfile.TemporaryDirectory() as d:
    out = f'{d}/out.txt'
    subprocess.run(["codex", "exec", "--skip-git-repo-check", "-s", "read-only", "--output-last-message", out, "-"], input=prompt, text=True, cwd=d, timeout=900, capture_output=True)
    text = open(out).read()
j = json.loads(re.search(r'\{[\s\S]*\}', text).group(0))
# sanity: counts match task lists, every failure covered
for m, cl in j['clusters'].items():
    for c in cl: c['count'] = len(c['tasks'])
    got = sorted(t for c in cl for t in c['tasks']); want = sorted(f['task'] for f in fails.get(m, []))
    if got != want: print('WARN coverage mismatch', m, set(want) ^ set(got))
json.dump({"scope": "all failures listed in report.json['failures'] (all valid judged results per model)", "clusters": j['clusters']}, open(f'{RUN}/_failure_clusters.json', 'w'), ensure_ascii=False, indent=1)
print('ok', {m: len(v) for m, v in j['clusters'].items()})
