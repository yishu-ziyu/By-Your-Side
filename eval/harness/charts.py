#!/usr/bin/env python3
"""Charts for a run report: chartA.png (pass rate / median s / cost or tokens per pass), chartB.png (pass rate by category).
usage: charts.py <runDir> [highlight model spec]   (default highlight: best pass rate). Font: BYS_CJK_FONT or the first CJK font found."""
import json, os, sys
import matplotlib
matplotlib.use('Agg')
matplotlib.rcParams['text.parse_math'] = False
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm

RUN = sys.argv[1]
BG, INK, GRAY, ACC, LIGHT = '#faf9f5', '#141413', '#4c4b45', '#d97757', '#b9b7ae'
FONTS = [os.environ.get('BYS_CJK_FONT'), '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
         '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Medium.ttc']
FONT = next((f for f in FONTS if f and os.path.exists(f)), None)
if not FONT: sys.exit('no CJK font found: set BYS_CJK_FONT')
fm.fontManager.addfont(FONT)
fam = fm.FontProperties(fname=FONT).get_name()
plt.rcParams.update({'font.family': fam, 'text.color': INK, 'axes.labelcolor': INK, 'xtick.color': GRAY, 'ytick.color': INK,
                     'figure.facecolor': BG, 'axes.facecolor': BG, 'savefig.facecolor': BG, 'axes.grid': False})
R = json.load(open(f'{RUN}/report.json'))
H = {m: s for m, s in R['head_to_head'].items() if s and s['pass_rate'] is not None}
if not H: sys.exit('no model has a judged result on the common task set (judge errors?); no charts')
order = sorted(H, key=lambda m: -H[m]['pass_rate'])
HL = sys.argv[2] if len(sys.argv) > 2 else order[0]
n_common = len(R['head_to_head_task_ids'])
priced = all(H[m]['cost_per_pass_usd'] is not None for m in order)

def nm(m):
    main, _, fast = m.partition('+')
    return main.split('/')[-1] + (f' + 快速 {fast.split("/")[-1]}' if fast and fast != main else '')
def label(m):
    main, _, fast = m.partition('+')
    return main.split('/')[-1] + (f'\n快速 {fast.split("/")[-1]}' if fast and fast != main else '') + f'\n(n={H[m]["n"]})'
col = lambda m: ACC if m == HL else GRAY

def clean(ax):
    for s in ax.spines.values(): s.set_visible(False)
    ax.tick_params(length=0)

# ---------- Chart A ----------
third = ('每次通过的成本（美元）', lambda s: s['cost_per_pass_usd'] or 0, lambda v: f'${v:.4f}') if priced else \
        ('每题平均 token（主模型）', lambda s: s['mean_tokens_total'], lambda v: f'{v / 1000:.1f}k')
fig, axes = plt.subplots(1, 3, figsize=(15, 1.1 * len(order) + 2.6))
panels = [('通过率', lambda s: s['pass_rate'] * 100, lambda v: f'{v:.0f}%'),
          ('中位总耗时（秒）', lambda s: s['median_total_s'] or 0, lambda v: f'{v:.1f}s'), third]
ys = list(range(len(order)))[::-1]
for ax, (title, f, fmt) in zip(axes, panels):
    vals = [f(H[m]) for m in order]
    ax.barh(ys, vals, color=[col(m) for m in order], height=0.62)
    vmax = max(vals) or 1
    for y, v, m in zip(ys, vals, order):
        ax.text(v + vmax * 0.03, y, fmt(v), va='center', ha='left', fontsize=12, color=ACC if m == HL else INK)
    ax.set_xlim(0, vmax * 1.32); ax.set_xticks([])
    ax.set_yticks(ys); ax.set_yticklabels([label(m) for m in order] if ax is axes[0] else [''] * len(order), fontsize=11)
    ax.set_title(title, loc='left', fontsize=13, color=GRAY, pad=8)
    clean(ax)
fast = min(order, key=lambda m: H[m]['median_total_s'] or 1e9)
best_rate = H[order[0]]['pass_rate']
top = [m for m in order if H[m]['pass_rate'] == best_rate]
lead = f'{nm(order[0])} 通过率最高' if len(top) == 1 else f'{len(top)} 个配置通过率并列最高（{best_rate * 100:.0f}%）'
fig.suptitle(f'{lead}；{nm(fast)} 最快', x=0.02, ha='left', fontsize=17, color=INK, y=0.985)
fig.text(0.02, 1 - 0.75 / fig.get_figheight(), f'{n_common} 道每个模型配置都有有效结果的同题对比', fontsize=11, color=GRAY, ha='left')
cost_note = '成本按价格表由轨迹 token 计算' if priced else '无价格表，只比 token（Token Plan 为订阅制）'
fig.text(0.02, 0.2 / fig.get_figheight(), f'FIG 1  ·  run {R["run"]}  ·  {cost_note}  ·  自动评审 judge v3（Codex：截图 + 页面文本 + 工具记录）', fontsize=9.5, color=GRAY, ha='left')
fig.subplots_adjust(left=0.2, right=0.98, top=1 - 1.2 / fig.get_figheight(), bottom=0.55 / fig.get_figheight(), wspace=0.12)
fig.savefig(f'{RUN}/chartA.png', dpi=160); plt.close(fig)

# ---------- Chart B ----------
CAT = {'page_understanding': '页面理解', 'selection_ask': '划词提问*', 'translation': '页面翻译', 'browser_action_single': '单步操作',
       'browser_action_multistep': '多步操作', 'extraction_to_table': '抽取成表', 'research_multi_page': '多页调研', 'form_fill_no_submit': '填表不提交*',
       'cross_tab': '跨标签页*', 'memory_skill': '记忆/技能*', 'other': '其他'}
cats = [c for c in CAT if any(H[m]['by_category'].get(c, {}).get('pass_rate') is not None for m in order)]
cats.sort(key=lambda c: -(H[HL]['by_category'].get(c, {}).get('pass_rate') or 0))
nm_ = len(order); bh = 0.8 / nm_
fig, ax = plt.subplots(figsize=(11, 1.25 * len(cats) + 2.4))
for ci, c in enumerate(cats):
    base = (len(cats) - 1 - ci)
    for mi, m in enumerate(order):
        d = H[m]['by_category'].get(c)
        if d and d['pass_rate'] is None: d = None
        y = base + 0.4 - bh * (mi + 0.5)
        if not d:
            ax.text(1, y, f'{nm(m)}：未跑到', va='center', fontsize=9.5, color=LIGHT); continue
        v = d['pass_rate'] * 100
        ax.barh(y, v, height=bh * 0.86, color=col(m))
        ax.text(v + 1.2, y, f'{v:.0f}%  {nm(m)}  ({d["passed"]}/{d["n"]})', va='center', fontsize=9.5, color=ACC if m == HL else INK)
ax.set_yticks([len(cats) - 1 - i for i in range(len(cats))]); ax.set_yticklabels([CAT[c] for c in cats], fontsize=12.5)
ax.set_xlim(0, 150); ax.set_xticks([]); clean(ax)
fig.suptitle('按任务类别的通过率', x=0.02, ha='left', fontsize=17, y=0.985)
fig.text(0.02, 1 - 0.78 / fig.get_figheight(), f'同 {n_common} 题；* 类别的前置步骤（划词、开标签页等）harness 未执行', fontsize=10.5, color=GRAY, ha='left')
fig.text(0.02, 0.25 / fig.get_figheight(), f'FIG 2  ·  run {R["run"]}  ·  括号内为 通过/题数', fontsize=9.5, color=GRAY, ha='left')
fig.subplots_adjust(left=0.14, right=0.98, top=1 - 1.15 / fig.get_figheight(), bottom=0.6 / fig.get_figheight())
fig.savefig(f'{RUN}/chartB.png', dpi=160); plt.close(fig)
print('ok')
