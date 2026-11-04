#!/bin/bash
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=$(cd "${1:?usage: finalize.sh <runDir>}" && pwd)
cd "$RUN"
find . -mindepth 2 -maxdepth 2 -name 'BYS-*.json' | grep -E '^\./[^_/][^/]*/BYS-D?[0-9]+\.json$' | grep -v '^\./judge/' | sed 's|^\./||' | sort > _to_judge.txt || true
echo "candidates: $(wc -l < _to_judge.txt) (fresh verdicts are skipped)"
node "$HERE/judge-list.mjs" "$RUN" "$RUN/_to_judge.txt" "${JUDGE_CONC:-4}" | tail -1
python3 "$HERE/analyze.py" "$RUN" > /dev/null && python3 "$HERE/charts.py" "$RUN"
