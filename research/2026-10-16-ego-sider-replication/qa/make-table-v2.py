#!/usr/bin/env python3
"""Render summary-table.json -> final-summary-table-v2.png (1600px).
Usage: make-table-v2.py [search-result.json] [-o out.png]
search-result.json (optional) overrides the 搜索 row, shape:
  {"main": {"ok":3,"n":3,"secs":12.0,"steps":4}, "#290": {...}, ...,
   "confirmed": false}   # confirmed=true -> drop 「未确认」 wording
"""
import json, sys, html, subprocess, os
from playwright.sync_api import sync_playwright
D=os.path.dirname(os.path.abspath(__file__))
args=sys.argv[1:]; out=os.path.join(D,'final-summary-table-v2.png'); sr=None
if '-o' in args: i=args.index('-o'); out=args[i+1]; del args[i:i+2]
if args: sr=json.load(open(args[0]))
s=json.load(open(os.path.join(D,'summary-table.json')))
if sr:
  for b,v in sr.items():
    if b in s['branches'] and isinstance(v,dict): s['branches'][b]['tasks']['search'].update(v)
confirmed=bool(sr and sr.get('confirmed'))
E=html.escape
T=[('signup-save','报名保存'),('table-q','表问答'),('search','搜索'),('mail-draft','邮件草稿'),('chat-decline','发送后选不发'),('ambiguous','歧义按钮'),('morph','中途改页')]
B=['main','#290','#439','#440','#483']
now=subprocess.check_output(['date','+%Y-%m-%d %H:%M'],env={**os.environ,'TZ':'Asia/Shanghai'}).decode().strip()
tag='<span class=tag>QA 实测，测试页</span>'
cards=[('#290','脚本点击发送也要先确认',['绕过确认直接发出的路径 <b>4 条→0 条</b>','拒绝后重试拦下 <b>3/3</b><small>（脚本模型强制重试；真模型拒绝后没再尝试，0/3）</small>','「现在发送吧」与正常同意各 <b>3/3</b> 恰发 1 条']),
 ('#439','回答里的按钮名可以点',['可点按钮名 <b>4/10→10/10</b>']),
 ('#440','填表后有回执，可撤销页面上的改动',['中途改页出回执 <b>3/3</b>','撤销还原备注/分类 <b>3/3</b>']),
 ('#483','中途改口能听进去',['中途改口 <b>5/5</b><small>（时机未记录；1 次脚本出错后重跑才过）</small>','动手后纠正 <b>4/5</b><small>（超时计入分母）</small>','动手前改口 <b>2/2</b>','撤销删规则 <b>3/3</b>'])]
m=s['branches']['main']['tasks']['search']['secs']
lim=[('搜索题用时差距未复现（仅 #290 交替复测）','同一时段交替各 3 次：main 21.4 秒，#290 17.9 秒，差距没复现；原因可能是时段，也可能是 main 新构建不同，分不开；表里搜索格是原批次数字'),
 ('#290','搜索题步数偏多：每次多 1 到 9 步，中位 7 步 vs main 4 步（main 为新构建，侧栏脚本指纹不同）；多出的是搜索后的核对，没有误拦'),('#290','真实会发送的站点未测'),
 ('#440','已保存的内容不能撤销（3/3），且无专门提醒'),('#440','模型自己运行代码改页时无回执、无撤销（1/3）'),
 ('#440','填错栏 2/6'),('#440','编辑器正文撤销后不还原（回执有写明）'),
 ('#483','撤销后下次回到一键加入只有 1/3'),('#483','撤销后新任务卡住 1 次'),('#483','「记下了」触发条件未确定（记忆写入 3/5）')]
h=[f'''<html><head><meta charset=utf-8><style>
*{{box-sizing:border-box}}body{{font-family:"Noto Sans CJK SC",sans-serif;margin:0;background:#fff;width:1600px;color:#222}}
.top{{background:#111;color:#fff;padding:26px 40px 20px}}h1{{margin:0;font-size:38px;font-weight:700}}.sub{{color:#bbb;font-size:18px;margin-top:8px}}
.cards{{display:flex;gap:18px;padding:26px 40px 8px}}.card{{flex:1;border:1px solid #cfe3d3;background:#f2faf4;border-radius:10px;padding:16px 18px}}
.card h3{{margin:0 0 4px;font-size:22px}}.card .w{{color:#2c6b3a;font-size:17px;margin-bottom:8px}}.card li{{font-size:17px;line-height:1.55;margin-bottom:2px}}.card ul{{margin:0 0 10px;padding-left:20px}}
.card b{{color:#1a6b2a}}small{{color:#666;font-size:14px}}.tag{{display:inline-block;background:#2c6b3a;color:#fff;font-size:14px;padding:2px 10px;border-radius:12px}}
.mid{{display:flex;gap:22px;padding:18px 40px 10px}}table{{border-collapse:collapse;width:1090px;font-size:16px;color:#999}}
th,td{{padding:9px 8px;white-space:nowrap;text-align:left;border-bottom:1px solid #eee}}th{{font-weight:500;color:#888}}th .c{{font-family:monospace;font-size:14px;display:block}}
td.t{{color:#777}}.amb{{background:#fff3d6;color:#8a5a00;font-weight:700;border:2px solid #f0b43c}}.amb small{{color:#8a5a00;font-weight:400;display:block;font-size:13px}}
.tot td{{font-size:20px;color:#777;font-weight:700;border-top:2px solid #ddd}}
.lim{{flex:1;border:2px solid #f0b43c;background:#fffaf0;border-radius:10px;padding:16px 20px}}.lim h2{{margin:0 0 10px;font-size:24px;color:#8a5a00}}
.lim li{{font-size:16.5px;line-height:1.5;margin-bottom:5px}}.lim ul{{padding-left:20px;margin:0}}.cap{{font-size:14px;color:#999;padding:4px 0 0}}
.foot{{padding:12px 40px 22px;font-size:15px;color:#666;border-top:1px solid #eee;margin-top:10px}}
td small{{display:block;font-size:11px;color:#888}}</style></head><body><div class=top><h1>{"成功率都没变差；搜索题用时差距未复现（仅 #290 交替复测）"}</h1>
<div class=sub>模型 {E(s["model"])} · 本地测试页 · 每格 3 次 · 用时步数为中位数 · 我们自己的测试，不是用户反馈</div></div><div class=cards>''']
for k,w,items in cards:
  h.append(f'<div class=card><h3>{k}</h3><div class=w>{w}</div><ul>'+''.join(f'<li>{i}</li>' for i in items)+f'</ul>{tag}</div>')
h.append('</div><div class=mid><div><table><tr><th>任务</th>'+''.join(f'<th>{b}<span class=c>{s["branches"][b]["commit"]}</span></th>' for b in B)+'</tr>')
tot={b:[0,0] for b in B}
for k,name in T:
  h.append(f'<tr><td class=t>{name}</td>')
  for b in B:
    x=s['branches'][b]['tasks'][k]; tot[b][0]+=x['ok']; tot[b][1]+=x['n']
    cell=f'{x["ok"]}/{x["n"]} · {x["secs"]:.1f} 秒 · {x["steps"]} 步'
    if k=='search' and b=='#290':
      h.append(f'<td>{cell}<small>交替复测差距未复现</small></td>')
    elif k=='search' and b!='main' and x['secs']-m>=8:
      h.append(f'<td class=amb>{cell}<small>{"交替复测差距未复现" if b=="#290" else "未交替复测"}</small></td>')
    else: h.append(f'<td>{cell}</td>')
  h.append('</tr>')
h.append('<tr class=tot><td>合计</td>'+''.join(f'<td>{a}/{n}</td>' for a,n in (tot[b] for b in B))+'</tr></table>')
h.append('<div class=cap>灰色＝没有明显差别；琥珀色＝搜索题比 main 慢 8 秒以上，交替复测只跑了 main 和 #290。</div></div>')
h.append('<div class=lim><h2>已知局限</h2><ul>'+''.join(f'<li><b>{a}</b>：{b}</li>' for a,b in lim)+'</ul></div></div>')
h.append(f'<div class=foot>更新时间 {now}（北京时间） · #440 打分用 de8bd542；待合分支头 1659c444 只多一句文案（已核对差异，2 次实显与预期一致）</div></body></html>')
open('/tmp/bys-table-v2.html','w').write(''.join(h))
with sync_playwright() as p:
  br=p.chromium.launch(executable_path='/home/box/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome')
  pg=br.new_page(viewport={'width':1600,'height':600}); pg.goto('file:///tmp/bys-table-v2.html'); pg.screenshot(path=out,full_page=True); br.close()
print(out)
