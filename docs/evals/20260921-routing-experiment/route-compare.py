#!/usr/bin/env python3
"""Offline routing comparison on real usage records. No browser, no voice service, no task model.

Inputs (read-only): ~/.sideagent/voice-capture/*.jsonl, ~/.sideagent/agent.log, ~/.sideagent/task-receipts/*.json
Model: Jev (TypeSafe System One) via the same endpoint/format as agent/src/goal-evidence-judge.ts.
Outputs: voice-utterances.json, task-requests.json, jev-latency.json in this directory.
"""
import glob, json, os, re, sys, time, urllib.request, urllib.error
from collections import Counter, defaultdict

HOME = os.path.expanduser('~/.sideagent')
OUT = os.path.dirname(os.path.abspath(__file__))
MODEL = 'jev-1.13.0'
BATCH = 10

LANES = {
    'chat': 'Greeting, acknowledgement, emotion or commentary that asks for nothing to be done or looked up',
    'answer': 'A general knowledge or opinion question answerable without the browser or the current page',
    'page_question': 'Asks what is on the current page or whether the assistant can see it; answerable by reading the current page text without changing the page',
    'task': 'Asks the assistant to act in the browser or produce a result on the page: open, switch, close, refresh, click, search, translate the page, mark or highlight on the page, copy into another site, take a screenshot, list or count tabs',
    'steer': 'Corrects, narrows or adds a constraint to something the assistant is already doing or just did wrong, including "not like that, do it this way"',
    'control': 'Pause, resume, cancel or drop the current task, or stop speaking',
    'status': 'Asks how the running task is going or asks for a progress report',
    'incomplete': 'A fragment or cut-off phrase that does not yet state a complete request',
}

# Hand labels by the reviewing agent (Claude), 2026-09-21. `alt` marks a defensible second reading.
VOICE_LABELS = {
    '嗨，你好，能看到我当前的界面吗？': ('page_question', None),
    '具体的界面不需要看回执啊，就目当前所在的界面。': ('page_question', 'steer'),
    '你可以截个图看一下在哪。': ('task', None),
    '然后一直同时帮我把标签页切到那个，': ('incomplete', 'task'),
    '那就暂时不管这个任务了，我需要。': ('control', None),
    '切到那个open code。': ('task', None),
    '当前对你现在其实是对的。': ('chat', None),
    '这个，go的这个界面，它的消耗量，go，': ('incomplete', None),
    '汇报一下。': ('status', 'page_question'),
    '去购套餐。': ('task', None),
    '嗯，你可以现在在这个画面上圈出五小时用量。': ('task', None),
    '引导的我去购买那个。': ('task', 'incomplete'),
    'CEN套餐。': ('incomplete', None),
    '引导我去购买我': ('task', 'incomplete'),
    '嗨，你好吗？': ('chat', None),
    '刷新一下当前的页面。': ('task', None),
    '把五小时容量圈出来。': ('task', None),
    '目前消耗了多少呀？': ('page_question', None),
    '我实际上它是按照金额来算，它并不是按照时间来算。': ('chat', 'steer'),
    '可以的，你如果你要，你可以点开这个呃。': ('incomplete', None),
    '显示详情就可以看到了。': ('steer', 'task'),
    '查open code购套餐的额度。': ('task', None),
    '是go套餐g o go套餐。': ('steer', None),
    '按照你的推荐顺序往下。': ('steer', None),
    '推进就行。': ('steer', 'control'),
    '嗨，你好。': ('chat', None),
    '帮我把当前的这个标签页。': ('incomplete', None),
    '我的那个boss直拼那一块。': ('incomplete', None),
    '我想把我现在的当前的这个页面切到那个标签页里去。': ('task', None),
    '让位是你把它切过去，就是。': ('incomplete', 'steer'),
    '它已经在那里已经有了呀，就是不需要把当前的页面给它改成这个，只是你把它调过去就行。': ('steer', None),
    '不是chrome的扩展管理页了。': ('steer', None),
    '嗨，你好呀。': ('chat', None),
    '呃，可以看到我当前这个页面吗？': ('page_question', None),
    '嗯，有看到吗？': ('page_question', None),
    '读到了什么呢？': ('page_question', None),
    '嗨，晚上好。': ('chat', None),
    '帮我把这个标签也贴到 B 站那一': ('task', 'incomplete'),
    '不是说把标签页切到 B 站那一个，不是表情。': ('steer', None),
    '你他妈瞎呀！': ('chat', None),
    '打开哔哩哔哩。': ('task', None),
    '打开第一行第四个视频': ('task', None),
    '呃，移动到第 15 分钟': ('task', 'steer'),
    '它确实打开了，我需要移动到 15 分钟啊': ('steer', None),
    '然后我将第一条评论复制下来之后，粘贴到我的浮墨笔记里。': ('task', None),
    '但是不要点击提交': ('steer', None),
    '我的这个浏览器当中，目前有多少个标签页啊？': ('task', None),
    '翻一下当前这个页面': ('task', None),
    '置办了一文': ('incomplete', None),
    '只保留一吻': ('steer', 'incomplete'),
    '对': ('chat', None),
    '呃，不是要你在这里翻译，是要你把这个页面上的内容给翻译掉。': ('steer', None),
    '可以看到当前这篇文章吗？': ('page_question', None),
    '嗯，把它改成中文，然后': ('task', None),
    '是关于什么的？Hello，可以看到当天的文章吗？': ('page_question', None),
    '可以先将它的前三段进行翻译吗？': ('task', 'answer'),
}

def read_key():
    if os.environ.get('TYPESAFE_API_KEY'): return os.environ['TYPESAFE_API_KEY']
    for line in open(os.path.join(HOME, 'typesafe.env')):
        if line.startswith('TYPESAFE_API_KEY='): return line.split('=', 1)[1].strip().strip('"\'')
    raise SystemExit('no TypeSafe key')

def jev(state, questions, key, attempts=4):
    body = json.dumps({'model': MODEL, 'state': state, 'questions': questions}, ensure_ascii=False).encode()
    req = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=body, method='POST',
                                 headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    for i in range(attempts):
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read())
                return data, (time.time() - started) * 1000
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and i < attempts - 1:
                time.sleep(1.5 * (2 ** i)); continue
            raise SystemExit(f'Jev HTTP {e.code}: {e.read()[:300]}')
    raise SystemExit('Jev retries exhausted')

def route_questions(n):
    q = {}
    for i in range(n):
        q[f'lane_{i}'] = {'type': 'choice', 'instructions': {
            'question': f'For the utterance at `utterances[{i}]`, decide which handling lane a browser copilot should use. The copilot sits beside the user\'s current browser tab and can reply by voice or text, read the current page text, or hand the request to a browser task engine that performs actions or changes what the page shows and then verifies the result. Utterances come from speech recognition or typed text and may contain recognition errors; judge the intended request. Use `utterances[{i}].previous` (earlier utterances in the same session, oldest first) and `utterances[{i}].taskRunning` when they help.'},
            'criteria': LANES}
        q[f'pagechange_{i}'] = {'type': 'noul', 'instructions': f'Does the user in `utterances[{i}]` want something to change or appear on the web page itself, rather than only being told or read to them?',
            'criteria': {'true': 'The user expects a visible result on the page: navigation, a switch, marks, translation shown in the page, filled text, and so on', 'false': 'A spoken or written reply satisfies the request, or no request is made'}}
    return q

def load_voice():
    rows = []
    for f in sorted(glob.glob(f'{HOME}/voice-capture/*.jsonl')):
        day = os.path.basename(f)[:-6]
        for l in open(f):
            try: r = json.loads(l)
            except: continue
            if r.get('type') == 'asr' and r.get('text', '').strip():
                rows.append({'day': day, 'at': r['at'], 'voiceId': r['voiceId'], 'turn': r.get('turn'), 'asrOutcome': r.get('outcome'), 'text': r['text'].strip()})
    return rows

def load_log_events():
    routes, tools = {}, defaultdict(list)
    for l in open(f'{HOME}/agent.log', errors='replace'):
        m = re.search(r'\[voice\] (route_result|tool_call) (\{.*\})\s*$', l)
        if not m: continue
        try: d = json.loads(m.group(2))
        except: continue
        if m.group(1) == 'route_result':
            routes[(d.get('voiceId'), d.get('turn'))] = {'kind': d.get('kind'), 'accepted': d.get('accepted'), 'elapsedMs': d.get('elapsedMs')}
        else:
            try: det = json.loads(d.get('detail', '{}'))
            except: det = {}
            tools[d.get('voiceId')].append({'at': det.get('at'), 'name': det.get('name')})
    return routes, tools

def load_receipts():
    rows = []
    for f in glob.glob(f'{HOME}/task-receipts/*.json'):
        if f.endswith('_index.json'): continue
        try: r = json.load(open(f)).get('receipt') or {}
        except: continue
        if r.get('text'): rows.append({'text': r['text'].strip(), 'source': r.get('source'), 'action': r.get('action'), 'status': r.get('status'), 'updatedAt': r.get('updatedAt'), 'message': r.get('message')})
    return rows

def main():
    key = read_key()
    voice = load_voice(); routes, tools = load_log_events(); receipts = load_receipts()
    by_text = defaultdict(list)
    for r in receipts: by_text[r['text']].append(r)
    # what actually happened per utterance
    for v in voice:
        old = routes.get((v['voiceId'], v['turn']))
        rt = [t['name'] for t in tools.get(v['voiceId'], []) if isinstance(t.get('at'), (int, float)) and -2000 <= t['at'] - v['at'] <= 25000]
        rec = [r for r in by_text.get(v['text'], []) if r['source'] == 'voice']
        v['era'] = 'realtime3' if v['day'] >= '2026-09-20' else 'classifier25'
        v['oldRoute'] = old; v['realtimeTools'] = rt
        v['dispatched'] = sorted({f"{r['action']}:{r['status']}" for r in rec})
        if v['era'] == 'classifier25':
            actual = None if not old else ('steer' if old['kind'] == 'steer' else 'task' if old['kind'] == 'action' and old['accepted'] else 'control' if old['kind'] == 'silent' else 'incomplete' if old['kind'] == 'clarify' else 'chat')
        else:
            names = set(rt)
            actual = 'task' if 'browser_request' in names or 'task_action' in names else 'status' if 'task_status' in names else 'page_question' if 'read_page' in names else 'chat'
            if actual == 'task' and any(d.startswith('steer') for d in v['dispatched']): actual = 'steer'
        v['actual'] = actual
        lab = VOICE_LABELS.get(v['text']); v['label'], v['labelAlt'] = (lab if lab else (None, None))
    # session context
    sessions = defaultdict(list)
    for v in voice: sessions[v['voiceId']].append(v)
    for vs in sessions.values():
        vs.sort(key=lambda x: x['at'])
        for i, v in enumerate(vs):
            v['previous'] = [p['text'] for p in vs[max(0, i - 3):i]]
            v['taskRunning'] = any(p.get('actual') in ('task', 'steer') for p in vs[:i])
    # Jev on voice, batched
    calls = 0; usage = Counter()
    def run_batches(items, channel):
        nonlocal calls
        for s in range(0, len(items), BATCH):
            chunk = items[s:s + BATCH]
            state = {'channel': channel, 'utterances': [{'text': it['text'], 'previous': it.get('previous', []), 'taskRunning': it.get('taskRunning', 'unknown')} for it in chunk]}
            data, ms = jev(state, route_questions(len(chunk)), key); calls += 1
            for k, n in (data.get('usage') or {}).items(): usage[k] += n
            for i, it in enumerate(chunk):
                a = data['answers'].get(f'lane_{i}', {}); p = data['answers'].get(f'pagechange_{i}', {})
                it['jev'] = {'lane': a.get('choice'), 'confidence': a.get('confidence'), 'probabilities': a.get('probabilities'), 'pageChange': p.get('noul'), 'batchMs': round(ms)}
    run_batches(voice, 'voice')
    # text/voice task requests actually dispatched as start
    starts = {}
    for r in receipts:
        if r['action'] == 'start' and len(r['text']) >= 2 and r['text'] not in starts:
            starts[r['text']] = {'text': r['text'], 'source': r['source'], 'status': r['status'], 'updatedAt': r['updatedAt']}
    tasks = sorted(starts.values(), key=lambda x: x['updatedAt'] or 0)
    run_batches(tasks, 'task_request')
    # single-utterance latency samples
    latency = []
    for v in [x for x in voice if x['era'] == 'realtime3'][:8]:
        state = {'channel': 'voice', 'utterances': [{'text': v['text'], 'previous': v['previous'], 'taskRunning': v['taskRunning']}]}
        data, ms = jev(state, route_questions(1), key); calls += 1
        for k, n in (data.get('usage') or {}).items(): usage[k] += n
        latency.append({'text': v['text'], 'ms': round(ms), 'lane': data['answers']['lane_0'].get('choice')})
    json.dump(voice, open(f'{OUT}/voice-utterances.json', 'w'), ensure_ascii=False, indent=1)
    json.dump(tasks, open(f'{OUT}/task-requests.json', 'w'), ensure_ascii=False, indent=1)
    json.dump({'model': MODEL, 'calls': calls, 'usage': dict(usage), 'singles': latency}, open(f'{OUT}/jev-latency.json', 'w'), ensure_ascii=False, indent=1)
    # summary
    labeled = [v for v in voice if v['label']]
    def agree(x, lab, alt): return x == lab or (alt is not None and x == alt)
    print(f'voice utterances {len(voice)} labeled {len(labeled)}; jev calls {calls}; usage {dict(usage)}')
    for era in ('classifier25', 'realtime3'):
        vs = [v for v in labeled if v['era'] == era and v['actual']]
        a_act = sum(agree(v['actual'], v['label'], v['labelAlt']) for v in vs); a_jev = sum(agree(v['jev']['lane'], v['label'], v['labelAlt']) for v in vs)
        print(f'{era}: n={len(vs)} actual-router agrees {a_act}, jev agrees {a_jev}')
    print(f'task requests {len(tasks)}: jev lanes', Counter(t['jev']['lane'] for t in tasks))
    ms = sorted(l['ms'] for l in latency); print('single-call latency ms', ms)

if __name__ == '__main__':
    main()
