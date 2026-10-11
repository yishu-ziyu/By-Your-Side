# Offline: how well would a cheap regex router split read-only vs action on BYS's 225 real typed/voice task requests?
# Reference label = Jev lane from docs/evals/20260921-routing-experiment (a model label, NOT human ground truth).
import json, re, collections
d = json.load(open('/workspace/By-Your-Side/docs/evals/20260921-routing-experiment/task-requests.json'))
RO = {'page_question', 'answer', 'chat'}
ACTION = re.compile(r'打开|点击|点一下|填|输入|搜索|搜一下|发送|发给|下载|上传|翻译|圈|标出|标记|切换|切到|关闭|复制|保存|提交|登录|购买|下单|加入|删除|播放|暂停|滚动|新标签|navigate|open|click|search|fill|type|send|download|translate|go to|放进|整理成|做成|表格|导出|创建|添加|设置|改成|帮我')
QUESTION = re.compile(r'[？?]$|什么|怎么|为什么|是谁|多少|哪|吗[？?。]?$|总结|概括|解释|介绍|讲了|主要|核心|观点|summar|what|why|how|who|explain')
rows = []
for r in d:
    lane = (r.get('jev') or {}).get('lane'); t = r['text'].strip()
    if not lane or lane in ('steer', 'control', 'status', 'incomplete'): continue
    pred_ro = bool(QUESTION.search(t)) and not ACTION.search(t)
    rows.append((t, lane in RO, pred_ro, lane))
n = len(rows); tp = sum(1 for _, y, p, _ in rows if y and p); fp = sum(1 for _, y, p, _ in rows if p and not y)
fn = sum(1 for _, y, p, _ in rows if y and not p); pos = sum(1 for _, y, _, _ in rows if y)
print(json.dumps({'n': n, 'readonly_ref': pos, 'rules_pred_readonly': tp + fp, 'tp': tp, 'fp_action_sent_to_readonly': fp, 'fn_readonly_kept_on_full': fn,
                  'precision': round(tp / max(1, tp + fp), 3), 'recall': round(tp / max(1, pos), 3)}, ensure_ascii=False))
print('--- false positives (action/task-lane requests the rules would strip tools from):')
for t, y, p, lane in rows:
    if p and not y: print(' ', lane, '|', t[:90])
print('--- sample false negatives:')
for t, y, p, lane in [x for x in rows if x[1] and not x[2]][:12]: print(' ', lane, '|', t[:90])
