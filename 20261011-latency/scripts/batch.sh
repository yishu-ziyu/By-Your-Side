#!/bin/bash
cd /workspace/By-Your-Side
export EGO_ACCEPTANCE_CHROME=$(ls -d ~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome) SIDEAGENT_ACCEPTANCE_DIST=extension/dist
for spec in "$@"; do
  sc=${spec%%:*}; rest=${spec#*:}; rd=${rest%%:*}; fast=${rest#*:}; [ "$fast" = "$rest" ] && fast=""
  echo "=== $(date +%T) $sc r$rd fast=$fast"
  timeout 420 npx tsx /workspace/bys-trace/trace-run.mts --headless --scenario=$sc --round=$rd ${fast:+--fast=$fast} 2>&1 | grep -v "^    at" | tail -3
done
echo ALLDONE
