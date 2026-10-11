#!/bin/bash
cd /workspace/By-Your-Side
export EGO_ACCEPTANCE_CHROME=$(ls -d ~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome) SIDEAGENT_ACCEPTANCE_DIST=extension/dist
run(){ echo "=== $(date +%T) $*"; timeout 420 npx tsx /workspace/bys-trace/trace-run.mts --headless "$@" 2>&1 | grep -v "^    at" | tail -3; }
run --scenario=gist --round=0
run --scenario=gist --round=1
run --scenario=summary --round=3
run --scenario=summary --round=0 --fast=step-3.5-flash
run --scenario=action --round=0 --fast=step-3.5-flash
run --scenario=explain --round=0 --fast=step-3.5-flash
run --scenario=summary --round=0 --main=step-3.5-flash
run --scenario=gist --round=0 --main=step-3.5-flash
run --scenario=summary --round=4
run --scenario=summary --round=1 --fast=step-3.5-flash
echo ALLDONE
