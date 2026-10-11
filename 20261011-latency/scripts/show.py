import json,sys
r=json.load(open(sys.argv[1]+'/result.json'))
print('ERR',r.get('error'),'|',r.get('exportStatus'))
for i,c in enumerate(r['calls']):
  q=c.get('req') or {}
  u=c.get('usage') or {}
  print(f"CALL{i} {c['url'][-40:]} start={c['start']} fb={c.get('firstByte')} reason={c.get('firstReasoning')} content={c.get('firstContent')} tool={c.get('firstTool')} end={c.get('end')} st={c.get('status')} rc={c['reasoningChars']} cc={c['contentChars']} tools={c['toolNames']} fin={c.get('finish')}")
  print(f"   req model={q.get('model')} eff={q.get('reasoning_effort')} body={q.get('bodyChars')} msgs={q.get('messages')} roles={q.get('roles')} sys={q.get('systemChars')} user={q.get('userChars')} toolmsg={q.get('toolMsgChars')} asst={q.get('assistantChars')} ntools={q.get('tools')} toolsChars={q.get('toolsChars')} usage={u.get('prompt_tokens')}/{u.get('completion_tokens')} cached={(u.get('prompt_tokens_details') or {}).get('cached_tokens')}")
  print('   sysHead:',(q.get('systemHead') or '')[:100].replace('\n',' '))
  print('   content:',(c.get('content') or '')[:200].replace('\n',' '))
  print('   reason:',(c.get('reasoningHead') or '')[:200].replace('\n',' '))
seen=set()
for e in r['events']:
  k=json.dumps(e,sort_keys=True)
  if k in seen: continue
  seen.add(k)
  d=e.get('data') or {}
  if e['kind'] in('sendMessage',) : continue
  print('EV',e['t'],e['src'],e['kind'],json.dumps({x:d.get(x) for x in ('ms','tab','method','url','status','err','reason','world')} if isinstance(d,dict) else d,ensure_ascii=False)[:200])
prev=None
for s in r['samples']:
  v={k:s[k] for k in s if k!='t'}
  print('UI',s['t'],json.dumps(v,ensure_ascii=False)[:300])
for p in r['pages']: print('PAGE',p['t'],p['tabs'][:200])
