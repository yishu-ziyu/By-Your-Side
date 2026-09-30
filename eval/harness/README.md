# BYS eval harness

One command (3 models x 3 tasks, 3 at a time, then judge + summary):

    node eval/harness/run.mjs --tasks BYS-001,BYS-040,BYS-081 --concurrency 3 --run-id my-run

Resume missing/invalid results of a run: node eval/harness/run.mjs --resume --run-id full-1 --concurrency 3
Flags: --models a,b,c (default: opencode-go/mimo-v2.6-flash, deepseek-v4-flash, deepseek-v4.1-flash)
       --tasks ids (default: all 141) --concurrency N (default min(6, jobs)) --cap-sec 240
       --no-judge  --keep-work  --dry-run (set up Chrome/panel/companion only, no prompt)
Judge the unjudged results of a run, then rebuild report + charts: eval/harness/finalize.sh eval/runs/<run-id>
Re-group failure reasons (codex):   python3 eval/harness/cluster.py eval/runs/<run-id>  (then finalize.sh again)
Model sanity check:     cp eval/harness/model-check.mts agent/.mc.mts && node node_modules/tsx/dist/cli.mjs agent/.mc.mts opencode-go/deepseek-v4-flash; rm agent/.mc.mts

Paths (see paths.mjs): BYS_REPO (default: this repo), BYS_TASKS (default eval/tasks/tasks.jsonl),
BYS_RUNS_DIR (default eval/runs), BYS_WORK_ROOT (default $TMPDIR/bys-harness), BYS_NODE (default: current node),
BYS_CJK_FONT (charts.py), JUDGE_CONC (finalize.sh, default 4).

Each job = fresh Xvfb display (:40+) + headed google-chrome with its own --user-data-dir, the
extension/dist copy loaded via CDP Extensions.loadUnpacked (branded Chrome ignores --load-extension),
a NativeMessagingHosts/com.sideagent.host.json inside that profile pointing at a per-job wrapper that
sets SIDEAGENT_DATA_DIR (per-job config.json = the model). ~/.sideagent is never read or written by
the harness companions except credentials the companion itself reads read-only.

Output: runs/<run>/<model>/<task>.json (+ .png full screen, -panel.png, .trace.jsonl companion trace,
.agent.log, .artifact.* rebuilt from the artifacts tool, .dl.* browser downloads)
        runs/<run>/judge/<model>/<task>.json, runs/<run>/summary.csv

Timing: seconds_* are from the Enter keypress in the panel. first_output = first assistant text,
tool chip or thinking in the panel (seconds_to_first_status = first "正在…" status line).
seconds_total = last panel change once the panel is idle (abort hidden, not streaming).
Confirmations: consent cards get 允许一次 unless they mention submit/buy/post/send/pay/delete or POST
(then 拒绝). Held destructive clicks: ordinary deletes/removals are confirmed (确认); anything that
submits/buys/pays/posts/sends/publishes is cancelled (取消).

Robustness: Chrome pipe errors (ECONNRESET, Chrome exit) fail only that job; setup errors are retried
(--retries, default 2); a load gate waits while the 1-min loadavg > --max-load (default 2x cores);
after 2 quota errors (429 / usage limit) the run stops and moves those results to _quota_errors/.
