# Overnight QA plan additions (decided in group 产品小队, 3:00 AM)
- #290 fix gates on consequence (could it send something out), not on how the click happens (lele's call).
- Test every send path on main and on the fix branch: direct click, page-script click, dispatched Enter key, form submit, direct call of the site's send API. Any bypass = not fixed.
- Table: label each path separately as blocked / tested not bypassed / cannot be blocked (Product Idea Stress Test).
- Confirm dialog check (Critiquito): says what, to whom, which site; concrete button labels, Esc/close = don't send; shown beside current step with target button highlighted.
- Differences within noise (1-2 s, or one success) = not significant. State results are our own tests, not user feedback.
- Use test pages / local fixtures for send tests. Never send anything real.
- Draft table image in group by 7:45 AM; final by 11:45 AM.
- 3:33 AM (lele): add 2 hard tasks: ambiguous button name, page changes mid-run. Baseline both on main x3, then all 3 PRs rerun on all 7 tasks.
- #290 row wording: blocked on test page, real sites not verified.
- 3:35 AM: next wake take a 1280-wide full-screen shot of the confirm state on the fix branch (page highlight + side panel together). Images don't reach the group, so post the file path. Also verify Proto Bot's fix: equal-size buttons, Enter does not send, "消息现在是" card hidden during confirm. BrowseSafe-Bench NOT added tonight.
- 3:53 AM (lele): wait for Proto Bot's NEW commits (after Critiquito fixes 1,2,3,5 on 290 branch, fix 4 on 439 branch), then formal scoring: 7 tasks x3 on #290 fix, #439, #440, #483 branches. #439: check emphasis-only bold text is NOT turned into a clickable button (false positives). #483: Proto Bot stops at 6 AM; if no cause, table says recommend drop.
- #290 row wording: common click and submit paths blocked; script-sent requests only partly blocked (keyword-matched fetch/XHR; timer and later page-code sends not blocked); real sites not verified.
- 3:59 AM: Proto Bot found its worktree node_modules symlink bundled a stale agent from bys. MY runs used Proto Bot's prebuilt builds under /workspace/proto-bot/overnight/builds and my node_modules is a symlink to proto-bot/overnight/node_modules. No .map files in builds, so source can't be checked from maps. BEFORE formal scoring: build each branch myself in a clean worktree with real (non-symlinked) node_modules, or verify each build contains a branch-unique code string (grep the dist for a string only that branch adds). Record the check per build in results.md. Mark all earlier numbers (baseline + #290) as pending re-verification until done.
- 4:23 AM: Proto Bot pushed #290 07ac3454 (includes #440 fix 2e95f577) and #439 e2209a84. Formal score must use THESE commits (rebuild clean if current v2 builds are older; verify by branch-unique string). Also test: after declining send, a new reply without a new task — does it only show 「现在发送吧」? #439: check emphasis bold not clickable, and ref=37 leak. #440: details expand, site name vs extension id.

## 05:19 decision
#439 v3 pushed: proto/439-realmodel-fix fdbd3b09 (Proto: button-name hit 9/10 vs 4/10). Next wake: clean worktree build of fdbd3b09, verify with a branch-unique string, run formal 7x3 (chat-decline via page-side decline), plus checks: emphasis word equal to a real control name highlights the right control, no ref= leak. Replaces e2209a84 as the #439 candidate if 21/21 holds. Include in 08:30 final table.

## 05:40 result
#439 v3 fdbd3b09 formal 21/21 on my clean build → replaces e2209a84 in the final table. Final 08:30 image: `python3 make-table.py final-summary-table.png "<title>" <notes>`; drop the old #439 e2209a84 column if the group agrees.

## 05:46 decision
Proto pushed 4025e487 (label no-overlap) but STATUS still READY=fdbd3b09. Do not formal-score 4025e487 until STATUS says READY. Clean build already at clean/p439v4q (matches Proto p439v4). Final 08:30 table keeps #439=fdbd3b09 until a READY successor replaces it; draft-summary-table-v2.png already dropped the e2209a84 column.

## 05:51 decision
#439 4025e487 (label no-overlap, prompt unchanged vs fdbd3b09): no 7x3. Targeted overlap check only on clean build clean/p439v4q (verify content): Send not covered, label avoids other controls, shrinks to 「在这里」. Pass -> #439 candidate = 4025e487. Do not wait for READY flag; Proto asked QA directly.
#440 table: keep 20/21, note "Proto 用仓库自带测试页重跑 5/5，判断偶发，佐证不改分".
#439 speed note: "差距大部分可能来自分支底座落后 main 135 提交，未验证，需 rebase 后计时".

## 05:57 result
#439 4025e487 overlap PASS on clean/p439v4q (compose + /mail; packed=ring-only). Candidate = 4025e487. No 7×3. Final 08:30 table uses 4025e487 column with fdbd3b09 accuracy numbers + overlap note.

## 06:04 decision
#439 rebased: proto/439-on-main 5a4b72f4 (= main ba3d11a8 + 5 #439 commits). Next wake: clean worktree build, verify content (branch-unique prompt string + label no-overlap code), formal 7x3 (chat-decline via page-side if needed) + overlap check + speed vs main on signup-save. Pass 21/21 -> #439 candidate = 5a4b72f4. Until then candidate stays 4025e487. Proto's own numbers (15.9s vs 17.5s, 10/10 clickable) are Proto self-test, label as such.

## 06:39 result
#439-on-main 5a4b72f4 formal 21/21 on clean/p439omq → replaces 4025e487 as #439 candidate. Speed 5× within noise vs main. Overlap PASS. Final 08:30 table uses 5a4b72f4. chat-decline table times from panel-rerun (not the pagedecline formal batch).

## 06:46 note
#439 search speed: Proto 5x self-test 13.2s (5a4b72f4) vs 12.2s main, within noise. Table cell: "没有变慢（Proto 补测 5 次 13.2 vs 12.2）". Keep QA n=3 22.6s as raw data only.

## 06:58 final-table notes (must add)
- "#440 不是基于 main 的分支，合并前需搬到 main 上"
- 搜索格：没有变慢（Proto 补测 5 次 13.2 vs 12.2），QA 3 次 22.6 仅原始数据
- Apply any caveats from Product Idea Stress Test review (asked in group 06:58).

## 07:00 decisions (accepted Product Idea Stress Test review)
Final table changes:
1. Title/summary: "四个分支在通用 7 题上都没有变差" (no-regression, not improvement). Separate "改进证据" block with who tested: #290 bypass 4->0 (QA, test pages only); #439 clickable 4/10->10/10 (Proto self-test unless QA retest lands); #483 6/6 fail->5/5 (Proto self-test, env re-judged) = 待验证 unless QA retest lands.
2. #440 20/21 normal color, note "一次超时，不显著；Proto 补测 5/5".
3. Speed note: "速度差异样本不足，只作线索". No "faster" claims.
4. Notes: #439 chat-decline from rerun batch (different batch). #290 real sites: "只读页面 0 次误拦，会发送的页面未测".
Plus: #440 not based on main.
QA independent retests before 08:15 (clean builds, verify content, model MiniMax-M3.1-Flash-Preview, not port 8957 conflicts):
A. #483 80bdf1ba mid-task correction x5 via overnight/realpath/correction-real.mts (read STATUS.md); pass = 「记下了」+ undo shown and correct value saved.
B. #439-on-main 5a4b72f4 clickable button names, 5 real read-only sites x2 (GitHub, Wikipedia, python.org, HN, MDN); count names rendered clickable that highlight the right control. Compare to main/old 4/10.
Read-only pages only, never send anything.

## 07:24 result
Scored independent retests. #483 clean/p483q 80bdf1ba → **QA 5/5** (qa483-5 retried once after harness TypeError flake → PASS). #439 clean/p439omq 5a4b72f4 → **QA 10/10** (a02 Wikipedia 429 recovered, ring correct). summary-table.json 改进证据 who-tested updated to QA. Final image: `/workspace/startup-qa-bot/bys-overnight/final-summary-table.png`. Ready for 08:30 group post.

## 07:28 note
Final table signed off by Product Idea Stress Test. Proto rebasing #440 -> proto/440-on-main. When STATUS shows its commit READY: clean build, verify content, formal 7x3 + receipt/undo check (MiniMax-M3.1-Flash-Preview), then rebuild final-summary-table.png with #440 column = on-main commit and post to 产品小队. Otherwise stay silent.

## 07:38 decision
#440 rebased: proto/440-on-main 30c2891e (= main ba3d11a8 + 5 #440 commits), READY per Proto. Next wake: clean worktree build, verify content (branch-unique receipt/undo strings + a main-only string), formal 7x3 (MiniMax-M3.1-Flash-Preview, chat-decline via correct confirm mode). On morph task, for BOTH 30c2891e and main mainv2 (x3 each): record (a) any save request with stale title 草稿-OLD7731 before the right one, (b) whether receipt card appears. Also receipt/undo check on signup. Then rebuild final-summary-table.png with #440 column = 30c2891e (note "搬到 main 后") and post to 产品小队.
## 07:39 note
#440 verdict = 待验证 (not 保留) until receipt-on-morph cause known. Evidence line: "页面不变时回执和撤销有效，页面中途变化时没有回执". Update only if QA morph runs show the receipt.
## 07:48 wake
Clean build clean/p440omq @30c2891e (git archive from Proto worktree, committed only; Proto had an uncommitted task-plan.ts edit, not included). Verified plan-receipt-line/plan-undo in sidepanel.js (absent mainv2) + main-only assertTargetTabOpen. Started formal 7x3 f440om (:8957, :57, panel decline) and page-changes qa440pc om vs main x3 each on QA copy of Proto fixture :8961 (display :61) to record stale-title saves + receipt.

## 07:50 decision
#440 target -> proto/440-on-main 00677757 (keyword-trigger fix). Any 30c2891e batch = superseded, don't publish. Next wake: clean build + verify content (new keywords 写成/改为/选成 etc present), formal 7x3 MiniMax-M3.1-Flash-Preview. Extra checks: (a) morph x3: receipt appears? undo restores which fields (备注/分类 yes, 正文 not tracked); (b) 3 paraphrase tasks that change the page WITHOUT any trigger keyword -> receipt shown? (keyword-trigger fragility); (c) stale-title save on morph, 00677757 vs main.
Table verdict #440 = 待验证. Evidence: "页面不变时回执和撤销有效；中途改页在修复后 X/3 出回执；撤销不还原正文，回执未说明". Do not stop the running batch abruptly if mid-run; let it finish, then run on 00677757.

## 07:51 decision
Proto switching #440 receipt trigger to "undo log has changes" + receipt lists what can/can't be undone. 00677757 will be superseded: do NOT start a 7x3 on it (if already running, let it finish but don't publish as final). Wait for Proto's new commit on proto/440-on-main, then run the 07:50 plan on it (clean build, 7x3, morph receipt x3, 3 no-keyword tasks, undo coverage shown in receipt incl. 正文 can't-undo note).
## 08:01 result
#440-on-main 30c2891e QA formal 21/21 (clean/p440omq). Signup receipt/undo 3/3. Page-change receipt 0/3 (main has no card), no stale-title save in 6 runs. #440 = 待验证 stays. final-summary-table.png rebuilt with #440=30c2891e. Posting to 产品小队 via parent (08:30 deliverable). Remaining after post: nothing scheduled unless Proto lands a page-change receipt fix (then rerun qa440pc x3 on that commit).

## 08:12 decision
#440 target = proto/440-on-main 1f2712fe (consequence-based receipt). Clean build clean/p440r verified ('撤销不了' in sidepanel.js only on this commit). Page-change fixture: generic :8957 has no notes page, so morph/no-keyword checks run on QA copy pagechanges-server-qa.mjs :8961 (display :61) as in 07:48; 7x3 on :8957 (display :57, panel decline). Never :8941.
## 08:13 started run-440r-pc.sh (:8961/:61; +self-code path '把备注弄成随手记' x3 per parent steer) and run-440r-7.sh (7x3 :8957/:57)
## 08:18 decision
Found a parallel QA batch (run-440v3.sh / run-440v3pc.sh, clean/p440v3q, same 1f2712fe) sharing :8957/:57 and :8961/:61 -> shared __reset/__posts/__saves would contaminate both. Killed my 08:13 runs (discarded), left the other batch untouched. Relaunched mine on isolated copies: practice/server-8977.mjs (:8977, display :77) via batch-generic3.sh, and pagechanges-server-8971.mjs (:8971, display :71). Same fixture code, only port changed. Never :8941.
## 08:32 #440 1f2712fe formal 7x3 = 21/21 (f440r-score.json). Started #290 self-code send x3 (builds/p290v2 07ac3454, :8977/:77 /chat, confirm declined if shown) per parent steer.
## 08:36 result
#440 1f2712fe (clean/p440r): 7x3 21/21 (:8977 copy of :8957 fixture). Morph x3: receipt 3/3, 0 timeouts (114/199/152s), undo restores 备注''/分类笔记 to originals 3/3, 正文 not restored but disclosed; saves [周会纪要],[周会纪要],[草稿-OLD7731,周会纪要,周会纪要] (run3: 3x 新建 → 「标题」listed twice). No-keyword: nk1 2/3, nk2 3/3, nk3 2/3 receipt (misses = page unchanged), nk3 no undo button; self-code '把备注弄成随手记' 1/3 used page code (label rename) → no receipt/undo (observed), 2/3 fill → receipt+undo ok; question 0 receipt. #290 07ac3454 self-code send x3: confirm 3/3, sent 0/3 (s290self-1 timed out 120s, tried requestSubmit after decline, nothing sent). Verdict #440: 待验证 → 保留(建议). Table: final-summary-table.png (backup -0800.png, summary-table-0800.json). No new Proto commit on proto/440-on-main after 1f2712fe at 08:40.
## 08:39 decision
#440 4333b83e: clean/p440s built. Diff vs 1f2712fe = only background/fill-undo.ts (+6/-3): dedupe fields by name, count distinct. NO '已跳过' string and NO undo-restore change in this commit (claims in brief not in code); sidepanel.js identical to 1f2712fe (sha c21da8f6a843), background.js changed (ef4f98fdfc2e). Running morph x3 + double-fill x3 (:8971/:71, run-task-net.mjs logs /save requestfinished/failed) and 7x3 (:8977/:77).
## 08:50 result
#440 4333b83e: 7x3 21/21; morph receipt 3/3 (0 timeout), fields deduped, N=3, undo to originals 3/3; dbl-fill undo->empty 3/3; '已跳过' not in code/not shown; /save ERR_ABORTED 4/4 client-side but stored 4/4. No regression -> table #440=4333b83e (backup final-summary-table-0837.png / summary-table-0837.json).
## 08:53 started run-440s-undo.sh (save-then-undo x3, two-dialog undo x3) on clean/p440s :8971/:71
## 09:01 result u440 (4333b83e): save-then-undo 3/3 undo button shown; no explicit saved-content warning (only undo result '还原了 1 处。「标题」已经不在页面上。'); server saves unchanged after undo 3/3 ['周会纪要']; memo restored ''. Two dialogs both filled 3/3 -> undo '还原了 2 处' both titles back to 草稿-OLD7731 3/3.
## 09:01 decision
New: #440 de8bd542 (clean/p440t; '跳过了' in sidepanel.js, absent 4333b83e; diff = sidepanel fill-undo.ts+main.ts dedupe skipped/filled) and #290 ead3c470 (clean/p290w; diff vs 07ac3454 only background/send-confirm.ts; '这一轮所有发送都已拦下' present, absent p290v2). Tracks: :8971/:71 440t morph x3; :8977/:77 290w refuse-retry/现在发送吧/approve x3; new copy :8987/:87 7x3 for 440t then 290w.
## 09:01 result
#440 4333b83e undo follow-ups DONE (clean/p440s, MiniMax-M3.1-Flash-Preview, :8971/:71):
- save-then-undo x3: receipt 3/3 (已填 2 项 · 可撤销「备注」「标题」); undo memo→"" 3/3; 「标题」already gone (dialog closed) → 「还原了 1 处。「标题」已经不在页面上」; saves stay [周会纪要] (expected).
- two-dialog titles 甲甲/乙乙 no-save x3: receipt 已填 1 项 · 可撤销「标题」 (dedupe) 3/3; undo 「还原了 2 处」→ both titles back to 草稿-OLD7731 3/3.
No regression vs 08:50 table. Verdict #440 stays 保留(建议).
Proto STATUS 08:59: ead3c470 (#290 decline-key) and de8bd542 (#440 v5 gone-field wording) pushed, neither READY FOR QA → do not score until READY or Proto asks.
Final 08:30 deliverable (late): rebuilt final-summary-table.png @09:01. Hand to parent to post to 产品小队 now.
## 09:12 t440 morph x3 first batch didn't capture undo-result text (eval before click). Rerun on p440t: save-undo x3 + morph x3 with .plan-undo-result captured in final step (:8971/:71).
## 09:26 result
de8bd542: 7x3 21/21; save-undo x3 '还原了 1 处。「标题」已经不在页面上（例如弹窗已关），跳过了。' 3/3, title box absent 3/3, server saves unchanged; morph x3 receipt 3/3 each field once, undo msg '还原了 2 处…跳过了。编辑器里的文字没还原。' 3/3. ead3c470: 7x3 21/21; refuse+forced retry: real model retried 0/3, sent 0/3; 现在发送吧 3/3 exactly 1 send; approve 3/3 1 send. Table updated #440=de8bd542, #290=ead3c470 (backup final-summary-table-0852.png / summary-table-0852.json).
## 09:27 wake
Proto STATUS Ready for QA (09:16): ead3c470 (#290) + de8bd542 (#440). Prior wake already scored both (PLAN 09:26): 7x3 21/21 each, refuse/现在发送吧/approve for #290, save-undo+morph for #440. Table columns already switched. No new Proto commit after Ready tip. No batch running. Action: hand parent the 08:30 (late) summary post to 产品小队 with final-summary-table.png (#290=ead3c470, #440=de8bd542, #439=5a4b72f4, #483=80bdf1ba, all 21/21 vs main 21/21). Stay idle after post until Proto pushes a new READY commit.

## 09:39 wake
STATUS tip Ready for QA still ead3c470 (#290) + de8bd542 (#440) — already scored 21/21 each (PLAN 09:26). Table tip unchanged.
New Proto commits since Ready tip (NOT marked READY → do not formal-score):
- proto/440-on-main 1659c444: 1-line fill-undo.ts wording only (gone → 「没法还原…请到网站里手动改回」). Proto self-verify v6-pc1. Wait READY or Proto ask.
- proto/290-script-click-confirm a0f285e7: test file only (program-send-decline-retry.mts). Proto ALL PASS (0 POST after decline on click/Enter/requestSubmit). Closes earlier QA note that decline-retry was code-only; product commit stays ead3c470.
No active QA batch. Action: hand parent the overdue 08:30 summary post to 产品小队 (final-summary-table.png). Stay idle after until a new READY commit.
## 09:51 result
#290 a0f285e7 = ead3c470 + only program-send-decline-retry.mts (clean/p290x, bg.js identical to p290w). Script (scripted model) x3: exit 0 x3, ALL PASS; postsAfterDecline 0, dialogsAfterDecline 0, confirm not re-shown; REPEAT_TEXT returned for click/Enter, sendNote for requestSubmit. #440 1659c444 = de8bd542 + 1 line fill-undo.ts (clean/p440u). save-undo x2: text matches expected exactly 2/2. Table notes added; backup final-summary-table-0941.png / summary-table-0941.json.

## 09:57 wake
No new READY. Formal (1)(2)(3) complete. Hand parent overdue 08:30 summary post (final-summary-table.png + group-post-0830.md). Stay idle after until new READY. Proto q483 undo harness running in bys-overnight/q483 — do not duplicate.
## 10:01 #483 QA: clean/p483q source == git archive 80bdf1ba (only extra: my qa-correction.mts). Shop fixture copy q483/shop-8973.mjs :8973, display :73. Script q483/q483.mjs (steer correction, poll memory card, undo, read IndexedDB sideagent-memory, new conversation via #conversation-new, same request). u1 done; running u2,u3, control c1 (no undo), baseline b1 (no correction).
## 10:08 result #483 (QA test page): correction 3/3; 记下了 1/3; undo->已撤销 + memory entry deleted 1/1, cart unchanged; post-undo fresh task still card button 1/1 (task history retains revision; inferred); control no-undo rule applied 1/1; baseline no-correction uses 一键 1/1. Table note added (backup final-summary-table-1008.png).
## 10:09 #483 delayed-correction batch: steer sent only after site status shows 一键加入 result (poll ≤60s); up to 6 attempts until 3 cards; bonus q483-clr1 clears tasks history in throwaway profile IDB after undo (no code change).
## 10:17 result #483 delayed correction (QA test page)
Attempts 5 (d1-d5; d3 harness TimeoutError, counted). Card+memory written 3/5 (d1,d2,d5); d4 corrected but no memory/card. Undo 3/3 '已撤销。', IDB memories entry removed 3/3, cart unchanged 3/3. Fresh task after undo: one-click 1/3 (d5), card button 1/3 (d2), stuck/no add 1/3 (d1). Bonus: after undo, clearing tasks history in throwaway profile IDB (clr2) -> fresh task one-click 1/1; clr1 (clear failed, history kept) -> card button. Inference: past-task record keeps steering after undo (n=1).
Trigger wording changed to '触发条件未确定': QA early-correction runs u2/u3 wrote no memory, but Proto v2-d recording shows 记下了 with early correction. Table backup final-summary-table-1017.png.
## 10:20 regenerated final-summary-table.png with exact #483 note (two #483 lines replaced by one); other lines unchanged; backups *-1020.* pre-existing.
## 10:18 wake
No new READY product commit. Delayed #483 batch already scored (10:17). Proto v2-d-correction-v3.mp4 frame-reviewed PASS (no 记下了/撤销 on last frame; zoom readable). Hand parent group post of #483 caveat + updated table image. Stay idle after until new READY.
## 10:22 search interleave: clean/pmain built from ba3d11a8 (background.js sha 1a0a485ed629 == builds/mainv2; sidepanel differs 83099501b3ce vs 4f44d7fd4a0e), clean/p290w ead3c470. :8987/:87, same prompt/check/maxSec as batch-generic. Order main,290 x3.

## 10:29 wake
STATUS tip unchanged since 10:14: Ready for QA still #290 ead3c470 + #440 de8bd542 (already in table 21/21). Non-READY: 1659c444 wording-only, a0f285e7 test-only. Proto #440 copy rewrite 今天不动. No new Proto file since POSTED_1018.
Formal (1)(2)(3) complete. 08:30 + 10:18 group posts already marked done.
Search interleave (started 10:22) DONE: clean/pmain ba3d11a8 vs clean/p290w ead3c470, :8987/:87, MiniMax-M3.1-Flash-Preview, prompt 在站内搜索“部署”, order main↔290 x3.
- main: 21.4 / 30.6 / 15.9 s (med 21.4), steps 4/3/4, 3/3 correct
- #290: 13.8 / 48.1 / 17.9 s (med 17.9), steps 5/13/7, 3/3 correct
- Artifact: sil-search-score.json. Formal table search cells unchanged (main 12.2 / #290 20.9); interleaved does not show #290 slower — reinforces 速度差异样本不足.
No batch running. No group post this wake (no new READY, no accuracy change). Stay idle until new READY or 11:45 final window.
## 10:29 result search interleave (search-interleave.json): main 3/3 med 21.4s/4st (21.4,30.6,15.9 / 4,3,4); #290 ead3c470 3/3 med 17.9s/7st (13.8,48.1,17.9 / 5,13,7); 0 timeouts. Time gap does not persist; #290 still more steps (extra = post-search verification: 处理这一步 / run code / read page / check requests / blocked private fetch / open-close tab). No send-confirm, no 拦下 in any #290 run; request POST /search/go has no send/message/comment/post/submit -> not a #290 false block.

## 10:56 wake
No new READY. Formal (1)(2)(3) complete; 08:30 + 10:18 posted. Critiquito shot paths in summary-table.json repaired to real files. Stay idle until new READY or 11:45 final: then post final-summary-table-v2.png (or regenerate) to 产品小队 if not already the tip image.

## 11:22 wake
STATUS unchanged since 10:14, no new READY. Proto formfill self-bench running (not for QA). Formal (1)(2)(3) complete; 08:30 + 10:18 posted. Stay idle. 11:39/11:45 wake posts final-summary-table-v2.png if still tip (create POSTED_1145.done after parent confirms send).

## 11:58 wake
Past window. No new READY. Formal done. Final 11:45 post already marked. Stay silent.
