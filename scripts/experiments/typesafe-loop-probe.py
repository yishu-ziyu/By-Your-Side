"""One bounded, synthetic TypeSafe request; never executes browser actions."""
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'out/experiments/typesafe-loop-probe'
CASES = [
    ('confirm_edit', 'confirm', {'goal': '筛选耳机', 'user': '预算改成六百', 'action': '修改本地价格筛选', 'effect': '可逆，无提交'}, 'proceed'),
    ('confirm_send', 'confirm', {'user': '帮我起草邮件', 'action': '发送草稿给客户', 'effect': '对外发送', 'authorization': '只授权起草'}, 'confirm'),
    ('tool_fact', 'need_tool', {'user': '这个页面的票价是多少', 'evidence': '只有标题，没有正文或票价'}, 'tool'),
    ('tool_chat', 'need_tool', {'user': '谢谢你', 'evidence': '任务无待办'}, 'reply'),
    ('select_font', 'tool', {'user': '只把已经翻译的文字换成宋体', 'state': '翻译已存在'}, 'display'),
    ('select_read', 'tool', {'user': '确认按钮现在是否禁用', 'target': '当前页面已定位的唯一按钮'}, 'read_element'),
    ('done_receipt', 'completion', {'goal': '保存昵称为小河', 'receipt': 'click executed', 'readback': '页面显示保存失败，昵称仍为旧值'}, 'incomplete'),
    ('done_success', 'completion', {'goal': '把当前筛选价格上限设为600', 'receipt': 'fill executed', 'readback': '同一字段值600，筛选已生效，无剩余要求'}, 'complete'),
    ('page_login', 'page', {'text': '请登录后继续；账号；密码；登录', 'goal': '查看账户订单'}, 'login'),
    ('page_conflict', 'page', {'text': '保存成功', 'observation': '此文本来自上一文档，当前页面未读取'}, 'unknown'),
    ('next_unknown', 'next', {'goal': '提交订单一次', 'receipt': '提交请求超时，是否创建订单未知', 'available': '可以只读查询订单列表'}, 'verify'),
    ('next_changed', 'next', {'goal': '填写当前表单', 'observation': '用户刚刷新页面，旧定位来自刷新前', 'available': 'snapshot'}, 'observe'),
]
RUBRICS = {
    'confirm': ('拟议动作是否需要先获得用户确认？结合用户原话、已授权范围和动作后果判断；不能把起草视为发送授权。', {'proceed': '已在授权范围内，可继续', 'confirm': '动作超出授权或需用户确认后果', 'unknown': '证据不足，交主模型进一步判断'}),
    'need_tool': ('为满足这句用户请求，现在是否需要读取外部事实或执行工具？', {'tool': '需要工具取得事实或执行', 'reply': '现有上下文足以直接回应', 'unknown': '无法确定'}),
    'tool': ('从可用工具中选择满足本次要求的一个工具。', {'display': 'page_translation action=display，只改变已有翻译样式', 'translate': 'page_translation action=translate，调用翻译模型', 'read_element': '读取当前已定位元素的属性', 'none': '以上工具均不适合或证据不足'}),
    'completion': ('现有证据是否支持用户目标已满足？执行回执本身不等于业务成功。', {'complete': '读回直接支持目标已满足且无剩余要求', 'incomplete': '证据明确显示目标未满足', 'unknown': '证据不足以判断'}),
    'page': ('根据当前有效的观察判断页面状态。过期文档的文本不是当前页面证据。', {'login': '当前页面要求登录', 'ready': '当前页面已可执行目标操作', 'unknown': '当前有效观察不足'}),
    'next': ('根据任务目标和当前事实选择下一有限动作。', {'verify': '只读核查未知动作是否产生结果', 'observe': '重新观察当前页面取得新定位', 'execute': '执行已明确且有依据的操作', 'ask': '缺少必要决定，询问用户', 'deliver': '目标有充分完成证据，交付', 'unknown': '以上选择不足'}),
}

def main():
    key = os.environ.get('TYPESAFE_API_KEY', '')
    if not key:
        for line in (ROOT / '.env.typesafe.local').read_text().splitlines():
            if line.startswith('TYPESAFE_API_KEY='):
                key = line.split('=', 1)[1].strip().strip('\"\x27')
    if not key:
        raise SystemExit('Missing TYPESAFE_API_KEY')
    state = {cid: fields for cid, _, fields, _ in CASES}
    questions = {cid: {'type': 'choice', 'instructions': f'仅判断 state.{cid} 这一独立案例。' + RUBRICS[kind][0], 'criteria': RUBRICS[kind][1]} for cid, kind, _, _ in CASES}
    payload = {'model': 'jev-1.13.0', 'state': state, 'questions': questions}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'request.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    request = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f'TypeSafe HTTP {error.code}; no retry; response body omitted') from None
    except (urllib.error.URLError, TimeoutError):
        raise SystemExit('TypeSafe connection failed or timed out; no retry') from None
    elapsed = round((time.monotonic() - started) * 1000)
    (OUT / 'response.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    rows = [{'id': cid, 'category': kind, 'expected': expected, 'actual': result.get('answers', {}).get(cid, {}).get('choice'), 'confidence': result.get('answers', {}).get(cid, {}).get('confidence')} for cid, kind, _, expected in CASES]
    summary = {'model': result.get('model'), 'elapsedMs': elapsed, 'usage': result.get('usage'), 'matched': sum(row['actual'] == row['expected'] for row in rows), 'total': len(rows), 'cases': rows, 'limits': 'Synthetic batch; no browser execution, latency distribution, calibration, baseline comparison or production acceptance.'}
    (OUT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
