# Replay real product request bodies against Step Plan with different reasoning_effort. Key from env, never printed.
import json, os, time, urllib.request, sys
KEY = os.environ['STEPFUN_API_KEY']
URL = 'https://api.stepfun.com/step_plan/v1/chat/completions'
def run(body, effort):
    j = json.loads(body)
    j.pop('reasoning_effort', None)
    if effort: j['reasoning_effort'] = effort
    j['stream'] = True; j['stream_options'] = {'include_usage': True}
    data = json.dumps(j).encode()
    req = urllib.request.Request(URL, data=data, headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t0 = time.time(); fb = fr = fo = None; rc = cc = 0; usage = None; err = None
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            fb = time.time()
            for raw in resp:
                line = raw.decode('utf8', 'ignore').strip()
                if not line.startswith('data:'): continue
                b = line[5:].strip()
                if b == '[DONE]': break
                try: c = json.loads(b)
                except: continue
                if c.get('usage'): usage = c['usage']
                ch = (c.get('choices') or [{}])[0]; d = ch.get('delta') or {}
                r = d.get('reasoning_content') or d.get('reasoning')
                if r: fr = fr or time.time(); rc += len(r)
                if d.get('content') or d.get('tool_calls'):
                    fo = fo or time.time(); cc += len(d.get('content') or '') + len(json.dumps(d.get('tool_calls') or ''))
    except Exception as e:
        err = str(e)[:200]
    t1 = time.time()
    f = lambda x: round(x - t0, 2) if x else None
    return {'effort': effort or 'default', 'firstByte': f(fb), 'firstReasoning': f(fr), 'firstOutput': f(fo), 'total': f(t1), 'reasoningChars': rc, 'outChars': cc,
            'prompt_tokens': (usage or {}).get('prompt_tokens'), 'completion_tokens': (usage or {}).get('completion_tokens'),
            'reasoning_tokens': ((usage or {}).get('completion_tokens_details') or {}).get('reasoning_tokens'), 'err': err}
cases = [('summary-main(19k tok)', '/workspace/bys-trace/runs/summary-r1/bodies.json', 0),
         ('action-main-call0(19k tok)', '/workspace/bys-trace/runs/action-r1/bodies.json', 0)]
# memory:date body
b = json.load(open('/workspace/bys-trace/runs/action-r1/bodies.json'))
idx = next(i for i, x in enumerate(b) if 'calendar date' in x)
cases.append(('memory:date side call', '/workspace/bys-trace/runs/action-r1/bodies.json', idx))
gi = next(i for i, x in enumerate(b) if 'You check whether' in x)
cases.append(('goal_check side call', '/workspace/bys-trace/runs/action-r1/bodies.json', gi))
out = []
for name, path, i in cases:
    body = json.load(open(path))[i]
    for rep in range(2):
        for eff in (None, 'low', 'medium', 'high'):
            if name.startswith(('memory', 'goal')) and eff in ('medium', 'high'): continue
            r = run(body, eff); r['case'] = name; r['rep'] = rep
            print(json.dumps(r, ensure_ascii=False), flush=True); out.append(r)
json.dump(out, open('/workspace/bys-trace/replay.json', 'w'), ensure_ascii=False, indent=1)
