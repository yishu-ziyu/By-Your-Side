import json, os, sys, glob, datetime
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC','WenQuanYi Zen Hei','Noto Sans CJK JP','DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False
BASE = "/workspace/bys-trace/runs"

def purpose(c):
    h = (c.get('req') or {}).get('systemHead') or ''
    if h.startswith('You are By Your Side'): return 'main'
    if h.startswith('You check whether'): return 'goal_check'
    if 'calendar date' in h: return 'memory:date'
    if 'changed pages' in h: return 'memory:habit'
    if '阅读助手' in h: return 'explain'
    return 'other:' + h[:30]

def load(run):
    d = os.path.join(BASE, run)
    r = json.load(open(os.path.join(d, 'result.json')))
    t0 = r['t0']
    traces = []
    tp = os.path.join(d, 'traces.jsonl')
    if os.path.exists(tp):
        for l in open(tp):
            if not l.strip(): continue
            j = json.loads(l)
            j['t'] = datetime.datetime.fromisoformat(j['time'].replace('Z', '+00:00')).timestamp() * 1000 - t0
            traces.append(j)
    seen = set(); ev = []
    for e in r['events']:
        k = json.dumps(e, sort_keys=True)
        if k in seen: continue
        seen.add(k); ev.append(e)
    r['events'] = ev
    calls = [c for c in r['calls'] if 'stepfun' in c['url']]
    for c in calls:
        c['purpose'] = purpose(c)
        c['outStart'] = min([x for x in (c.get('firstContent'), c.get('firstTool')) if x is not None], default=None)
    return r, traces, calls

def metrics(run):
    r, tr, calls = load(run)
    m = {'run': run, 'scenario': r['scenario'], 'error': r.get('error')}
    if r['scenario'] == 'explain':
        cs = r.get('cardSamples') or []
        t0 = r['t0']
        m['firstText'] = next((s['at'] - t0 for s in cs if s['len'] > 0), None)
        m['done'] = next((s['at'] - t0 for s in cs if s['len'] > 0 and not s['status']), None)
        m['uiShown'] = None
    else:
        S = r['samples']
        m['firstText'] = next((s['t'] for s in S if s['answerChars'] > 0), None)
        m['uiDoneReal'] = next((s['t'] for s in S if s['t'] > 0 and not s['running'] and s['answerChars'] > 0), None)
        last = [s for s in S if s['runs']]
        m['uiShown'] = last[-1]['runs'][-1]['time'] if last else None
        m['chips'] = last[-1]['chips'] if last else []
        m['thinkingLabels'] = last[-1]['thinking'] if last else []
        # counter vs real: max deviation sampled while running
        dev = []
        for s in S:
            if s['running'] and s['runs']:
                txt = s['runs'][-1]['time']
                import re
                mm = re.match(r'(?:(\d+) 分 )?(\d+) 秒', txt or '')
                if mm: dev.append(s['t']/1000 - (int(mm.group(1) or 0)*60 + int(mm.group(2))))
        m['counterLagMaxS'] = round(max(dev), 1) if dev else None
    pg = r.get('pages') or []
    m['pageOpened'] = pg[1]['t'] if len(pg) > 1 else None
    pre = [x for x in tr if x['type'] == 'pre_observation']
    m['preObsMs'] = pre[0]['data']['ms'] if pre else None
    m['preObsChars'] = pre[0]['data']['chars'] if pre else None
    m['agentEnd'] = next((x['t'] for x in tr if x['type'] == 'agent_end'), None)
    m['toolsTrace'] = [(x['data'].get('toolName'), x['data'].get('elapsedMs')) for x in tr if x['type'] == 'tool_execution_end']
    m['firstResponse'] = [x['data']['elapsedMs'] for x in tr if x['type'] == 'first_response']
    m['calls'] = [{'p': c['purpose'], 'start': c['start'], 'ttfb': (c['firstByte'] - c['start']) if c.get('firstByte') else None,
                   'firstEvt': ((c.get('firstReasoning') or c.get('outStart') or c.get('end')) - c['start']),
                   'reason': ((c['outStart'] or c['end']) - c['firstReasoning']) if c.get('firstReasoning') else 0,
                   'out': (c['end'] - c['outStart']) if c.get('outStart') else 0,
                   'total': c['end'] - c['start'] if c.get('end') else None,
                   'pt': (c.get('usage') or {}).get('prompt_tokens'), 'ct': (c.get('usage') or {}).get('completion_tokens'),
                   'cached': ((c.get('usage') or {}).get('prompt_tokens_details') or {}).get('cached_tokens'),
                   'rc': c['reasoningChars'], 'cc': c['contentChars'], 'tools': c['toolNames'], 'fin': c.get('finish'),
                   'model': (c.get('req') or {}).get('model'), 'eff': (c.get('req') or {}).get('reasoning_effort'),
                   'body': (c.get('req') or {}).get('bodyChars'), 'sys': (c.get('req') or {}).get('systemChars'), 'toolsChars': (c.get('req') or {}).get('toolsChars'),
                   'user': (c.get('req') or {}).get('userChars'), 'toolmsg': (c.get('req') or {}).get('toolMsgChars')} for c in calls]
    dbg = [e for e in r['events'] if e['src'] == 'sw' and e['kind'] in ('attach', 'detach')]
    m['debugger'] = [(e['kind'], e['t']) for e in dbg]
    ax = [e for e in r['events'] if e['src'] == 'sw' and e['kind'] == 'sendCommand' and (e.get('data') or {}).get('method') == 'Accessibility.getFullAXTree']
    m['axTree'] = [(e['t'], e['data']['ms']) for e in ax]
    return m, r, tr, calls

COL = {'ttfb': '#9e9e9e', 'reason': '#f39c12', 'out': '#2e86de', 'tool': '#27ae60', 'pre': '#8e44ad', 'dbg': '#e74c3c'}

def waterfall(run, title):
    m, r, tr, calls = metrics(run)
    lanes = []
    if m['preObsMs']:
        po = next(x for x in tr if x['type'] == 'pre_observation')
        lanes.append(('pre-observation 读页 (AX tree)', [(po['t'] - m['preObsMs'], m['preObsMs'], COL['pre'])]))
    tools = {}
    for x in tr:
        if x['type'] == 'tool_execution_start': tools[x['data']['toolCallId']] = (x['t'], x['data']['toolName'])
        if x['type'] == 'tool_execution_end' and x['data']['toolCallId'] in tools:
            s, n = tools[x['data']['toolCallId']]
            lanes.append((f'tool {n}', [(s, max(x['t'] - s, 80), COL['tool'])]))
    for i, c in enumerate(calls):
        segs = []
        fe = c.get('firstReasoning') or c.get('outStart') or c['end']
        segs.append((c['start'], fe - c['start'], COL['ttfb']))
        if c.get('firstReasoning'):
            segs.append((c['firstReasoning'], (c['outStart'] or c['end']) - c['firstReasoning'], COL['reason']))
        if c.get('outStart'):
            segs.append((c['outStart'], max(c['end'] - c['outStart'], 80), COL['out']))
        u = c.get('usage') or {}
        lanes.append((f"call{i} {c['purpose']} ({u.get('prompt_tokens','?')}→{u.get('completion_tokens','?')} tok)", segs))
    # sort lanes by start
    def st(l): return l[1][0][0]
    lanes.sort(key=st)
    dbg = m['debugger']
    spans = []; a = None
    for k, t in dbg:
        if k == 'attach' and a is None: a = t
        if k == 'detach' and a is not None: spans.append((a, t - a)); a = None
    if a is not None: spans.append((a, (max(c['end'] for c in calls) if calls else a) - a))
    lanes.insert(0, ('chrome.debugger attached 调试器挂着', [(s, d, COL['dbg']) for s, d in spans]))
    fig, ax = plt.subplots(figsize=(14, max(3.6, 0.55 * len(lanes) + 2.0)))
    for y, l in enumerate(lanes):
        for s, d, col in l[1]:
            ax.barh(y, d / 1000, left=s / 1000, color=col, height=0.6)
    ax.set_yticks(range(len(lanes))); ax.set_yticklabels([l[0] for l in lanes], fontsize=8)
    ax.invert_yaxis()
    marks = [('send/click 发送', 0, 'k')]
    if m.get('firstText') is not None: marks.append((f"first text 首字 {m['firstText']/1000:.1f}s", m['firstText'], '#2e86de'))
    if m.get('pageOpened') is not None and r['scenario'] == 'action': marks.append((f"page opened 页面打开 {m['pageOpened']/1000:.1f}s", m['pageOpened'], '#27ae60'))
    if m.get('uiDoneReal') is not None: marks.append((f"UI idle 面板结束 {m['uiDoneReal']/1000:.1f}s (UI shows {m['uiShown']})", m['uiDoneReal'], 'purple'))
    from matplotlib.lines import Line2D
    mh = []
    for j, (lab, t, col) in enumerate(marks):
        ax.axvline(t / 1000, color=col, ls='--', lw=1.2)
        mh.append(Line2D([0], [0], color=col, ls='--', label=lab))
    ax.set_xlabel('seconds since send 发送后秒数')
    ax.set_title(title, fontsize=10)
    ax.legend(handles=[Patch(color=COL['ttfb'], label='wait first byte/event 等首包'), Patch(color=COL['reason'], label='reasoning 思考'),
                       Patch(color=COL['out'], label='output 输出(正文/工具参数)'), Patch(color=COL['tool'], label='tool 工具执行'),
                       Patch(color=COL['pre'], label='pre-observation 读页'), Patch(color=COL['dbg'], label='debugger attached')] + mh, loc='upper left', bbox_to_anchor=(1.01, 1), fontsize=7.5)
    ax.grid(axis='x', alpha=.3)
    fig.tight_layout()
    out = f"/workspace/bys-trace/{run}.png"
    fig.savefig(out, dpi=110); plt.close(fig)
    return out

if __name__ == '__main__':
    runs = sys.argv[1:] or sorted(os.listdir(BASE))
    allm = []
    for run in runs:
        try:
            m, *_ = metrics(run)
        except Exception as e:
            print(run, 'ERR', e); continue
        allm.append(m)
        print(json.dumps(m, ensure_ascii=False))
    json.dump(allm, open('/workspace/bys-trace/metrics.json', 'w'), ensure_ascii=False, indent=1)
