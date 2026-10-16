# Overnight STATUS (updated as I go)

## Branches pushed
| branch | commit | base | what |
|---|---|---|---|
| proto/290-script-click-confirm | 07ac3454 (prev 6a2cc49a; includes cherry-pick 2e95f577 of #440 edce912e) | origin/main ba3d11a8 | #290 按后果判：click / 脚本 el.click / 合成回车 / press_key 回车 / requestSubmit / form.submit / 发送类 fetch·XHR·sendBeacon 都走同一个确认框（写字数、收件人、网站；发送/先不发；Esc 与关侧栏=不发；圈出按钮） |

| proto/439-realmodel-fix | 4025e487 READY FOR QA (prev fdbd3b09, e2209a84, 483a2ae7) | feat/answer-points-page 4e6becb2 | READY FOR QA. 回答里粗体写的按钮名（**Code**）也加虚线、可点圈出；原 PR 只认「」，真实模型 5 题只触发 1 题 |
| proto/439-on-main | 5a4b72f4 READY FOR QA (new) | origin/main ba3d11a8 | #439 cherry-picked onto current main: 4e6becb2→7801bf61, 483a2ae7→87b98186, e2209a84→e45995e1, fdbd3b09→61bbe726, 4025e487→5a4b72f4. proto/439-realmodel-fix untouched |
| proto/440-on-main | 00677757 READY FOR QA (prev 30c2891e) | origin/main ba3d11a8 | #440 cherry-picked onto main; old branch untouched |
| proto/440-realmodel-fix | edce912e | feat/plan-receipt-morph 9f9bdc78 | READY FOR QA. 过程卡不再把读页编号显示成栏名（原来是「填 「@2」」，现在「填写 ×3」）；PR 本身真实模型 3/3 收成回执、撤销还原 |
| proto/483-realmodel-fix | 80bdf1ba | feat/correction-loop 75d4a5e2 | 原 PR 产品代码没问题，不需要修。之前测到 6/6「要我记住吗」，原因是测试环境：worktree 的 node_modules 软链到 bys，所以 @sideagent/agent 打包进去的是 bys（proto/290）的旧 agent 代码。修好软链（只在本机）后，真实模型中途纠正 5/5 都是「记下了」+撤销（MiniMax-M3.1-Flash-Preview，runs/v483-1..5）。这个分支只加了验收脚本 |

## Build / load
    git fetch && git checkout <branch> && npm ci && npm run build   # -> extension/dist
    Chromium: --disable-extensions-except=<dist> --load-extension=<dist>
Prebuilt copies: /workspace/proto-bot/overnight/builds/{main,p290,...}

## Model config (set in service worker)
    chrome.storage.local.set({ inproc_model_config:{provider:"minimax-cn", modelId:"MiniMax-M3.1-Flash-Preview"}, "inproc_cred:minimax-cn":{type:"api_key", key:<from ~/.pi/agent/auth.json minimax-cn.key>} })
Fallback model: MiniMax-M3 (each run records model used).

## #290 repro (12 cases, scripted model, local page)
    EGO_ACCEPTANCE_CHROME=~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome BYS_RERUN=1 npx tsx scripts/acceptance/real-path/program-send-confirm.mts --headless
before = origin/main (worktree /workspace/proto-bot/wt-main): overnight/290/before.log — 10 of 11 send routes POST with no confirm (only direct click asks)
after = ce200ec1: overnight/290/after.log + after/*.png — all 11 send routes show the confirm, 0 POST before decision; 3 "send" cases POST exactly 1; save not blocked

## #290 follow-ups (6a2cc49a)
- 先不发 / 发送 equal outlined buttons, 先不发 left; 发送 not in Tab order, keyboard/Enter never triggers it
- while confirm open, 「…现在是」 readback card hidden (evidenceVisible=false in runs/c290-*/result.json)
- 先不发 → grey line 「你选择不发送：草稿留在页面上，不会发出，要发时再跟我说」; no red step; goal check no longer shows 没做成 card (screens/290-declined-neutral.png)
- closing the side panel during confirm = not sent: runs/c290-close*/result.json posts=[] and page dialog removed
- off-screen target scrolled into view before confirm; screens/290-fullscreen-confirm-1280.png (page highlight + panel card)

## Other outputs
- videos/demo-{1-idea-draft,2-compare-books,3-summarize-mdn,4-fill-order}.mp4 (20fps x11grab, page + panel, build = proto/290 6a2cc49a, model MiniMax-M3.1-Flash-Preview)
- compare-before-after.png (self-measured), metrics-selfcheck.json, score.py, metrics.sh
- screens/ (290 confirm full screen, 290 declined, 439 circle, 440 expanded/receipt/undo, 483 ask card)
- harness: run-task.mjs (Playwright, popup panel window beside page), closecheck.mjs, pr483.mjs, realpath/correction-real.mts

注意：#439/#440 之前的真实模型测试，agent/src 部分也用的是 bys 的代码（extension/src 部分是对的）。需要重测。

## v2 round (2026-10-16 ~04:00–04:40 CST)
Builds: builds/p290v2 (bys @07ac3454), builds/p439v2 (wt-answer-points-page @e2209a84), builds/p440v2 (wt-plan-receipt-morph @edce912e). Each worktree's node_modules/@sideagent/{agent,extension} resolves to its own worktree (checked with realpath); every dist rebuilt from its own tree.

### proto/290 07ac3454
- Page: black floating confirm bar (先不发/发送) removed. Page shows only the orange ring + one-line pill 「等你在侧栏确认」 placed next to the ring, clamped to the viewport. Esc still = 先不发. Confirm buttons only in the side-panel card.
- Recipient copy: heading like 「和 @小王 的对话」 → 「@小王（团队聊天）」 (name + page title in full-width parens, generic regex 和/与/跟/同 … 的 对话/聊天/私信/会话). Card: 「把这段 18 字的内容发给 @小王（团队聊天），在 127.0.0.1:8931 上」.
- #440 fix cherry-picked (2e95f577): steps read 「填写」, no 填「@2」.
- After 先不发: the panel shows only the grey status line + one 「现在发送吧」 button (sends that as the next user message). The model's answer body, the checklist card, and the closing 「没有发送」 paragraph are no longer shown.
- Verified real model (runs/c290v2-decline-b): posts=[]; screens/290-fullscreen-confirm-1280-v2.png, screens/290-fullscreen-declined-1280-v2.png.

### proto/439 e2209a84
- Model marks and handoff rings: white 3px ring + dark #111 outline inside and outside + white/dark outer glow (sketch paths: white stroke + dark drop-shadow outline + glow). Labels are solid dark pills with white text. They sit next to the ring only (no far scan), must land on painted page content (not the blank html/body margin), and are clamped to the viewport.
- Answer-ref pointing (page_ref_point): the same ring style + 「「name」在这里」 pill beside the element.
- Bold emphasis: bold text is linked only when the name resolved to a real located control (page_refs_check → locatedRef + locatedStillThere). Real-model check (runs/p439v2-bold): 2 bold words 技术新闻/社区讨论, 0 page-refs. screens/439-emphasis-bold-v2.png
- HN: screens/439-hn-highlight-v2.png (label now directly under login, on the page), 439-hn-ref-click-v2.png. Read-only, no login/submit.
- #439 real model 5 questions ×2 on final build (runs/p439v2-c*, d*): answer has a clickable page-ref in 4/10 (python ×2, HN login ×2); github/wikipedia/MDN 0/6 (the model circles the target itself and names it plainly, without 「」 or bold). The earlier pre-ring v2 build (a*/b*) was also 4/10.

### #440 recheck (correct build p440v2, runs/p440v2-0{1,2,3})
3/3 steps show 「填写 ×N」 with no @id; receipts 「已填 N 项 · 撤销」; after undo, fields are restored (01: ["1"] default only, 02: [], 03: page defaults only).

## #439 v3 — fdbd3b09, READY FOR QA (pushed)
Diagnosis. The facts come from a debug build (builds/p439dbg, runs/p439dbg-*) that dumped the asked names and the agent's located control map on page_refs_check:
- The prompt never asked the model to quote control names (fact: 4e6becb2 touched no agent prompt).
- MDN: the answer wrote "Search the site" in ASCII quotes, so the parser asked for nothing. The control was in the map (Searchthesite=1053). Cause: parser only accepted 「」 and bold.
- GitHub: the answer asked for Code and Download ZIP. Code=null in the map because two controls are named Code (nav tab + green button), so it was dropped as ambiguous. Download ZIP is not in the snapshot (it sits in a closed menu).
- Wikipedia: 「119 languages」 was asked and was in the map (ref 277), but locatedStillThere was false. Inference, not proven: the ref is Vector's hidden dropdown checkbox (opacity 0); its visible part is the label.
Change:
- Prompt: name page controls exactly as shown, inside 「」, never use 「」 for emphasis.
- mark records the name of the ref it circled. Circled names win over the ambiguity drop and are reported back, then matched in the answer's plain text: exact, case-sensitive, English whole-word, first occurrence only.
- ASCII "…" or “…” quotes are also asked.
- Hidden inputs are located and pointed at through their visible label.
Bundle check: the only ../../bys paths are third-party node_modules (shared symlink). agent/ resolves to this worktree.
Real model, final build (runs/p439v3-c*, d*): 9/10. GitHub 2/2, Wikipedia 1/2, python 2/2, HN 2/2, MDN 2/2. The Wikipedia miss: the reference was not found on the page (c02). The previous v3 build (a*/b*, before the label fix): 8/10, Wikipedia 0/2. v2: 4/10.
False-positive check (runs/p439v3-fp1..4):
- HN bold emphasis: 0 references. Wikipedia summary: 0.
- GitHub "重点词加粗": 1 reference. The bold word 语音交互 matches a real link on the page, so emphasis that happens to equal a control name still gets linked.
- MDN with ASCII-quoted tech names: 2 references, "Learn" and "Tools" (real nav controls named as categories).
- Random words were never linked. Residual risk: bold or quoted words that equal a real control name get linked.
Screens: screens/439-github-ref-v3.png, screens/439-wikipedia-ref-v3.png.

## #440 timeout check (page-changes-mid-run, real model, 5× each, maxSec 300)
Task: the action-page-changes practice page (served standalone by overnight/pagechanges-server.mjs :8941), prompt 「新建验收：备注写随手记并回车，正文写好，点刷新，分类选项目，再新建一条笔记，标题写周会纪要，保存。」. Builds: p440v2 (wt-plan-receipt-morph edce912e) vs mainv2 (wt-main ba3d11a8). Both builds come from their own worktrees.
- #440: 117.7 / 86.0 / 87.7 / 86.8 / 113.8 s (median 87.7). Steps 33 / 42 / 30 / 37 / 41. Saved 周会纪要 5/5.
- main: 73.4 / 125.7 / 65.5 / 81.7 / 81.3 s (median 81.3). Steps 21 / 34 / 22 / 31 / 39. Saved 5/5.
- No run reached 180 s on either branch. Main's slowest run (125.7 s) is slower than #440's slowest (117.7 s).
- Where the time goes (fact, from step lists): on both branches it is model-chosen tool calls. Most are 在页面里运行代码 (js checks): 42 on #440 vs 35 on main, then clicks and fills. The receipt and process card are panel UI, not tool calls; no step on either branch comes from them.
- Verdict: noise / model variance. Inference: QA's 180 s miss was a slow tail run, since this task takes 65–126 s on both branches. No fix.

## #439 label overlap — 4025e487 (pushed)
- The 「…」在这里 pill and the model's own mark labels never cover another control (button, link, input, role=button and similar). They try the right, left, below and above sides. If every side covers a control they shrink to a small 「在这里」; if that still covers something, the label is dropped and only the ring stays. The pill also avoids the model's mark labels.
- Verified on a local compose page (Discard / Save draft / Send):
  - Before: the model's label 「存草稿就点这个」 sat on top of Send (runs/p439v4-draft).
  - After: Send is clear and the labels sit below (runs/p439v4-draft2, screens/439-label-no-overlap-v4.png).
  - Not yet seen: the pill dodging a model label. The second run's two labels overlapped each other; a fix was added after, but in the only retest (draft3) the model drew no circle.

## #439 signup-save timing (5× each, /signup 「…然后点保存」)
- #439 (build p439v4 = 4025e487; it adds only page-side label code to fdbd3b09): 27.3 / 19.7 / 16.7 / 18.3 / 25.7 s (median 19.7). 7 steps on average; 5 failed plan steps across the 5 runs.
- main ba3d11a8: 13.4 / 15.8 / 16.8 / 15.1 / 16.1 s (median 15.8). 6.2 steps on average; 0 failed steps.
- #439's base without #439 (7ea8ee9b, temp worktree wt-base439, own build): 16.0 / 16.5 / 21.4 / 15.5 / 14.3 s (median 16.0). 6.4 steps on average; failed plan steps in 4 of 5 runs.
- Fact: #439 is based on 7ea8ee9b, 135 commits behind main. The failed first plan step and the later retry already happen on that base, and never on main.
- Inference:
  - Most of the gap to main is the older base. That base also still shows the 填「@2」 step names.
  - The remaining gap to base (about 3.7 s median, n=5) is mostly the 2 slow runs with extra retries, i.e. model variance.
  - The prompt sentence #439 adds is about 60 tokens.
  - Matching control names happens in the panel after the answer is done, so it is not counted in run time.
- Recommendation: rebase proto/439 onto main before comparing timing again.

## proto/439-on-main — 5a4b72f4 (pushed, new branch, worktree /workspace/proto-bot/wt-439-on-main)
- Cherry-picked the 5 #439 commits onto origin/main ba3d11a8. proto/439-realmodel-fix was not rebased or force-pushed.
- Conflicts (2 picks), resolved minimally:
  - 4e6becb2: background/index.ts imports — kept main's state.js import (adds assertTargetTabOpen) and added the locatedRef import. sidepanel/styles.css — kept main's chapter/done-mark block, then appended the .page-ref block.
  - fdbd3b09: input.ts imports — kept both. index.ts imports — main's version plus circledNames.
- Build: typecheck clean. node_modules/@sideagent/{agent,extension} resolve to this worktree. The only ../../bys paths in the bundle are third-party node_modules.
- Signup-save, 5 runs each:
  - 439-on-main: 14 / 18 / 15 / 14 / 18 s, median 15.9, 6–7 steps, 0 failed steps.
  - main (mainv2 ba3d11a8): 15 / 12 / 19 / 27 / 17 s, median 17.5, 6–8 steps.
  - So no slowdown from #439. The earlier 19.7 vs 15.8 came from the old base.
- Clickable reference, 5 questions ×2 (runs/p439om-*): 10/10 — GitHub 2/2 (Download ZIP, Code), Wikipedia 2/2 (119 languages; 6种语言 on a zh page), python 2/2, HN 2/2, MDN 2/2.
- wt-base439 removed.

## videos/ v2 (re-recorded 2026-10-16 ~06:35 CST)
All 1280x800 at 30 fps (x11grab, xvfb :43). Real Chromium, unpacked per-worktree builds (the only ../../bys paths are third-party node_modules), model MiniMax-M3.1-Flash-Preview. Each clip has a mid-frame PNG next to it (*-mid.png).
- videos/v2-a-send-confirm.mp4 (24.2 s) — proto/290 07ac3454 (builds/p290v2), local chat test page :8931/chatlong. The agent writes the reply. The page shows only the orange ring + 「等你在侧栏确认」 on 发送; the side panel card reads 「发给 @小王（团队聊天）」; 发送 is clicked; exactly 1 POST to the test page.
- videos/v2-b-page-ref.mp4 (17.1 s) — proto/439-on-main 5a4b72f4 (builds/p439main), python.org (read-only). The answer contains a clickable 「Downloads」. Clicking it circles Downloads with the white/dark ring; both labels shrank to small pills above the ring because controls surround it.
- videos/v2-c-fill-undo.mp4 (23.6 s) — proto/440-realmodel-fix edce912e (builds/p440v2; there is no main-based 440 branch), local signup form. Fills 3 fields → 「已填 3 项 · 撤销」 receipt → 细节 → 撤销 → 「还原了 3 处」, form empty again.
Old demo-*.mp4 (6a2cc49a, black page bar) are kept but outdated.

## #439-on-main search timing (local :8931/search 「在站内搜索“部署”。」, 5 runs each)
- 5a4b72f4 (builds/p439main): 19.9 / 12.2 / 13.2 / 12.7 / 22.4 s, median 13.2. Steps 4 / 5 / 4 / 4 / 9.
- main ba3d11a8 (builds/mainv2): 12.2 / 11.7 / 11.1 / 14.7 / 15.3 s, median 12.2. Steps 5 / 7 / 6 / 4 / 4 (one main run had 2 failed steps).
- Slow #439 runs (fact):
  - 19.9 s: same 4 steps as the fast runs, so the extra time is model latency per turn.
  - 22.4 s: the model doubted the result, re-read the page, pressed Enter to search again and checked with js, for 9 steps.
- Neither slow run had a retry caused by a #439 tool, and #439 adds no tool calls.
- The prompt adds about 60 tokens. Matching control names runs after the answer.
- Verdict: no clear #439 cause (median gap 1.0 s, n=5). QA's 22.6 s median on n=3 looks like 2 slow tail runs. No fix proposed.

## 作废 (06:57)
- compare-before-after.png：3:49 用 Proto Bot 自测的旧数字做的，已作废，不再使用。最终对比表以 Startup QA Bot 的 /workspace/startup-qa-bot/bys-overnight/draft-summary-table-v3.png 为准。

## 结论修订 (07:00)
- #483：由「保留」改为「待验证」。5/5 是 Proto Bot 自测，原因事后改判为测试环境问题，需 QA 独立复测。
- #439-on-main：10/10 可点按钮名为 Proto Bot 自测，QA 未独立复测。

## QA 独立复测 (07:27)
- #483 80bdf1ba：QA 5/5，改回「保留」。
- #439-on-main 5a4b72f4：QA 可点按钮名 10/10，独立确认。
- 最终表：/workspace/startup-qa-bot/bys-overnight/final-summary-table.png

## proto/440-on-main — 30c2891e (pushed, new branch, worktree /workspace/proto-bot/wt-440-on-main)
- Commit map: 1151add0→05a87144, 5bd3acea→c7ec30f1, 7197c175→c67c9212, 9f9bdc78→ad018849, edce912e→30c2891e. proto/440-realmodel-fix was not rebased or force-pushed.
- Conflicts:
  - 1151add0: sidepanel/main.ts relay import — main's line (parseDeliveryReceipt, DeliveryReceipt) plus FillUndoView.
  - 7197c175: scripts/acceptance/real-path/fill-undo-button.mts — took the plan-card version and kept main's .answer-face button selector.
- Build: typecheck clean. node_modules/@sideagent/{agent,extension} resolve to this worktree. The only ../../bys paths in the bundle are third-party node_modules.
- Signup fill (local :8931/signup, 3 runs, runs/om440-su*):
  - Every run filled 王五 / 13700000000 / 带水.
  - Steps read 「填写 ×3」, with no @ids.
  - Receipt 「已填 3 项 · 用时 8 秒 · 撤销」.
  - 撤销 restored the fields to ["", "", "1", ""] in 3/3 runs.
- Page-changes-mid-run (:8941, 3 runs, runs/om440-pc*):
  - 77.1 / 133.2 / 105.0 s, none timed out; 30 / 31 / 47 steps; no @ids.
  - The final save was 周会纪要 in 3/3 runs. Run 2 saved 周会纪要 twice; run 3 first saved the old title 草稿-OLD7731, then saved again correctly.
  - No plan-card receipt on this task (the text check came back empty).

## 结论修订 (07:39)
- #440：改为「待验证」。页面不变时回执和撤销有效；页面中途变化时没有回执，原因在查。

## #440-on-main: no receipt on page-changes task — fixed in 00677757 (pushed)
- Cause (fact, code): the receipt line 「已填 N 项 · 撤销」 is painted only when the run's card is a plan-card. A plan-card exists only when taskPlan.announce ran, which needs a second site or a match of the WRITE regex in task-plan.ts. The page-changes prompt (「…备注写随手记…正文写好…分类选项目…新建一条笔记…保存。」) matched none of the old verbs (checked with node: false). So there was no plan, no plan-card and no receipt. Fill path, page script, refresh and save play no part.
- By design or bug: bug. The heuristic is meant to catch write tasks, and this is clearly one.
- Fix: WRITE also accepts 写成/写上/写好/改为/选择/选成/选为/保存/新建/创建. 保存/新建/创建 are not counted when followed by 按钮/键/在/是, so 「这个保存按钮在哪？」 stays a question. 「这篇文章写了什么？」 and the python/search questions still don't match.
- Verify (:8941, 3 runs):
  - Receipt 「已填 4 项 · 用时 1 分 29 秒 · 撤销」 and 「已填 3 项 · 用时 1 分 14 秒 · 撤销」 in runs 1–2.
  - 撤销 restored 备注 and 分类 to their initial values in runs 1–2. The contenteditable 正文 was not restored — it is not in the undo ledger, which is unchanged existing behavior, not new.
  - Run 3 hit my 200 s cap before finishing, so no receipt was painted.
  - Saves: 周会纪要 only, in 3/3.
- main ba3d11a8, same task (:8943, 3 runs): 196.9 / 87.1 / 109.9 s; saves 周会纪要 only, 3/3; never saved the old title. The earlier 草稿-OLD7731-first save (1 of 3 on 440-on-main) did not recur in these 3 on the fixed branch. Inference: occasional model behavior, not #440. Both branches have runs near or over 200 s on this task.

## #440-on-main v3: consequence-based receipt + undo scope — 1f2712fe (pushed to proto/440-on-main)
- Cost (from code): small. Receipt now shows when the panel got a non-null fill-undo view for the run (main.ts finish: plan-card OR planUndo). Background ledger also keeps names of written-but-untracked fields (contenteditable, prefilled password); receipt line adds 「可撤销「…」，「正文」撤销不了」. 4 files, ~40 lines. Tracking contenteditable in undo NOT done: needs innerHTML snapshot+restore that editor frameworks (ProseMirror/Lexical) overwrite, plus scrubbing old text from model input — not small; disclosed instead.
- WRITE keyword regex kept: still drives the 「会去 … · 不会做 …」 plan line; no longer needed for the receipt.
- Build p440v3: typecheck clean (agent+extension); ../../bys paths in bundle are only node_modules (@anthropic-ai/sdk), none agent/extension/shared.
- Runs (:8941, xvfb :47, cap 200 s): pc1 154.9 s saves [周会纪要]; pc2 89.9 s [周会纪要]; pc3 77.9 s [周会纪要]; accidental extra pc run 129.6 s saves [周会纪要, 周会纪要] (model re-did 新建+保存 after not seeing a confirmation). All pc: receipt 「已填 3/4 项 · 撤销 · 可撤销「备注」「分类」「标题」，「正文」撤销不了」; 撤销 restored 备注→"" and 分类→笔记; 正文 unchanged as disclosed.
- No-keyword: 「分类换到项目那一项」 receipt 已填 1 项, undo restored; 「正文那块帮我记一句：明天交周报」 receipt 「做了 2 步 · 「正文」撤销不了」 (no undo button); 「把备注弄成随手记」 — model renamed the label via page script, input stayed empty, no ledger entry → no receipt (gap: script-run DOM edits aren't in the ledger); rephrased 「备注那一栏的内容弄成随手记」 receipt 已填 1 项, undo restored.
- Question 「这个页面上的分类有哪几种？」: 0 steps, no receipt.
- Screenshot: screens/440-receipt-v3.png (pc2).

## #440 v4: duplicate 「标题」 + stale-title saves — 4333b83e (pushed proto/440-on-main)
- Cause of 「标题」「标题」 (fact, code+logs): ledger entries are keyed per element token; same element written twice = 1 entry (before = value before the first write). Test page appends a NEW dialog (own #title input) on every 新建笔记 click, so 2 dialogs with typed titles = 2 entries both named 标题. QA qa440v3pc-v3-2 clicked 新建 twice and saves.json shows ["周会纪要","周会纪要"] (2 saves, not 1); r440-morph-3 opened 3 dialogs.
- Fix: viewOf dedupes field names; N in 已填 N 项 = unique field names. 还原 still restores every entry.
- 草稿-OLD7731 save (r440-morph-3, fact from steps): model typed 周会纪要 into 「项目名」, then clicked 保存 on the dialog whose title was still the default → saved OLD7731. Wrong-field targeting, not a stale element after page change; unrelated to the undo ledger. Not fixed (model behavior).
- Verify p440v4 (:8941, xvfb :47): double-fill 「备注先填甲甲再改成乙乙」 2 fills on one field → 已填 1 项 · 可撤销「备注」; 撤销 → "" (original, not 甲甲). pc1 102.9 s: 已填 3 项, 「标题」 once; 撤销 restored 备注/分类; saves [] — model reports /save?title=周会纪要 ended net::ERR_ABORTED (cause not investigated).

## proto/290-script-click-confirm — ead3c470 (pushed; worktree /workspace/proto-bot/wt-290, detached, since bys/ has the branch checked out)
- Fix (send-confirm.ts only): declined key is now just the run+user-turn (guard.task), not task+tab+button label, so after 「先不发」 every confirmSend path (click, submit, requestSubmit, Enter, script) is refused with REPEAT_TEXT without asking again; a new user turn (e.g. 现在发送吧) gets a fresh ask. Decline/repeat texts now say plainly: user declined sending, don't retry, finish or ask.
- Build builds/p290v3: typecheck clean; no ../../bys agent/extension/shared paths (only node_modules).
- Runs (:8931 /chat, xvfb :47): dec1-3 11.5/13.3/15.9 s, 0 retries after decline, 0 POSTs. decline→现在发送吧→confirm 发送: exactly 1 POST /chat/send. approve run: 1 POST.
- Not exercised: model didn't retry in any of 3 runs, so the blocked-retry path is verified by code only.

## #440 v5: skipped (gone) fields in undo result — de8bd542 (pushed proto/440-on-main)
- Correction: the "gone → 「…」已经不在页面上" line was ALREADY in sidepanel/fill-undo.ts (since e99e4a62), not added by 4333b83e. Verified on 4333b83e (builds/p440v4, run v5b-pc1): result 「还原了 2 处。「标题」「标题」已经不在页面上。…」 and receipt flipped to 已填 4 项 after undo.
- Fix: dedupe skipped names, wording 「…已经不在页面上（例如弹窗已关），跳过了。」, post-undo N = unique fields (sidepanel fill-undo.ts + main.ts).
- Verify builds/p440v5 (v5c-pc1, :8941, 157.6 s, saves [周会纪要]): 「已填 3 项 · 已撤销 · 「正文」撤销不了」 + 「还原了 2 处。「标题」已经不在页面上（例如弹窗已关），跳过了。编辑器里的文字没还原。」

## Ready for QA (09:16)
- proto/290-script-click-confirm ead3c470 — ready for QA testing.
- proto/440-on-main de8bd542 — ready for QA testing.

## #440 v6: skipped-field wording — 1659c444 (pushed proto/440-on-main)
- Only sidepanel/fill-undo.ts gone line: 「「X」已经不在页面上（比如弹窗关了），这一处没法还原。如果它已经保存，请到网站里手动改回。」 (这几处 when >1). 还原了 N 处 prefix unchanged.
- Typecheck clean; builds/p440v6 has no ../../bys agent/extension/shared paths.
- Verify v6-pc1 (:8941, 80.2 s, saves [周会纪要]) rendered: 「还原了 2 处。「标题」已经不在页面上（比如弹窗关了），这一处没法还原。如果它已经保存，请到网站里手动改回。编辑器里的文字没还原。」 (last sentence = existing rich-text note).

## #290 decline-retry scripted test — a0f285e7 (test file only, pushed proto/290-script-click-confirm)
- scripts/acceptance/real-path/program-send-decline-retry.mts: scripted model (not MiniMax), harness isolated build of the worktree source (fix ead3c470), local page on a random port, headless Chromium (EGO_ACCEPTANCE_CHROME=playwright chromium-1208). Decline via the side-panel card 先不发 (07ac3454 asks only in the panel).
- Log: runs/p290-decline-retry.log, runs/p290-decline-retry/result.json. ALL PASS (exit 0).
- First confirm shown, 0 POSTs before decline. After decline: retry click / Enter (press_key on #draft) / script requestSubmit — 0 POSTs, 0 new confirm (page overlay or enabled panel card), all three tool results contain REPEAT_TEXT 「用户这一轮已经拒绝发送（选了「先不发」）…」 (the script one wrapped as sendNote inside the browser_run result; the script itself returns "ok").
- Earlier 2 attempts failed on harness issues: Chrome path unset (hang), then my test looked for 先不发 on the page overlay (none since 07ac3454) → 2-min timeout. Rerun used BYS_RERUN=1 after fixing the test.

- 09:43 下一轮待办（#440 文案，Critiquito 提）：撤销结果改成先列全没还原的再给动作：「还原了 2 处。有 2 处没法还原：「标题」已经不在页面上（比如弹窗关了），编辑器里的文字也没还原。如果已经保存，请到网站里手动改回。」今天不动。

## videos/v2-d-correction.mp4 (09:5x) — proto/483-realmodel-fix 80bdf1ba, no code change
- 20.5 s, 1280x800, h264 30 fps; mid frame videos/v2-d-correction-mid.png. Raw run: runs/v2-d-correction (video.mp4 32.1 s, result.json); first try (host shown as 127.0.0.1) runs/v2-d-correction-try1, not used.
- Build builds/p483rec from wt-correction-loop (node_modules/@sideagent → worktree); no ../../bys agent/extension/shared paths. Real Chromium, xvfb :48, MiniMax-M3.1-Flash-Preview via minimax-cn. Local labeled page 「本地测试页 · 不是真实商店」 (overnight/shop-test-server.mjs on :8963) served as http://shop.test via --host-resolver-rules; address bar + debugging bars cropped out.
- Shows: task 「帮我把推荐的套餐加入购物车。」 → ~2 s later correction 「不对，别点一键加入，点标准版卡片里的「加入购物车」。」 → 已收到 · 接在当前任务里处理 / 已改方向 → clicks 标准版 「加入购物车」, page shows 已加入：标准版 → zoom on 「记下了：以后在这个网站加入套餐时，我会点击套餐卡片里的「加入购物车」，不使用一键加入。 这个网站 撤销」.
- Captions: 「用户中途改口，助手按改过的来做」, 「助手回了一句「记下了」」, sub 「本地测试页 · 一次真实录制（MiniMax-M3.1-Flash-Preview），不代表每次都这样」. No undo in captions; the 撤销 link IS visible on screen (not clicked).
- Caveat: correction arrived before the first click, so the AI never clicked the wrong link; it's "followed the correction", not "undid a wrong action".

## videos/v2-d-correction-v2.mp4 (10:1x) — self-edit of v2-d-correction.mp4, not QA-reviewed
- 9.0 s, 1280x800, h264 yuv420p 30 fps; mid frame videos/v2-d-correction-v2-mid.png, zoom frame videos/v2-d-correction-v2-zoom.png. No build script was found, so this is an ffmpeg edit of the existing mp4 (the address bar was already cropped out; no 127.0.0.1/localhost/port visible).
- Ending cut per QA 10:09: 「记下了」 showed up in 1 of 3 runs, and undo did not make it forget. The clip now ends at 9.0 s, about 2.5 s after the page shows 「已加入：标准版」 (6.5 s). In the source, 记下了/撤销 first appear around 12.5 s. I extracted frames every 0.5 s plus the last frame and checked them: neither 记下了 nor 撤销 is visible.
- Second caption 「助手回了一句「记下了」」 removed (it was only on the cut zoom part). Kept: 「用户中途改口，助手按改过的来做」 + sub-line.
- Correction zoom added from 3.4 to 4.9 s: crop 416x260@(864,50) of the real frames, scaled to full size, on the side-panel message 「不对，别点一键加入，点标准版卡片里的「加入购物车」。」. The bottom caption is hidden during the zoom. No drawn UI.

## videos/v2-d-correction-v3.mp4 (10:1x) — self-edit of v2-d-correction.mp4 (same footage, not re-recorded), not QA-reviewed
- 9.0 s, 1280x800, h264 yuv420p 30 fps; videos/v2-d-correction-v3-zoom.png, videos/v2-d-correction-v3-last.png.
- The zoom crop moved from 416x260@(864,50) to 440x275@(830,72), still on 3.4–4.9 s. 「正在思考 N 秒」 now shows in full, the half 测试页 tag at the top is gone, and the correction message is fully readable.
- Ending not extended: kept the v2 9.0 s ending. In the source mp4, the stop button turns back into send at about 15.5 s, but 记下了/撤销 already show at about 12.5 s. The raw recording has the same order: 记下了 at about 15 s, then the final answer and send button at about 18 s.
- 0.5 s frame check (18 frames + last frame): no 记下了 or 撤销 visible.
