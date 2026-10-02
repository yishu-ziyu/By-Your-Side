# BYS eval harness (extension-only)

One command (2 model specs x 3 tasks, 2 at a time, then judge + summary):

    node eval/harness/run.mjs --models zai-coding-cn/glm-5.3-flash,minimax-cn/MiniMax-M3.1-Flash-Preview+zai-coding-cn/glm-5.3-flash \
      --tasks BYS-006,BYS-008,BYS-081 --concurrency 2 --run-id my-run

Model spec: `main[+fast]`, each `provider/modelId`; fast defaults to main. Output dir per spec = spec with
non-alphanumerics replaced by `_`.
Resume missing/invalid results of a run: node eval/harness/run.mjs --resume --run-id my-run --concurrency 2
Flags: --models a,b (default: zai-coding-cn/glm-5.3-flash) --tasks ids (default: all 141)
       --concurrency N (default min(2, jobs)) --cap-sec 240 --retries 2 --max-load N
       --no-judge  --dry-run (launch Chrome, configure models, open panel, check it connects; no prompt)
Judge results whose verdict is missing, stale or judge_error, then rebuild report + charts: eval/harness/finalize.sh eval/runs/<run-id>
  (judge v3: screenshots + final page text + tool reads/log + answer; verdict pass|fail|undeterminable;
   each verdict stores judge_version + result_sha, so a judge bump or a rerun result is re-judged)
Old-vs-new judge chart: python3 eval/harness/chart_rejudge.py [out.png]  (reads eval/splits/baseline_judge_v3.json)
Re-group failure reasons (codex):   python3 eval/harness/cluster.py eval/runs/<run-id>  (then finalize.sh again)
Failure review page for the product owner: node eval/harness/review.mjs eval/runs/<run-id> [--all]
  -> runs/<run>/review.html (self-contained; screenshots are relative links, so open it inside the run dir).
  Top: pass rate per model spec x tier vs eval/tasks/tiers.json target (analyze.py rules). One card per task that is
  fail / undeterminable / judge_error in some spec (--all: every result, incl. passed and not yet judged), grouped
  by tier then category; failing specs side by side. Each card: prompt, site, success rule, final reply, verdict +
  reason, page + panel screenshots (click to enlarge), time/tool calls, and a data-only 初步猜测 (timeout, no reply,
  tool errors, 当前写入已暂停, failed side_call, panel error, denied confirmation, setup not applied, judge error).
  Marks 能接受 / 不能接受 / 判错了 + note are kept in localStorage (key bys-review:<runId>|<task>|<spec>);
  导出我的判断 downloads review-<runId>.json = {runId, decisions:[{task, config, mark: accept|reject|misjudged, note}]}.

Paths and env (see paths.mjs, credentials.mjs): BYS_REPO (default: this repo), BYS_TASKS (default eval/tasks/tasks.jsonl),
BYS_RUNS_DIR (default eval/runs), BYS_KEY_<PROVIDER> (API key, overrides credential files), SIDEAGENT_STEP_PLAN_KEY,
EGO_ACCEPTANCE_CHROME (Chrome for Testing / Chromium binary), BYS_PRICES (price table), BYS_CJK_FONT (charts), JUDGE_CONC (finalize.sh, default 4).

Each job (job.mjs) uses the real-path acceptance driver `scripts/acceptance/real-path/harness.mts` of BYS_REPO:
`launchRealPath()` builds the extension from source into a temp dir with a random key, starts Chrome for Testing
`--headless=new` with its own temp profile and only that extension (agent core in the offscreen document; no
companion process, no Native Messaging), and opens the real side panel. The job writes `inproc_model_config`,
`inproc_fast_model_config` and `inproc_cred:<provider>` into chrome.storage.local (the keys the settings page saves),
types the prompt in the panel and presses Enter. After the run it exports diagnostics through the settings page
(`exportDiagnosticsViaSettings`, IndexedDB `sideagent-diagnostics`); the fresh profile means the export is this job
only. The temp profile (which holds the credential) is deleted when the job ends. Never touches the daily Chrome,
its profile, CDP 9222, extension/dist or ~/.sideagent.

Credentials (credentials.mjs): BYS_KEY_<PROVIDER> -> stepfun: SIDEAGENT_STEP_PLAN_KEY or ~/.sideagent/step-plan.key ->
~/.pi/agent/auth.json[provider] (api key, or an OAuth login that must not expire within 5 min). Never printed. After
each job every file it wrote is scanned for the secret; hits go to `secret_scan.leaked_files` and errors.

Output: runs/<run>/<spec slug>/<task>.json (+ .png page+panel side by side, -page.png, -panel.png,
.trace.jsonl exported extension diagnostics, .artifact.* rebuilt from the artifacts tool, .dl.* browser downloads)
        runs/<run>/judge/<spec slug>/<task>.json, runs/<run>/summary.csv
analyze.py -> report.json, report_models.csv, report_per_task.csv grouped by model spec. Tokens from assistant
message_end usage (main model); side_call (fast-model judgments) counted only. Cost only with a price table;
otherwise tokens only (Token Plans are subscriptions). pass_rate excludes judge_error rows.

Timing: seconds_* are from the Enter keypress in the panel. first_output = first assistant text,
tool chip or thinking in the panel (seconds_to_first_status = first status line).
seconds_total = last panel change once the panel is idle (not running, send button not in stop mode, not streaming).
A timed-out task is stopped with the panel's stop button before evidence is collected.
Confirmations: consent cards get 允许一次 unless they mention submit/buy/post/send/pay/delete or POST
(then 拒绝). Held destructive clicks: ordinary deletes/removals are confirmed (确认); anything that
submits/buys/pays/posts/sends/publishes is cancelled (取消).

Robustness: a Chrome or CDP failure fails only that job; setup errors are retried (--retries, default 2);
a load gate waits while the 1-min loadavg > --max-load (default 2x cores); after 2 quota errors the run
stops and moves those results to _quota_errors/.

Verified 2026-10-02 on macOS only (docs/evals/20261002-eval-extension-only.md); cloud Linux not run.
model-check.mts is from the OpenCode Go era (OpenAI chat-completions + auth.json) and does not cover
anthropic-messages providers such as minimax-cn; the settings page 测试连接 is the extension's own check.

Environment accounting (v3-env4): job records bounded task-page snapshots and main-document response status. An initial connection error, HTTP429 or verified challenge page stops before model calls and saves a browser screenshot. A final blocked task page is classified from browser evidence only when grading confirms it caused the failure; proved successes and unrelated errors remain normal results. Assistant claims alone never exclude a task. Judge writes `environment` with evidence; analyze/review/dashboard list it separately and exclude it from pass-rate denominators. Head-to-head uses only tasks judged for every configuration, so an unavailable task in either configuration is removed from both comparison denominators. Same hostname jobs run one at a time; different sites still run concurrently. Details and acceptance: [environment](../../docs/testing/eval-environment.md).
