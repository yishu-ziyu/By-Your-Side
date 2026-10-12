import analyze as A
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'Noto Sans CJK JP', 'DejaVu Sans']
plt.rcParams['font.size'] = 13

C = {'wait': '#7f8c8d', 'think': '#f39c12', 'out': '#2e86de', 'tool': '#27ae60', 'read': '#8e44ad',
     'bg': '#d5d8dc', 'dbg': '#f5b7b1'}
TOOL = {'tabs': '切换标签页', 'js': '在页面里跑代码', 'fetch': '抓取整页', 'navigate': '打开页面',
        'browser_run': '一组浏览器操作', 'send_user_message': '单独发消息'}
BG = {'goal_check': '后台：核对目标', 'memory:date': '后台：记忆·日期', 'memory:habit': '后台：记忆·习惯'}

# 每张图：标题、要画的竖线、浪费段标注 (起, 止, 文字)
SPEC = {
 'summary-r0': ('一轮答完：8 秒出字，调试横幅却挂到 16.5 秒', ['first', 'done'], []),
 'summary-r2': ('一轮本可答完，模型重读了 3 轮：55 秒才出字', ['first'],
                [(1.9, 41.3, '重读 3 轮（切标签页 → 跑代码 → 抓整页）≈ 39 秒，工具只用 0.3 秒')]),
 'summary-r3': ('第一轮就能答，又读了 2 轮：22 秒才答完', ['first', 'done'],
                [(1.9, 16.8, '重读 2 轮（跑代码 ×2）≈ 15 秒')]),
 'summary-fast-r1': ('又抓了两次整页：42 秒才出字', ['first'],
                     [(2.3, 30.1, '重读 2 轮（抓整页 ×2）≈ 28 秒')]),
 'action-r0': ('想了 19.5 秒才去打开页面：30 秒做完', ['page', 'done'],
               [(3.0, 22.5, '决定打开哪一页，模型想了 19.5 秒（没有设思考档）')]),
 'action-r1': ('顺利的一次：8 秒打开页面，15 秒做完；后台又跑了 16 秒', ['page', 'done'],
               [(14.8, 30.3, '做完后调试横幅还挂 15 秒')]),
 'action-r2': ('页面 17 秒就打开了，面板却等到 48 秒', ['page', 'done'],
               [(18.3, 48.4, '程序里打开页面没有网址，空等 30 秒')]),
 'action-fast-r0': ('页面 11 秒就打开了，模型又自己确认了 20 秒', ['page', 'done'],
                    [(11.5, 31.0, '再确认一遍 + 单独发消息一轮 ≈ 20 秒')]),
 'explain-r0': ('划词解释 8.4 秒出字，其中 6.2 秒在思考', ['first'], []),
 'explain-fast-r0': ('快速模型 6.1 秒出字，仍有 4.1 秒在思考', ['first'], []),
}

def seglabel(ax, y, s, d, col, light=False, minw=1.0):
    if d >= minw:
        ax.text(s + d / 2, y, f'{d:.1f}秒', ha='center', va='center', fontsize=11,
                color='#555' if light else 'white', fontweight='bold')

XMAX = [60]
def draw(run):
    title, lines, waste = SPEC[run]
    m, r, tr, calls = A.metrics(run)
    lanes = []  # (label, [(s,d,color,hatch,light)])
    if m['preObsMs']:
        po = next(x for x in tr if x['type'] == 'pre_observation')
        lanes.append(('读页面（经调试器）', [((po['t'] - m['preObsMs']) / 1e3, m['preObsMs'] / 1e3, C['read'], None, False)]))
    tools = {}
    for x in tr:
        if x['type'] == 'tool_execution_start': tools[x['data']['toolCallId']] = (x['t'], x['data']['toolName'])
        if x['type'] == 'tool_execution_end' and x['data']['toolCallId'] in tools:
            s, n = tools[x['data']['toolCallId']]
            lanes.append((f'工具：{TOOL.get(n, n)}', [(s / 1e3, max(x['t'] - s, 120) / 1e3, C['tool'], None, False)]))
    k = 0
    for c in calls:
        fe = c.get('firstReasoning') or c.get('outStart') or c['end']
        bg = c['purpose'] in BG
        parts = [(c['start'], fe - c['start'], 'wait')]
        if c.get('firstReasoning'): parts.append((c['firstReasoning'], (c['outStart'] or c['end']) - c['firstReasoning'], 'think'))
        if c.get('outStart'): parts.append((c['outStart'], max(c['end'] - c['outStart'], 120), 'out'))
        if bg:
            segs = [(s / 1e3, d / 1e3, C['bg'], '//', True) for s, d, _ in parts]
            lab = BG[c['purpose']]
        else:
            k += 1
            segs = [(s / 1e3, d / 1e3, C[t], None, False) for s, d, t in parts]
            lab = '模型回答' if c['purpose'] == 'explain' else f'模型第 {k} 轮'
        lanes.append((lab, segs))
    lanes.sort(key=lambda l: l[1][0][0])
    spans = []; a = None
    for kk, t in m['debugger']:
        if kk == 'attach' and a is None: a = t
        if kk == 'detach' and a is not None: spans.append((a / 1e3, (t - a) / 1e3)); a = None
    if spans:
        lanes.insert(0, ('调试横幅', [(s, d, C['dbg'], None, True) for s, d in spans]))

    n = len(lanes)
    XMAX[0] = max(s + d for _, segs in lanes for s, d, *_ in segs) + 1.5
    fig, ax = plt.subplots(figsize=(15, 2.2 + 0.62 * n + (0.9 if waste else 0)))
    for y, (lab, segs) in enumerate(lanes):
        for s, d, col, hatch, light in segs:
            ax.barh(y, d, left=s, color=col, height=0.62, hatch=hatch, edgecolor='#aab0b5' if hatch else col, lw=0.6)
            seglabel(ax, y, s, d, col, light, max(1.0, XMAX[0] * 0.045))
    ax.set_yticks(range(n)); ax.set_yticklabels([l[0] for l in lanes])
    for t in ax.get_yticklabels():
        if t.get_text().startswith('后台'): t.set_color('#888')
    ax.set_ylim(n - 0.4, -1.9 if waste else -0.8)
    xmax = max(s + d for _, segs in lanes for s, d, *_ in segs) + 1.5
    ax.set_xlim(0, xmax)
    marks = {'first': ('出字', m.get('firstText'), '#1f5fa8'),
             'page': ('页面打开', m.get('pageOpened'), '#1e8449'),
             'done': ('面板做完', m.get('uiDoneReal'), '#6c3483')}
    for key in lines:
        lab, t, col = marks[key]
        if t is None: continue
        ax.axvline(t / 1e3, color=col, ls='--', lw=1.6)
        ax.text(t / 1e3, n - 0.45, f' {lab} {int(t/100+0.5)/10:.1f}秒', color=col, fontsize=12, fontweight='bold', va='bottom', ha='left')
    for s, e, txt in waste:
        y = -1.05
        ax.annotate('', xy=(s, y), xytext=(e, y), arrowprops=dict(arrowstyle='|-|', color='#c0392b', lw=2))
        ax.text((s + e) / 2, y - 0.12, txt, ha='center', va='bottom', color='#c0392b', fontsize=12, fontweight='bold')
    ax.set_xlabel('发送后的秒数')
    ax.set_title(title, fontsize=17, fontweight='bold', loc='left', pad=12)
    ax.grid(axis='x', alpha=.25)
    for sp in ('top', 'right'): ax.spines[sp].set_visible(False)
    leg = [Patch(color=C['wait'], label='等模型回应'), Patch(color=C['think'], label='模型思考'),
           Patch(color=C['out'], label='输出')]
    if any(l[0].startswith('工具') for l in lanes): leg.append(Patch(color=C['tool'], label='工具执行'))
    if m['preObsMs']: leg.append(Patch(color=C['read'], label='读页面'))
    if spans: leg.append(Patch(color=C['dbg'], label='调试横幅'))
    if any(l[0].startswith('后台') for l in lanes):
        leg.append(Patch(facecolor=C['bg'], hatch='//', edgecolor='#aab0b5', label='后台调用（不挡出字）'))
    fig.legend(handles=leg, loc='lower center', ncol=len(leg), frameon=False, fontsize=12)
    fig.tight_layout(rect=(0, 0.07 if n > 3 else 0.12, 1, 1))
    out = f'/workspace/bys-trace/{run}-v2.png'
    fig.savefig(out, dpi=120); plt.close(fig)
    return out

if __name__ == '__main__':
    import sys
    for run in sys.argv[1:] or SPEC:
        print(draw(run))
