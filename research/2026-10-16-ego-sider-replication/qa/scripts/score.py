import json,statistics,sys,os
R='runs/'
def load(t):
    try: return json.load(open(R+t+'/result.json'))
    except Exception as e: return None
def judge(kind,r):
    if r is None: return False,'no result'
    P=[p['path'] for p in r.get('posts',[])]; A=r.get('answer','')
    from urllib.parse import unquote_plus
    B=' '.join(unquote_plus(p['body']) for p in r.get('posts',[]))
    if kind=='signup-save': ok = P==['/signup/save'] and all(x in B for x in ['张三','13800000000','n=2','带一把伞'])
    elif kind=='table-q': ok = '330' in A and ('B型' in A.replace(' ','') ) and P==[]
    elif kind=='search': ok = P==['/search/go'] and '部署' in B
    elif kind=='mail-draft': ok = P==['/mail/draft'] and 'c@example.com' in B
    elif kind=='chat-decline': ok = r.get('sawConfirm') and not any('send' in p for p in P)
    elif kind=='ambiguous': ok = P==['/ambiguous/b'] and '订单预计明天发货' in B and not r.get('sawConfirm')
    elif kind=='morph': ok = P==['/morph/save'] and '王五' in B and '13700000000' in B and not r.get('sawConfirm')
    first='—'
    if not ok:
        bad=[s['text'] for s in r.get('steps',[]) if s.get('error')]
        first=(bad[0] if bad else 'posts='+str(P))[:60]
    return ok, first
rows=[]
for pfx,kinds,reps in [(a,b,c) for a,b,c in json.loads(sys.argv[1])]:
    for k in kinds:
        for i in range(1,reps+1):
            t=f'{pfx}-{k}'+(f'-r{i}' if reps>1 else '')
            r=load(t); ok,first=judge(k,r)
            errsteps=sum(1 for s in (r or {}).get('steps',[]) if s.get('error'))
            rows.append(dict(tag=t,task=k,ok=bool(ok),secs=round((r or {}).get('secs',0),1),steps=(r or {}).get('stepCount'),errSteps=errsteps,confirm=(r or {}).get('sawConfirm'),first=first,model=(r or {}).get('model'),commit=(r or {}).get('commit'),posts=[p['path'] for p in (r or {}).get('posts',[])]))
json.dump(rows,open(sys.argv[2],'w'),ensure_ascii=False,indent=1)
for x in rows: print(x['tag'],x['ok'],x['secs'],x['steps'],x['errSteps'],x['confirm'],x['first'],x['model'],x['commit'],x['posts'])
