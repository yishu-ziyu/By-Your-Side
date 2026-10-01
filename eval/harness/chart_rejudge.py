import json,matplotlib,os,sys
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm
# usage: chart_rejudge.py [out.png]  (baseline from eval/splits/baseline_judge_v3.json; font via BYS_CJK_FONT)
FONT=os.environ.get('BYS_CJK_FONT','/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'); fm.fontManager.addfont(FONT)
plt.rcParams.update({'font.family':fm.FontProperties(fname=FONT).get_name(),'text.parse_math':False})
BG,INK,GRAY,ACC,LIGHT='#faf9f5','#141413','#4c4b45','#d97757','#c9c6bb'
B=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','splits','baseline_judge_v3.json')))
order=sorted(B,key=lambda m:-B[m]['elig113_new']['rate']); lead=order[0]
fig,ax=plt.subplots(figsize=(10.5,5.6),dpi=200); fig.patch.set_facecolor(BG); ax.set_facecolor(BG)
h=0.36
for i,m in enumerate(order):
    y=len(order)-1-i; o=B[m]['elig113_old']; n=B[m]['elig113_new']
    ax.barh(y+h/2+0.02,o['rate']*100,height=h,color=LIGHT)
    ax.barh(y-h/2-0.02,n['rate']*100,height=h,color=ACC if m==lead else GRAY)
    ax.text(o['rate']*100+0.8,y+h/2+0.02,f"旧 {o['rate']*100:.1f}%（{o['passed']}/{o['n']}）",va='center',fontsize=10.5,color=GRAY)
    d=(n['rate']-o['rate'])*100
    ax.text(n['rate']*100+0.8,y-h/2-0.02,f"修正后 {n['rate']*100:.1f}%（{n['passed']}/{n['n']}，{d:+.1f}）  无法判定 {n['undet']}",va='center',fontsize=10.5,color=ACC if m==lead else INK)
ax.set_yticks(range(len(order))); ax.set_yticklabels(order[::-1],fontsize=12.5,color=INK)
ax.set_xticks([]); ax.set_xlim(0,128)
for s in ax.spines.values(): s.set_visible(False)
ax.tick_params(left=False)
ds=[(B[m]['elig113_new']['rate']-B[m]['elig113_old']['rate'])*100 for m in order]
fig.suptitle(f'修正判分后 4 个模型通过率都上升 {min(ds):.1f}–{max(ds):.1f} 个百分点，{lead} 仍然第一',x=0.02,ha='left',y=0.97,fontsize=16,color=INK)
fig.text(0.02,0.885,'run full-1，113 道不依赖前置步骤的题；旧 = 只看截图的判分 + v1 任务规则，修正后 = 截图 + 页面文本 + 工具记录的判分 + v2 规则；“无法判定”按未通过计',fontsize=9.5,color=GRAY,ha='left')
fig.text(0.02,0.02,'FIG · run full-1 重判（judge v3）  ·  浅灰 = 旧基线',fontsize=9,color=GRAY,ha='left')
plt.subplots_adjust(left=0.17,right=0.98,top=0.83,bottom=0.08)
fig.savefig(sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','results','full-1','chart_rejudge.png'),facecolor=BG)
