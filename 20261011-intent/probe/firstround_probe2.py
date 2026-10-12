# Probe: with the full product toolset, how often does the main model answer a read-only page question in round 1
# vs. spend a tool round? Compare current AX-tree observation (truncated marker) vs main-content text observation.
import json, os, re, time, uuid, urllib.request, sys
sys.path.insert(0, os.path.dirname(__file__))
KEY = os.environ['STEPFUN_API_KEY']
URL = 'https://api.stepfun.com/step_plan/v1/chat/completions'
base = json.loads(json.load(open('/workspace/bys-trace/runs/summary-r1/bodies.json'))[0])
SYS = base['messages'][0]['content']; cut = SYS.index('# Product conversation context')
STABLE, TAIL = SYS[:cut], SYS[cut:]
ART = open(os.path.join(os.path.dirname(__file__), 'miyazaki.txt')).read()
READ_TOOLS = {'read_element','read_elements','snapshot','tabs','fetch','screenshot','js','send_user_message'}

def call(body):
    body = dict(body); body.update(stream=True, stream_options={'include_usage': True}, reasoning_effort='low', max_completion_tokens=800)
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t0 = time.time(); fb = fo = None; usage = None; err = None; kind = None; tools = []; text = ''; fin = None
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            for raw in r:
                line = raw.decode('utf8','ignore').strip()
                if not line.startswith('data:'): continue
                b = line[5:].strip()
                if b == '[DONE]': break
                try: c = json.loads(b)
                except: continue
                fb = fb or time.time()
                if c.get('usage'): usage = c['usage']
                d = ((c.get('choices') or [{}])[0].get('delta') or {})
                text += d.get('content') or ''
                fin = (c.get('choices') or [{}])[0].get('finish_reason') or fin
                for tc in d.get('tool_calls') or []:
                    n = (tc.get('function') or {}).get('name')
                    if n: tools.append(n)
                if (d.get('content') or d.get('tool_calls')) and not fo:
                    fo = time.time(); kind = 'tool' if d.get('tool_calls') else 'text'
    except Exception as e: err = str(e)[:160]
    f = lambda x: round(x - t0, 2) if x else None
    u = usage or {}
    return {'firstEvent': f(fb), 'firstOutput': f(fo), 'firstKind': kind, 'tools': tools, 'total': f(time.time()), 'prompt': u.get('prompt_tokens'), 'cached': u.get('cached_tokens'), 'err': err, 'finish': fin, 'text': text[:400]}

def body(obs, toolset):
    b = json.loads(json.dumps(base)); m = b['messages']
    m[0]['content'] = STABLE
    m.insert(1, {'role': 'user', 'content': re.sub(r'"runId":"[0-9a-f-]+"', '"runId":"%s"' % uuid.uuid4(), TAIL)})
    if obs == 'main_text':
        u = m[2]['content'][0]['text']
        head = u[:u.index('<page-content')]
        head = head.replace('Act on this observation', 'This is the main article text extracted from the page (first 12,000 characters of %d). Act on this observation' % len(ART))
        m[2]['content'][0]['text'] = head + '<page-content untrusted tab=448870886 url="https://en.wikipedia.org/wiki/Hayao_Miyazaki" title="Hayao Miyazaki - Wikipedia" kind="main-text">\n' + ART[:12000] + '\n</page-content>'
    if toolset == 'read':
        b['tools'] = [t for t in b['tools'] if t['function']['name'] in READ_TOOLS]
    return b

N = int(os.environ.get('N', '5'))
out = []
for obs in ('ax_tree', 'main_text'):
    for toolset in ('all',):
        for rep in range(N):
            r = call(body(obs, toolset)); r.update(obs=obs, toolset=toolset, rep=rep)
            print(json.dumps(r), flush=True); out.append(r); time.sleep(1)
json.dump(out, open(os.path.join(os.path.dirname(__file__), 'firstround_probe2.json'), 'w'), indent=1)
