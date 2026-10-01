#!/usr/bin/env python3
"""Charts for a run report: chartA.png (pass rate / median s / cost per pass), chartB.png (pass rate by category)."""
import json, sys
import matplotlib
matplotlib.use('Agg')
matplotlib.rcParams['text.parse_math'] = False
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm

RUN = sys.argv[1]
HL = sys.argv[2] if len(sys.argv) > 2 else 'opencode-go/deepseek-v4.1-flash'
BG, INK, GRAY, ACC, LIGHT = '#faf9f5', '#141413', '#4c4b45', '#d97757', '#b9b7ae'
import os
# Any CJK font file works; override with BYS_CJK_FONT.
FONT = os.environ.get('BYS_CJK_FONT', '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc')
fm.fontManager.addfont(FONT)
fam = fm.FontProperties(fname=FONT).get_name()
plt.rcParams.update({'font.family': fam, 'text.color': INK, 'axes.labelcolor': INK, 'xtick.color': GRAY, 'ytick.color': INK,
                     'figure.facecolor': BG, 'axes.facecolor': BG, 'savefig.facecolor': BG, 'axes.grid': False})
R = json.load(open(f'{RUN}/report.json'))
H = R['head_to_head']
ALL = ['opencode-go/mimo-v2.6-flash', 'opencode-go-nothink/mimo-v2.6-flash:off', 'opencode-go/deepseek-v4-flash', 'opencode-go/deepseek-v4.1-flash', 'opencode-go/space-bunny-free']
order = [m for m in ALL if H.get(m)]
PAIDM = [m for m in order if m.startswith('opencode-go/') and 'free' not in m]
n_common = len(R['head_to_head_task_ids'])
def nm(m):
    return 'mimo-v2.6-flash-nothink' if m.startswith('opencode-go-nothink/') else m.split('/')[-1]
def label(m):
    s = nm(m)
    return s + (f'\n(n={H[m]["n"]}，仅子集)' if H[m]['n'] < n_common else f'\n(n={H[m]["n"]})')
col = lambda m: ACC if m == HL else (LIGHT if ('free' in m or 'nothink' in m) else GRAY)

def clean(ax):
    for s in ax.spines.values(): s.set_visible(False)
    ax.tick_params(length=0)

# ---------- Chart A ----------
fig, axes = plt.subplots(1, 3, figsize=(15, 5.6))
panels = [('通过率', lambda s: s['pass_rate'] * 100, lambda v: f'{v:.0f}%'),
          ('中位总耗时（秒）', lambda s: s['median_total_s'], lambda v: f'{v:.1f}s'),
          ('每次通过的成本（美元）', lambda s: s['cost_per_pass_usd'] or 0, lambda v: '免费' if v == 0 else f'${v:.4f}')]
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
best = max(PAIDM, key=lambda m: H[m]['pass_rate'])
cheap = min([m for m in PAIDM if H[m]['cost_per_pass_usd']], key=lambda m: H[m]['cost_per_pass_usd'])
fast = min(PAIDM, key=lambda m: H[m]['median_total_s'])
fig.suptitle(f'{nm(best)} 通过率最高；{nm(fast)} 最快；{nm(cheap)} 每次通过最便宜', x=0.02, ha='left', fontsize=17, color=INK, y=0.985)
fig.text(0.02, 0.905, f'{n_common} 道三个付费模型均有有效结果的同题对比；浅灰 = 免费或变体模型（nothink 仅跑 58 题，非同题）；space-bunny-free 免费至 10/05', fontsize=11, color=GRAY, ha='left')
fig.text(0.02, 0.02, f'FIG 1  ·  run {R["run"]}  ·  成本按 OpenCode Go 单价由轨迹 token 计算  ·  自动评审 judge v3（Codex：截图 + 页面文本 + 工具记录）', fontsize=9.5, color=GRAY, ha='left')
fig.subplots_adjust(left=0.13, right=0.98, top=0.80, bottom=0.10, wspace=0.12)
fig.savefig(f'{RUN}/chartA.png', dpi=160); plt.close(fig)

# ---------- Chart B ----------
CAT = {'page_understanding': '页面理解', 'selection_ask': '划词提问*', 'translation': '页面翻译', 'browser_action_single': '单步操作',
       'browser_action_multistep': '多步操作', 'extraction_to_table': '抽取成表', 'research_multi_page': '多页调研', 'form_fill_no_submit': '填表不提交*',
       'cross_tab': '跨标签页*', 'memory_skill': '记忆/技能*', 'other': '其他'}
cats = [c for c in CAT if any(c in H[m]['by_category'] for m in order)]
cats.sort(key=lambda c: -H[HL]['by_category'].get(c, {}).get('pass_rate', 0))
nm_ = len(order); bh = 0.8 / nm_
fig, ax = plt.subplots(figsize=(11, 1.25 * len(cats) + 2.4))
for ci, c in enumerate(cats):
    base = (len(cats) - 1 - ci)
    for mi, m in enumerate(order):
        d = H[m]['by_category'].get(c)
        y = base + 0.4 - bh * (mi + 0.5)
        if not d:
            ax.text(1, y, f'{nm(m)}：未跑到', va='center', fontsize=9.5, color=LIGHT); continue
        v = d['pass_rate'] * 100
        ax.barh(y, v, height=bh * 0.86, color=col(m))
        ax.text(v + 1.2, y, f'{v:.0f}%  {nm(m)}  ({d["passed"]}/{d["n"]})', va='center', fontsize=9.5, color=ACC if m == HL else INK)
ax.set_yticks([len(cats) - 1 - i for i in range(len(cats))]); ax.set_yticklabels([CAT[c] for c in cats], fontsize=12.5)
ax.set_xlim(0, 150); ax.set_xticks([]); clean(ax)
bestcat = max([c for c in cats if not CAT[c].endswith('*')] or cats, key=lambda c: H[best]['by_category'].get(c, {}).get('pass_rate', 0))
worst = min(cats, key=lambda c: max(H[m]['by_category'].get(c, {}).get('pass_rate', 0) for m in order))
fig.suptitle(f'各模型都擅长{CAT[bestcat].rstrip("*")}（不计 * 类），{CAT[worst].rstrip("*")}是共同短板', x=0.02, ha='left', fontsize=17, y=0.985)
fig.text(0.02, 1 - 0.78 / fig.get_figheight(), f'按任务类别的通过率（同 {n_common} 题）；* 类别的前置步骤（划词、开标签页等）本轮 harness 未执行', fontsize=10.5, color=GRAY, ha='left')
fig.text(0.02, 0.25 / fig.get_figheight(), f'FIG 2  ·  run {R["run"]}  ·  括号内为 通过/题数', fontsize=9.5, color=GRAY, ha='left')
fig.subplots_adjust(left=0.14, right=0.98, top=1 - 1.15 / fig.get_figheight(), bottom=0.6 / fig.get_figheight())
fig.savefig(f'{RUN}/chartB.png', dpi=160); plt.close(fig)
print('ok')
