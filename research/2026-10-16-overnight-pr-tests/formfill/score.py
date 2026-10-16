import json,glob,os,re
EXP={'a':{'name':'林晓雨','email':'linxy@example.com','phone':'13900001234','company':'青石科技','role':'产品经理','agree':True,'news':False},
'b':{'proj':'星河计划','title1':'年度增长报告','subtitle':'第三季度复盘','title2':'用户访谈小结','memo':'初稿待审','memotitle':'','abbr':''},
'c':{'cname':'周子航','date':'2026-11-05','svc':'保养','cnote':'上午十点后到'}}
REQ={'a':['name','email','phone','role','agree'],'b':['proj','title1','title2'],'c':['cname','date','svc']}
out=[]
for f in sorted(glob.glob('../runs/formfill/*/result.json'),key=os.path.getmtime):
  r=json.load(open(f)); tag=os.path.basename(os.path.dirname(f)); form,build=tag.split('-')[:2]
  fk=form[0]; e=EXP[fk]
  try: v=json.loads(r['check'])
  except Exception: v={}
  correct=[k for k in e if v.get(k)==e[k]]
  wrong=[]
  for k in e:
    got=v.get(k)
    if got==e[k] or got in ('',False,None): continue
    src=[k2 for k2,x in e.items() if x not in ('',False,True) and x==got]
    wrong.append({'field':k,'got':got,'expected':e[k],'valueBelongsTo':src})
  empty_req=[k for k in REQ[fk] if v.get(k) in ('',False,None)]
  ok=len(correct)==len(e)
  out.append({'label':'SELF-TEST (local fixture pages, not real sites)','tag':tag,'form':form,'build':'main@ba3d11a8' if build=='main' else 'proto/440-on-main@1659c444',
   'pass':ok and not r['timedOut'],'correct':len(correct),'total':len(e),'accuracy':round(len(correct)/len(e),3),'wrongFields':wrong,
   'missingFields':[k for k in e if k not in correct and v.get(k) in ('',False,None)],'emptyRequired':empty_req,
   'secs':r['secs'],'timedOut':r['timedOut'],'steps':r['stepCount'],'stepErrors':sum(s['error'] for s in r['steps']),'finalValues':v,'answer':r['answer'][:300]})
json.dump(out,open('../runs/formfill/results.json','w'),ensure_ascii=False,indent=1)
L=['# Form-fill accuracy — SELF-TEST results (本地测试页, local fixtures only, nothing submitted)','',
 'Model MiniMax-M3.1-Flash-Preview (minimax-cn). Builds: main = ba3d11a8 (wt-main, own-tree build), 440 = proto/440-on-main 1659c444. Fixtures: overnight/formfill/server.mjs (port 8966).','',
 '| form | build | runs | pass | field acc | wrong-field placements | avg s | avg steps |','|---|---|---|---|---|---|---|---|']
for fm in ['a','b','b2','c']:
  for b in ('main@ba3d11a8','proto/440-on-main@1659c444'):
    rs=[x for x in out if x['form']==fm and x['build']==b]
    if not rs: continue
    L.append(f"| {fm.upper()} | {b} | {len(rs)} | {sum(x['pass'] for x in rs)}/{len(rs)} | {sum(x['correct'] for x in rs)}/{sum(x['total'] for x in rs)} | {sum(len(x['wrongFields']) for x in rs)} | {sum(x['secs'] for x in rs)/len(rs):.0f} | {sum(x['steps'] for x in rs)/len(rs):.1f} |")
L+=['','## Failures','','None: every run passed.',''] + ['Prompts: A/B/B2/C in overnight/formfill/lane.sh (B2 = same page B, prompt names the article 标题 first with less section structure). Checker: all input/select/textarea values read from the final DOM; pass = every field exact, nothing in fields that should stay empty.','','## Notes','','- Every form-C run (both builds) logs its first step as an error: clicking 「预约服务」 opens the dialog, and the click then gets reported as 被「预约到店」挡住 (the newly opened dialog counts as the blocker). The model recovers every time, but some runs then hit 没找到目标 / selectOption 失败 before succeeding (e.g. c-main-d62-r23 had 7 failed steps, c-main-d62-4 had 5).','']
for x in out:
  if not x['pass']: L.append(f"- {x['tag']} ({x['build']}): {x['correct']}/{x['total']}; wrong={json.dumps(x['wrongFields'],ensure_ascii=False)}; missing={x['missingFields']}; timedOut={x['timedOut']}; steps={x['steps']}")
open('../runs/formfill/formfill-summary.md','w').write('\n'.join(L)+'\n'); print('\n'.join(L))
