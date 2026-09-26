#!/usr/bin/env python3
"""Summarise jev-compare batches (out/jev-compare/<name>/results.jsonl) and evaluate the acceptance gate
of docs/evals/20260926-jev-narrow-questions.md.

Success, wrong writes and false completions come from the page oracles recorded by run.mts, never from
model output. A run with a network failure (a Jev request that still failed at the connection level or
timed out after the transport's own retry) is counted separately and left out of success rates.

Usage: python3 scripts/acceptance/jev-compare/analyze.py out/jev-compare/<name> [...] [--json summary.json]
"""
import json
import math
import sys
from collections import defaultdict

INFRA = ("等待超时：Chrome", "等待超时：SideAgent", "working tab did not open", "Chrome exited before ready", "isolated build failed")
LOOP_ACTION_TASKS = {"S5loop", "S6", "H1", "H2", "H3", "H4", "H5", "H6", "H7"}
GATE_TASKS = {"S5rt", "S5loop", "S6", "H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8"}


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def pct(values, q):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    i = (len(v) - 1) * q
    lo, hi = math.floor(i), math.ceil(i)
    return v[lo] + (v[hi] - v[lo]) * (i - lo)


def rate(k, n):
    return round(k / n, 3) if n else None


def main(argv):
    dirs = [a for a in argv if not a.startswith("--")]
    out_json = argv[argv.index("--json") + 1] if "--json" in argv else None
    if out_json in dirs:
        dirs.remove(out_json)
    runs = []
    for d in dirs:
        with open(f"{d}/results.jsonl") as f:
            runs += [json.loads(line) for line in f if line.strip()]

    groups = defaultdict(list)
    infra = []
    for r in runs:
        if r.get("error") and any(s in r["error"] for s in INFRA):
            infra.append(r)
            continue
        groups[(r["task"], r["arm"], r.get("extraTabs", 0))].append(r)

    summary = {}
    for key in sorted(groups):
        rs = groups[key]
        clean = [r for r in rs if not r.get("networkFailure")]
        ok = [r for r in clean if r.get("success")]
        lo, hi = wilson(len(ok), len(clean))
        ends = defaultdict(int)
        for r in rs:
            loop = r.get("loop") or {}
            if r.get("judge"):
                ends["/".join(j.get("tool") or (j.get("status", "?") + (":" + j["reasonCode"] if j.get("reasonCode") else "")) for j in r["judge"])] += 1
            elif loop.get("status"):
                ends[f"{loop['status']}:{loop.get('reasonCode') or '-'}"] += 1
            elif r.get("error"):
                ends["run-error"] += 1
        jev = [j for r in rs for j in r.get("jev", [])]
        jev_ok = [j["ms"] for j in jev if not j.get("error")]
        summary["/".join(map(str, key))] = {
            "task": key[0], "arm": key[1], "extraTabs": key[2], "n": len(rs),
            "networkFailureRuns": len(rs) - len(clean),
            "cleanN": len(clean), "success": len(ok), "rate": rate(len(ok), len(clean)), "ci95": [round(lo, 2), round(hi, 2)],
            "successAll": sum(1 for r in rs if r.get("success")),
            "wrongWrites": sum(r.get("wrongWrites") or 0 for r in rs),
            "falseDone": sum(1 for r in rs if r.get("falseDone")),
            "selfDoneOfSuccess": sum(1 for r in ok if r.get("selfDone")),
            "directDelivered": sum(1 for r in rs if r.get("directDelivery")),
            "taskMsP50": pct([r.get("taskMs") for r in clean], .5), "taskMsP90": pct([r.get("taskMs") for r in clean], .9),
            "jevRequests": len(jev), "jevPerRun": round(len(jev) / len(rs), 2) if rs else None,
            "jevBytesMean": round(sum(j.get("bytes") or 0 for j in jev) / len(jev)) if jev else None,
            "jevMsP50": pct(jev_ok, .5), "jevMsP90": pct(jev_ok, .9),
            "jevErrors": sum(1 for j in jev if j.get("error")),
            "retryRecovered": sum(1 for j in jev if j.get("retried") and not j.get("error")),
            "retriedStillFailed": sum(1 for j in jev if j.get("retried") and j.get("error")),
            "mainRequestsPerRun": round(sum(r.get("mainRequests", 0) for r in rs) / len(rs), 2) if rs else None,
            "jevCost": round(sum(r.get("jevCost", 0) for r in rs), 4), "mainCost": round(sum(r.get("mainCost", 0) for r in rs), 4),
            "loadP50": pct([r.get("loadavg1") for r in rs], .5),
            "ends": dict(ends),
        }

    print(f"{'cell':22} {'n':>3} {'net':>3} {'ok/clean':>9} {'rate':>5} {'ci95':>12} {'wrong':>5} {'fDone':>5} {'self':>4} {'p50 s':>6} {'p90 s':>6} {'jev/r':>5} {'KB':>5} {'jev p90':>7} {'rtry':>4} ends")
    for name, s in summary.items():
        f = lambda v: f"{v / 1000:6.1f}" if v is not None else "     -"
        print(f"{name:22} {s['n']:>3} {s['networkFailureRuns']:>3} {s['success']:>4}/{s['cleanN']:<4} {s['rate'] if s['rate'] is not None else '-':>5} {str(s['ci95']):>12} {s['wrongWrites']:>5} {s['falseDone']:>5} {s['selfDoneOfSuccess']:>4} {f(s['taskMsP50'])} {f(s['taskMsP90'])} {s['jevPerRun'] or 0:>5} {round((s['jevBytesMean'] or 0) / 1024, 1):>5} {s['jevMsP90'] or 0:>7.0f} {s['retryRecovered']:>4} {s['ends']}")

    # ── gate (new design) ──────────────────────────────────────────────────
    gate = {}
    cells = defaultdict(dict)
    for s in summary.values():
        cells[(s["task"], s["extraTabs"])][s["arm"]] = s
    worse = []
    for (task, tabs), arms in sorted(cells.items()):
        if "current" in arms and "new" in arms and arms["new"]["rate"] is not None and arms["current"]["rate"] is not None:
            if arms["new"]["rate"] < arms["current"]["rate"]:
                worse.append(f"{task}/tabs{tabs}: new {arms['new']['success']}/{arms['new']['cleanN']} < current {arms['current']['success']}/{arms['current']['cleanN']}")
    new_cells = [s for s in summary.values() if s["arm"] == "new"]
    e2e_cells = [s for s in summary.values() if s["arm"] in ("split", "direct")]
    combined = [s for s in new_cells if s["task"] in GATE_TASKS]
    comb_ok = sum(s["success"] for s in combined)
    comb_n = sum(s["cleanN"] for s in combined)
    action = [s for s in new_cells if s["task"] in LOOP_ACTION_TASKS]
    act_ok = sum(s["success"] for s in action)
    act_self = sum(s["selfDoneOfSuccess"] for s in action)
    new_runs = [r for r in runs if r["arm"] in ("new", "split", "direct")]
    jev_ms = [j["ms"] for r in new_runs for j in r.get("jev", []) if not j.get("error")]
    jev_all = [j for r in new_runs for j in r.get("jev", [])]
    gate = {
        "notWorseThanCurrent": {"pass": not worse, "worseCells": worse},
        "combinedSuccess": {"pass": comb_n > 0 and comb_ok / comb_n >= 0.9, "success": comb_ok, "n": comb_n, "rate": rate(comb_ok, comb_n), "ci95": [round(x, 3) for x in wilson(comb_ok, comb_n)]},
        "wrongWrites": {"pass": sum(s["wrongWrites"] for s in new_cells + e2e_cells) == 0, "count": sum(s["wrongWrites"] for s in new_cells + e2e_cells)},
        "falseDone": {"pass": sum(s["falseDone"] for s in new_cells + e2e_cells) == 0, "count": sum(s["falseDone"] for s in new_cells + e2e_cells)},
        "selfNeedsVerification": {"pass": act_ok > 0 and act_self / act_ok >= 0.9, "selfDone": act_self, "successfulActionRuns": act_ok, "rate": rate(act_self, act_ok)},
        "jevP90": {"pass": bool(jev_ms) and pct(jev_ms, .9) <= 1000, "p50Ms": pct(jev_ms, .5), "p90Ms": pct(jev_ms, .9), "maxMs": max(jev_ms) if jev_ms else None, "requests": len(jev_all),
                   "errors": sum(1 for j in jev_all if j.get("error")), "retryRecovered": sum(1 for j in jev_all if j.get("retried") and not j.get("error")),
                   "retriedStillFailed": sum(1 for j in jev_all if j.get("retried") and j.get("error"))},
        "networkFailureRuns": {arm: sum(1 for r in runs if r["arm"] == arm and r.get("networkFailure")) for arm in sorted({r["arm"] for r in runs})},
    }
    gate["allPass"] = all(v["pass"] for k, v in gate.items() if isinstance(v, dict) and "pass" in v)
    totals = {
        "runs": len(runs), "infraExcluded": len(infra), "infraErrors": [f"{r['task']}/{r['arm']}/r{r['round']}: {r['error'][:80]}" for r in infra],
        "cleanupNotPass": sum(1 for r in runs if r.get("cleanup") not in (None, "PASS")),
        "jevCost": round(sum(r.get("jevCost", 0) for r in runs), 4), "mainCost": round(sum(r.get("mainCost", 0) for r in runs), 4),
    }
    print(json.dumps({"gate": gate, "totals": totals}, ensure_ascii=False, indent=1))
    if out_json:
        with open(out_json, "w") as f:
            json.dump({"groups": summary, "gate": gate, "totals": totals}, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
