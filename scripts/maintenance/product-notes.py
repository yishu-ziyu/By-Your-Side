#!/usr/bin/env python3
"""Render product records from archived samples; never substitute missing evidence."""
import csv
import hashlib
import html
import json
import statistics
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import matplotlib
matplotlib.use('Agg')
from matplotlib import pyplot as plt, font_manager

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = ROOT / 'docs/product'
BLUE, INK, GRAY, LIGHT, PAPER = '#245dcc', '#202b3a', '#647182', '#c3cbd5', '#fafbf9'
font = font_manager.FontProperties(family=['Arial Unicode MS', 'Noto Sans CJK SC', 'DejaVu Sans'])
plt.rcParams.update({'font.family': font_manager.FontProperties(fname=font_manager.findfont(font)).get_name(),
                     'svg.fonttype': 'path', 'svg.hashsalt': 'bys-product-notes', 'axes.unicode_minus': False})

STYLE = '''
:root{color-scheme:light;--ink:#202b3a;--muted:#647182;--blue:#245dcc;--line:#dce1e7;--paper:#fafbf9}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif}
main{max-width:1080px;margin:auto;padding:44px 40px 80px}a{color:var(--blue);text-underline-offset:4px}nav{display:flex;justify-content:space-between;gap:24px;align-items:center;padding-bottom:20px;border-bottom:1px solid var(--line);font-size:13px}
.brand{font-weight:650;letter-spacing:.03em;color:var(--ink);text-decoration:none}nav div{display:flex;gap:20px}.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}header{padding:54px 0 32px}h1{font-size:42px;line-height:1.25;font-weight:620;letter-spacing:-.045em;margin:14px 0 20px}h2{font-size:23px;line-height:1.4;margin:0 0 20px}h3{font-size:17px;margin:24px 0 8px}p{margin:0 0 16px}.lead{font-size:18px;max-width:650px;color:var(--muted)}section{padding:32px 0;border-top:1px solid var(--line)}.figure{width:100%;height:auto;display:block;background:white;border:1px solid var(--line)}.split{display:grid;grid-template-columns:1fr 1fr;gap:48px}.links{display:flex;gap:20px;flex-wrap:wrap;font-size:14px;margin:16px 0}.status{font-size:13px;color:var(--blue)}.meta{font-size:13px;color:var(--muted)}blockquote{margin:18px 0;padding:6px 0 6px 20px;border-left:2px solid var(--blue);font-size:20px;line-height:1.65}.entry{display:grid;grid-template-columns:145px 1fr;gap:28px}.entry .figure{margin-top:20px}.entry h2{font-size:29px;letter-spacing:-.02em;margin:8px 0 12px}.entry h2 a{color:var(--ink);text-decoration:none}.intro{max-width:620px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:13px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}th{color:var(--muted);font-weight:500}ul{padding-left:20px}li{margin:8px 0}details{margin:20px 0}summary{cursor:pointer;color:var(--blue)}pre{overflow:auto;background:#f0f3f6;padding:20px;font-size:12px}footer{padding-top:30px;font-size:12px;color:var(--muted)}.caption{margin-top:10px;color:var(--muted);font-size:13px}.copy{font-size:20px;max-width:770px}.count{font-size:48px;font-variant-numeric:tabular-nums;color:var(--blue);line-height:1.1;margin-bottom:14px}@media(max-width:720px){main{padding:24px 20px 60px}h1{font-size:34px}header{padding:36px 0 24px}.entry,.split{grid-template-columns:1fr;gap:16px}nav{align-items:flex-start}nav div{gap:12px;flex-wrap:wrap}.entry h2{font-size:25px}table{font-size:12px}th,td{padding:10px 5px}}@media print{nav,.links{display:none}main{max-width:none;padding:0}section{break-inside:avoid}details>*{display:block}body{background:white}}
'''

def esc(value):
    return html.escape(str(value), quote=True)

def document(title, body, back='../../index.html'):
    return f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)} · By Your Side</title><style>{STYLE}</style><main><nav><a class="brand" href="{back}">BY YOUR SIDE / 产品记录</a><div><a href="{back}#optimizations">优化</a><a href="{back}#perspectives">理解</a><a href="{back}#directions">跟进</a></div></nav>{body}<footer>本地产品档案 · 数据图由归档样本生成 · 对外引用请保留测试条件</footer></main></html>'

def read_evidence(folder, record):
    data = {}
    for name, source in record['evidence'].items():
        path = folder / source['path']
        payload = path.read_bytes()
        if hashlib.sha256(payload).hexdigest() != source['sha256']:
            raise ValueError(f'{path}: evidence digest changed')
        data[name] = json.loads(payload)
    for name in ['before', 'after', 'confirmed']:
        if data[name]['status'] != 'PASS':
            raise ValueError(f'{folder}: {name} did not pass')
    if data['negative']['status'] != 'FAIL':
        raise ValueError(f'{folder}: negative regression did not fail')
    return data

def metrics_from(record, data):
    metrics = []
    for spec in record['metrics']:
        item = dict(spec)
        for version in ['before', 'after']:
            values = []
            for run in data[version]['rounds']:
                if spec['kind'] == 'elapsed':
                    value = run['elapsedMs']
                else:
                    matches = [e for e in run['stages'][spec['area']] if e['name'] == spec['measure']]
                    if len(matches) != 1:
                        raise ValueError(f'{record["id"]}: ambiguous {spec["measure"]}')
                    value = matches[0]['ms']
                if not isinstance(value, (int, float)) or not 0 < value < float('inf'):
                    raise ValueError('Duration must be positive and finite')
                values.append(value)
            if len(values) != record['conditions']['runsPerVersion']:
                raise ValueError('Sample count differs from declared conditions')
            item[version] = values
            item[version + 'Median'] = statistics.median(values)
        item['reductionPercent'] = 100 * (1 - item['afterMedian'] / item['beforeMedian'])
        metrics.append(item)
    return metrics

def save_figure(fig, export, name):
    export.mkdir(exist_ok=True)
    fig.savefig(export / f'{name}.svg', facecolor=PAPER, metadata={'Date': None})
    fig.savefig(export / f'{name}.png', facecolor=PAPER, dpi=180)
    plt.close(fig)

def summary_chart(record, metrics, export):
    main = next(m for m in metrics if m.get('primary'))
    fig = plt.figure(figsize=(12, 8), facecolor=PAPER)
    fig.text(.06, .94, f'BY YOUR SIDE  /  OPTIMIZATION {record["number"]}', fontsize=12, color=GRAY)
    fig.text(.06, .85, record['title'], fontsize=27, color=INK)
    fig.text(.06, .79, '相同长会话负载 · 恢复完成后才报告就绪', fontsize=13, color=GRAY)
    fig.text(.78, .83, f'−{main["reductionPercent"]:.0f}%', fontsize=54, color=BLUE, ha='center')
    fig.text(.78, .77, '重载等待中位数', fontsize=12, color=GRAY, ha='center')
    fig.text(.06, .68, main['label'], fontsize=17, color=INK)
    ax = fig.add_axes([.17, .42, .72, .20], facecolor=PAPER)
    seconds = [main['beforeMedian'] / 1000, main['afterMedian'] / 1000]
    ax.barh([1, 0], seconds, height=.32, color=[LIGHT, BLUE], zorder=3)
    ax.set_yticks([1, 0], ['之前', '现在'], fontsize=13, color=INK)
    ceiling = max(1.5, max(seconds) * 1.35)
    ax.set_xlim(0, ceiling)
    ax.set_xlabel('秒', fontsize=11, color=GRAY, loc='right')
    ax.tick_params(axis='x', labelsize=11, colors=GRAY)
    for y, value in zip([1, 0], seconds):
        ax.text(value + .035, y, f'{value:.3f} s', va='center', fontsize=16, color=INK)
    ax.grid(axis='x', color='#e1e6eb', zorder=0)
    ax.tick_params(axis='both', length=0, pad=10)
    for spine in ax.spines.values():
        spine.set_visible(False)
    for x, metric in zip([.06, .53], [m for m in metrics if not m.get('primary')]):
        fig.text(x, .30, metric['label'], fontsize=13, color=GRAY)
        fig.text(x, .24, f'{metric["beforeMedian"]:.0f} → {metric["afterMedian"]:.0f} ms', fontsize=26, color=INK)
        fig.text(x, .19, f'中位数缩短 {metric["reductionPercent"]:.0f}%', fontsize=12, color=BLUE)
    c = record['conditions']
    fig.text(.06, .105, f'{c["conversations"]} 段会话 × {c["recordKiB"]} KiB  ·  每版 {c["runsPerVersion"]} 次  ·  隔离 Chrome + 本机脚本模型', fontsize=11, color=GRAY)
    fig.text(.06, .065, '前后独立运行；侧栏计时含驱动开销。不代表远端模型速度。完整样本见配套图。', fontsize=10, color=GRAY)
    save_figure(fig, export, 'summary')

def samples_chart(metrics, export):
    metric = next(m for m in metrics if m.get('primary'))
    fig, ax = plt.subplots(figsize=(12, 4.3), facecolor=PAPER)
    fig.subplots_adjust(left=.13, right=.93, top=.70, bottom=.25)
    ax.set_facecolor(PAPER)
    fig.text(.06, .88, '每次原始样本，全数保留', fontsize=23, color=INK)
    fig.text(.06, .79, '每个点是一轮重载；短线标记中位数。没有把前后轮次当作配对实验。', fontsize=11, color=GRAY)
    jitter = [-.05, .04, -.02, .07, -.07]
    for version, y, color in [('before', 1, '#8996a6'), ('after', 0, BLUE)]:
        ax.scatter(metric[version], [y + jitter[i % len(jitter)] for i in range(len(metric[version]))], s=80, color=color, alpha=.85, zorder=3)
        median = metric[version + 'Median']
        ax.plot([median, median], [y - .19, y + .19], lw=3, color=INK, zorder=4)
    ax.set_yticks([1, 0], ['之前', '现在'], fontsize=12)
    ax.set_ylim(-.45, 1.45)
    ax.set_xlim(0, max(metric['before'] + metric['after']) * 1.13)
    ax.grid(axis='x', color='#e1e6eb')
    ax.set_xlabel('重载到侧栏可用 / 毫秒', fontsize=11, color=GRAY, labelpad=8)
    ax.tick_params(length=0, pad=8, colors=GRAY)
    for spine in ax.spines.values():
        spine.set_visible(False)
    fig.text(.06, .06, '这是小样本下的中位数改善；新版也存在更慢的单次结果，不能据此推断 P95。', fontsize=11, color=GRAY)
    save_figure(fig, export, 'samples')

def render_case(folder):
    record = json.loads((folder / 'record.json').read_text())
    data = read_evidence(folder, record)
    metrics = metrics_from(record, data)
    export = folder / 'exports'
    summary_chart(record, metrics, export)
    samples_chart(metrics, export)
    (export / 'metrics.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + '\n')
    with (export / 'samples.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['metric', 'version', 'run', 'milliseconds'])
        for metric in metrics:
            for version in ['before', 'after']:
                for index, value in enumerate(metric[version]):
                    writer.writerow([metric['id'], version, index + 1, value])
    primary = next(m for m in metrics if m.get('primary'))
    c = record['conditions']
    copy = f'在 {c["conversations"]} 段长会话的隔离测试中，By Your Side 重载至侧栏可用的中位耗时从 {primary["beforeMedian"]/1000:.2f} 秒降至 {primary["afterMedian"]/1000:.2f} 秒，缩短约 {primary["reductionPercent"]:.0f}%。旧会话仍可继续，任务不会因重启自行执行。'
    rows = ''.join(f'<tr><td>{esc(m["label"])}</td><td>{m["beforeMedian"]:.1f} ms</td><td>{m["afterMedian"]:.1f} ms</td><td>−{m["reductionPercent"]:.1f}%</td></tr>' for m in metrics)
    sample_rows = ''.join(f'<tr><td>{i+1}</td><td>{a:.1f} ms</td><td>{b:.1f} ms</td></tr>' for i, (a, b) in enumerate(zip(primary['before'], primary['after'])))
    bullets = lambda values: '<ul>' + ''.join(f'<li>{esc(v)}</li>' for v in values) + '</ul>'
    body = f'''<header><div class="eyebrow">Optimization {record['number']} / {record['date']}</div><h1>{esc(record['title'])}</h1><p class="lead">{esc(record['problem'])}</p><div class="status">{esc(record['status'])}</div></header>
<img class="figure" src="exports/summary.svg" alt="重载到侧栏可用的中位耗时前后对比">
<div class="links"><a download href="exports/summary.png">下载宣发图 PNG</a><a download href="exports/summary.svg">下载矢量图 SVG</a><a href="exports/samples.csv">全部样本 CSV</a></div>
<section class="split"><div><h2>这次改变了什么</h2>{bullets(record['changes'])}</div><div><h2>稳定性守住了什么</h2>{bullets(record['validation'])}</div></section>
<section><h2>每次测量都留下来</h2><img class="figure" src="exports/samples.svg" alt="前后各五次的重载耗时散点分布"><p class="caption">{esc(c['order'])}。{esc(c['interpretation'])}</p><details><summary>展开全部数值与口径</summary><table><tr><th>指标</th><th>之前的中位数</th><th>现在的中位数</th><th>变化</th></tr>{rows}</table><h3>重载到侧栏可用</h3><table><tr><th>各自运行序号</th><th>之前</th><th>现在</th></tr>{sample_rows}</table><p class="caption">{esc(c['timingOrigin'])}</p></details></section>
<section><h2>可以怎样对外讲</h2><p class="copy">{esc(copy)}</p><p class="meta">引用条件：每段 {c['recordKiB']} KiB，每版 {c['runsPerVersion']} 次，{esc(c['environment'])}。</p>{bullets(record['limits'])}</section>
<section><h2>下一步验证</h2><p>{esc(record['followup'])}</p><a href="../../perspectives/2026-10-31-speed-and-effort.html">这次讨论留下的产品理解 →</a></section>
<details><summary>原始证据与复现</summary><div class="links"><a href="evidence/before.json">旧版原件</a><a href="evidence/after.json">新版原件</a><a href="evidence/confirmed.json">最终回归</a><a href="evidence/negative.json">旧版失败断言</a><a href="evidence/restart.txt">重启恢复检查</a></div><p class="meta">{esc(record['source'])}<br>旧版 {record['baseline']} → 新版 {record['implementation']}；不是商店发布记录。</p><pre>{esc(record['reproduce'])}</pre></details>'''
    (folder / 'index.html').write_text(document(record['title'], body))
    markdown = f'''# {record['title']}

<!-- Generated by product:build from record.json and evidence/. -->

{record['date']} · Optimization {record['number']} · {record['status']}

{copy}

[可视化案例](index.html) · [宣发图 SVG](exports/summary.svg) · [完整样本图](exports/samples.svg) · [样本 CSV](exports/samples.csv)

## 改变与验证

''' + '\n'.join('- ' + s for s in record['changes'] + record['validation']) + f'''

## 数据口径

{c['conversations']} 段会话，每段 {c['recordKiB']} KiB；每版 {c['runsPerVersion']} 次，取中位数。{c['environment']}。{c['order']}。

{c['timingOrigin']}

| 指标 | 之前 | 现在 | 中位数缩短 |
|---|---:|---:|---:|
''' + '\n'.join(f'| {m["label"]} | {m["beforeMedian"]:.1f} ms | {m["afterMedian"]:.1f} ms | {m["reductionPercent"]:.1f}% |' for m in metrics) + '\n\n' + '\n'.join('- ' + s for s in record['limits']) + '''

## 证据与跟进

[旧版原件](evidence/before.json) · [新版原件](evidence/after.json) · [最终回归](evidence/confirmed.json) · [旧版失败断言](evidence/negative.json) · [重启恢复](evidence/restart.txt)。

''' + record['followup'] + '\n\n[产品理解](../../perspectives/2026-10-31-speed-and-effort.md) · [返回产品记录](../../README.md)\n'
    (folder / 'README.md').write_text(markdown)
    return record, primary

def prose_pages():
    sources = [PRODUCT / 'README.md', *(PRODUCT / 'perspectives').glob('*.md'), *(PRODUCT / 'directions').glob('*.md'), *(PRODUCT / 'templates').glob('*.md')]
    payload = {str(path): path.read_text() for path in sources}
    javascript = "import {marked} from 'marked';let data='';for await(const c of process.stdin)data+=c;process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(data)).map(([p,s])=>[p,marked.parse(s)]))))"
    rendered = json.loads(subprocess.run(['node', '--input-type=module', '-e', javascript], input=json.dumps(payload), text=True, capture_output=True, check=True, cwd=ROOT).stdout)
    for path in sources:
        title = path.read_text().splitlines()[0].removeprefix('# ')
        body = rendered[str(path)]
        # The browser reader links to generated local pages; Markdown remains the editable original.
        import re
        def link(match):
            href = html.unescape(match.group(1))
            parsed = urlparse(href)
            if parsed.scheme or not parsed.path.endswith('.md'):
                return match.group(0)
            target = (path.parent / parsed.path).resolve()
            if not target.is_relative_to(PRODUCT):
                return match.group(0)
            name = 'index.html' if target.parent.parent.name == 'optimizations' else 'guide.html'
            replacement = str(Path(parsed.path).with_name(name)) if target.name == 'README.md' else str(Path(parsed.path).with_suffix('.html'))
            return f'href="{esc(replacement)}"'
        body = re.sub(r'href="([^"]+)"', link, body)
        dest = path.with_name('guide.html') if path.name == 'README.md' else path.with_suffix('.html')
        back = 'index.html' if path.parent == PRODUCT else '../index.html'
        dest.write_text(document(title, f'<article>{body}</article><div class="links"><a href="{path.name}">Markdown 原文</a></div>', back))

def main():
    cases = [render_case(path.parent) for path in sorted((PRODUCT / 'optimizations').glob('*/record.json'), reverse=True)]
    entries = ''
    for record, metric in cases:
        href = f'optimizations/{record["id"]}/'
        entries += f'''<section class="entry"><div><div class="eyebrow">{record['date']}</div><p class="meta">Optimization {record['number']}</p></div><div><div class="status">{esc(record['status'])}</div><h2><a href="{href}index.html">{esc(record['title'])} →</a></h2><p class="intro">{esc(record['problem'])}</p><img class="figure" src="{href}exports/summary.svg" alt="{esc(record['title'])}的实测前后对比"><div class="links"><a href="{href}index.html">完整案例与原始样本</a><a download href="{href}exports/summary.png">保存宣发图</a></div></div></section>'''
    perspectives = ''.join(f'<li><a href="perspectives/{p.stem}.html">{esc(p.read_text().splitlines()[0].removeprefix("# "))}</a></li>' for p in sorted((PRODUCT / 'perspectives').glob('*.md'), reverse=True))
    body = f'''<header><div class="eyebrow">Product notes / 持续积累</div><h1>产品怎样一步步变好。</h1><p class="lead">保存每次优化的证据，也保存当时的理解。<br>从“为什么改”，到“改得怎样”，再到“下一步想验证什么”。</p></header>
<div id="optimizations">{entries}</div>
<section id="perspectives" class="split"><div><div class="eyebrow">Perspectives / 产品理解</div><h2>把当时的判断留下来。</h2><p>原话、已确认的规则与整理者的理解分开保存。新观点链接旧记录。</p><ul>{perspectives}</ul></div><div><blockquote>“关于连接中的话，要给出具体的缩短时间方案，然后来验证。”</blockquote><p class="meta">用户原话 · 2026-10-31</p></div></section>
<section id="directions" class="split"><div><div class="eyebrow">Next / 待验证</div><h2>真实日常数据上，能少等多久？</h2><p>隔离实验已看到改善，下一步需要日常负载、较长历史和较低性能设备上的证据。这里保存问题与跟进，不把待验证想法写成已上线功能。</p><a href="directions/guide.html">查看跟进 →</a></div><div><h2>继续把理解留在这里。</h2><p>以前如何判断，现在为什么改变，未来准备怎样验证。旧观点保留，新观点链接回来。</p><div class="links"><a href="templates/perspective.html">理解记录模板</a><a href="guide.html">如何添加下一条记录</a><a href="../STATUS.md">产品当前状态</a></div></div></section>'''
    (PRODUCT / 'index.html').write_text(document('产品记录', body, 'index.html'))
    prose_pages()
    print(f'已生成 {len(cases)} 条优化记录：本地总览、SVG、PNG、全部样本与可引用文案。')

if __name__ == '__main__':
    main()
