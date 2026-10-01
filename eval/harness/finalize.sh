#!/bin/bash
# Judge every valid result of a run whose verdict is missing or stale (older judge version, or result
# rerun after it was judged), then rebuild report + charts.
# usage: finalize.sh <runDir>   (env: JUDGE_CONC = parallel codex judges, default 4)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=$(cd "${1:?usage: finalize.sh <runDir>}" && pwd)
cd "$RUN"
find . -path ./_quota_errors -prune -o -path './_contaminated*' -prune -o -path ./_rerun_artifacts -prune -o -regextype posix-extended -regex '\./opencode-go[^/]*/BYS-[0-9]+\.json' -print | sed 's|^\./||' | sort > _to_judge.txt
echo "candidates: $(wc -l < _to_judge.txt) (fresh verdicts are skipped)"
node "$HERE/judge-list.mjs" "$RUN" "$RUN/_to_judge.txt" "${JUDGE_CONC:-4}" | tail -1
python3 "$HERE/analyze.py" "$RUN" > /dev/null && python3 "$HERE/charts.py" "$RUN"
