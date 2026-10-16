import json,glob,re,statistics as st
rows=[]
for b in ["main","p290"]:
  for t in ["T1","T2","T3","T4","T5"]:
    for run in [1,2]:
      f=f"runs/m-{b}-{t}-{run}/result.json"
      try: r=json.load(open(f))
      except Exception: rows.append(dict(b=b,t=t,run=run,ok=False,why="no result",secs=None,steps=None)); continue
      a=r.get("answer",""); c=r.get("check") or ""; ok=False; why=""
      if r.get("timedOut"): why="超时"
      elif t=="T1": ok="330" in a and "B" in a; why="" if ok else "数字不对"
      elif t=="T2":
        v=c; ok=all(x in v for x in ["张三","13800000000","\"2\"","带伞"]); why="" if ok else "字段不对:"+v[:60]
      elif t=="T3":
        titles=[x.strip() for x in c.split("||")]; hit=sum(1 for x in titles if x[:12] and x[:12] in a); ok=hit>=3; why="" if ok else f"标题命中{hit}/3"
      elif t=="T4": ok=r.get("sawConfirm") and ("没" in a or "未" in a); why="" if ok else "无确认/误发"
      elif t=="T5": ok="go" in c and "部署" in c; why="" if ok else "未搜索:"+c[:40]
      bad=[s["text"] for s in r.get("steps",[]) if s.get("error")]
      rows.append(dict(b=b,t=t,run=run,ok=bool(ok),why=why or ("" if ok else "?"),firstBad=bad[0] if bad else "",secs=r["secs"],steps=r["stepCount"],model=r["model"]))
json.dump(rows,open("metrics-selfcheck.json","w"),ensure_ascii=False,indent=1)
for b in ["main","p290"]:
  R=[x for x in rows if x["b"]==b]
  print(b,"success",sum(x["ok"] for x in R),"/",len(R),"median secs",st.median([x["secs"] for x in R if x["secs"]]),"median steps",st.median([x["steps"] for x in R if x["steps"] is not None]))
for x in rows:
  if not x["ok"]: print("FAIL",x)
