"""Frozen completion judgment replay; credentials and labels never enter state."""
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]

def encode(value):
    return json.dumps(value, ensure_ascii=False, indent=2)

def main():
    question = json.loads((ROOT / 'eval/typesafe/completion-question.json').read_text())
    cases = json.loads((ROOT / 'eval/typesafe/real-failures.json').read_text())
    cases += json.loads((ROOT / 'eval/typesafe/counterfactuals.json').read_text())
    assert 1 <= len(cases) <= 24
    assert len({c['id'] for c in cases}) == len(cases)
    for case in cases:
        assert case['expected'] in question['criteria']
        assert len(encode(case['state'])) < 12000
    out = ROOT / 'out/experiments' / ('typesafe-real-' + time.strftime('%Y%m%d-%H%M%S'))
    out.mkdir(parents=True, exist_ok=False)
    frozen = {'question': question, 'cases': cases, 'model': 'jev-1.13.0', 'repeats': 2, 'confidenceThreshold': 0.9}
    (out / 'frozen.json').write_text(encode(frozen))
    fingerprint = hashlib.sha256(encode(frozen).encode()).hexdigest()
    key = os.environ.get('TYPESAFE_API_KEY', '')
    if not key:
        for line in (ROOT / '.env.typesafe.local').read_text().splitlines():
            if line.startswith('TYPESAFE_API_KEY='):
                key = line.split('=', 1)[1].strip().strip('\"\x27')
    if not key:
        raise SystemExit('Missing TypeSafe credential')

    def evaluate(case, repeat):
        payload = {'model': frozen['model'], 'state': case['state'], 'questions': {'verdict': question}}
        row = {'id': case['id'], 'repeat': repeat, 'provenance': case['provenance'], 'expected': case['expected']}
        start = time.monotonic()
        try:
            request = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=encode(payload).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(request, timeout=25) as response:
                raw = json.load(response)
            answer = raw['answers']['verdict']
            assert answer['choice'] in question['criteria']
            assert isinstance(answer['confidence'], (int, float)) and 0 <= answer['confidence'] <= 1
            row.update(actual=answer['choice'], confidence=answer['confidence'], raw=raw)
        except urllib.error.HTTPError as error:
            row['error'] = f'http_{error.code}'
        except Exception as error:
            row['error'] = type(error).__name__  # no server body or request headers in logs
        row['elapsedMs'] = round((time.monotonic() - start) * 1000)
        (out / f"{case['id']}-{repeat}.json").write_text(encode(row))
        return row

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(evaluate, case, repeat) for case in cases for repeat in (1, 2)]
        rows = [job.result() for job in jobs]
    groups = {}
    for kind in sorted({c['provenance'] for c in cases}):
        subset = [r for r in rows if r['provenance'] == kind]
        valid = [r for r in subset if 'actual' in r]
        high = [r for r in valid if r['confidence'] >= 0.9]
        groups[kind] = {'requests': len(subset), 'valid': len(valid), 'matched': sum(r['actual'] == r['expected'] for r in valid), 'falseSatisfied': sum(r['actual'] == 'satisfied' and r['expected'] != 'satisfied' for r in valid), 'missedSatisfied': sum(r['expected'] == 'satisfied' and r['actual'] != 'satisfied' for r in valid), 'abstained': sum(r['actual'] == 'insufficient' for r in valid), 'highConfidence': len(high), 'highConfidenceErrors': sum(r['actual'] != r['expected'] for r in high)}
    mismatches = [{k: r[k] for k in ('id', 'repeat', 'expected', 'actual', 'confidence')} for r in rows if 'actual' in r and r['actual'] != r['expected']]
    stable = sum(len({r.get('actual', 'ERROR') for r in rows if r['id'] == c['id']}) == 1 and all('actual' in r for r in rows if r['id'] == c['id']) for c in cases)
    times = sorted(r['elapsedMs'] for r in rows if 'actual' in r)
    tokens = sum(r.get('raw', {}).get('usage', {}).get('input_tokens', 0) for r in rows)
    summary = {'fingerprint': fingerprint, 'model': frozen['model'], 'cases': len(cases), 'groups': groups, 'stableCases': stable, 'mismatches': mismatches, 'errors': [r for r in rows if 'error' in r], 'latencyMs': {'p50': times[math.ceil(len(times)*0.5)-1] if times else None, 'p95': times[math.ceil(len(times)*0.95)-1] if times else None}, 'inputTokens': tokens, 'estimatedUSD': tokens * 0.042 / 1000000, 'output': str(out)}
    (out / 'summary.json').write_text(encode(summary))
    print(encode(summary))

if __name__ == '__main__':
    main()
