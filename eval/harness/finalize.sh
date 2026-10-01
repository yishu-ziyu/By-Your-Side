#!/bin/bash
# Judge every valid result of a run whose verdict is missing or stale (older judge version, or result
# rerun after it was judged), then rebuild report + charts. Works for any model spec directory.
# usage: finalize.sh <runDir>   (env: JUDGE_CONC = parallel codex judges, default 4)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=$(cd "${1:?usage: finalize.sh <runDir>}" && pwd)
cd "$RUN"
# <model slug>/BYS-NNN.json one level down; skip judge/ and parked dirs (_quota_errors, _contaminated*, _rerun_artifacts, ...)
find . -mindepth 2 -maxdepth 2 -name 'BYS-*.json' | grep -E '^\./[^_/][^/]*/BYS-[0-9]+\.json$' | grep -v '^\./judge/' | sed 's|^\./||' | sort > _to_judge.txt || true
echo "candidates: $(wc -l < _to_judge.txt) (fresh verdicts are skipped)"
node "$HERE/judge-list.mjs" "$RUN" "$RUN/_to_judge.txt" "${JUDGE_CONC:-4}" | tail -1
python3 "$HERE/analyze.py" "$RUN" > /dev/null && python3 "$HERE/charts.py" "$RUN"
