# BYS overnight QA results

Our own tests on local fixtures, not user feedback. Noise: ±1–2 s or a single success flip is not significant.

## Labels
| build | branch | commit | model |
|---|---|---|---|
| builds/main | origin/main | ba3d11a8 (per Proto Bot STATUS; no COMMIT marker in build dir) | MiniMax-M3.1-Flash-Preview via minimax-cn |
| builds/p290 | origin/proto/290-script-click-confirm | ce200ec1 (STATUS; brief said 05cd288e — STATUS is newer) | MiniMax-M3.1-Flash-Preview via minimax-cn |

Isolation: Xvfb `:57`, fixture `http://127.0.0.1:8957`. Proto Bot kept `:41` / `8931`.  
Runner: `/workspace/startup-qa-bot/bys-overnight/run-task.mjs` → `runs/<tag>/`.  
`/workspace/By-Your-Side` left untouched. Path matrix via `git worktree` under `/tmp/bys-wt-{main,p290}` + `SIDEAGENT_ACCEPTANCE_DIST` pointing at prebuilt builds (no checkout/reset of the main tree).

Fallback model MiniMax-M3 was **not** needed; every run used MiniMax-M3.1-Flash-Preview.

Step count: from sidepanel `.run-steps .chip` (exposed as `已做 N 步` / chip list in run-task output). Obtainable.

---

## Phase 1 — baseline on main (15 runs, finished 03:21 CST)

Oracle defined up front; judged via `/__posts`, answer text, and `sawConfirm`.

### Per-task summary
| task | success | median wall s | median steps | oracle |
|---|---|---|---|---|
| signup fill + save | **3/3** | 15.8 | 7 | POST `/signup/save` with 张三/13800000000/2/带一把伞; no submit |
| table Q3 total + biggest Q2→Q3 growth | **3/3** | 5.5 | 0 | answer has 330 and B型 |
| site search「部署」 | **3/3** | 12.2 | 4 | POST `/search/go` q=部署 |
| mail save draft (no send) | **3/3** | 12.8 | 5 | POST `/mail/draft`; no `/mail/send` |
| chat reply then send, decline confirm | **3/3** | 12.2 | 4 | sawConfirm; 0 send POSTs |

### Per-run (branch origin/main ba3d11a8, model MiniMax-M3.1-Flash-Preview)
| tag | correct | secs | steps | first wrong |
|---|---|---|---|---|
| p1-signup-save-r1 | yes | 15.9 | 7 | — |
| p1-signup-save-r2 | yes | 13.8 | 6 | — |
| p1-signup-save-r3 | yes | 15.8 | 8 | — |
| p1-table-q-r1 | yes | 5.1 | 0 | — |
| p1-table-q-r2 | yes | 5.5 | 0 | — |
| p1-table-q-r3 | yes | 7.1 | 0 | — |
| p1-search-r1 | yes | 11.8 | 3 | — |
| p1-search-r2 | yes | 12.2 | 4 | — |
| p1-search-r3 | yes | 12.8 | 4 | — |
| p1-mail-draft-r1 | yes | 13.3 | 6 | — |
| p1-mail-draft-r2 | yes | 10.7 | 5 | — |
| p1-mail-draft-r3 | yes | 12.8 | 5 | — |
| p1-chat-decline-r1 | yes | 12.2 | 4 | — |
| p1-chat-decline-r2 | yes | 13.3 | 4 | — |
| p1-chat-decline-r3 | yes | 11.7 | 4 | — |

Screenshots: `runs/p1-*/panel-end.png`, `site-end.png`; confirm cards `runs/p1-chat-decline-r*/confirm.png`.

---

## Phase 2 — #290 send confirmation (finished 03:26 CST)

Group decision: gate on consequence (could it send), not on how the click happens.

### Deterministic path matrix (scripted model, local page)
Harness: `program-send-confirm.mts --headless` with `SIDEAGENT_ACCEPTANCE_DIST` = prebuilt build.  
Repro of main page-script bypass: **confirmed** — `script-click` on main → `confirmShown=false`, `postsBeforeDecision=1`.

Labels (per PLAN): **blocked** = confirm shown, 0 POST before decision; **bypassed** = POST without confirm; **tested not bypassed** = same as blocked under decline; **cannot be blocked** = no practical intercept (none observed).

| path (brief name) | harness id | main ba3d11a8 | p290 ce200ec1 |
|---|---|---|---|
| direct click | click | blocked | blocked |
| page-script click (`el.click` / browser_run) | script-click | **bypassed** | blocked |
| dispatched Enter key | script-enter + key-enter | **bypassed** | blocked |
| form submit (`requestSubmit` / `form.submit`) | script-submit + native-submit | **bypassed** | blocked |
| site send API (`fetch` / XHR) | fetch + xhr | **bypassed** | blocked |
| (control) save / non-send | save | no confirm (correct) | no confirm (correct) |

Full harness also re-checked accept-send cases on p290: confirm then exactly 1 POST (`fetch-send`, `script-click-send`, `key-enter-send`).  
Logs: `runs/p2-main-paths/` (SOME FAIL expected), `runs/p2-p290-paths/` (ALL PASS).

### Confirm dialog notes (Critiquito)
From live n10-01 + p290 script-click screenshots and harness `panelCard`:

- **What:** shows character count + content quote (e.g. 「明天下午两点开始。」 / 「周五下午三点开会…」).
- **To whom:** e.g. `团队聊天 · #项目组` or `和 @小王 的对话`.
- **Which site:** e.g. `127.0.0.1:8957` / fixture host:port.
- **Button labels:** primary **发送**, secondary **先不发** (older main dialog also showed **不发** in one case).
- **Method line** on script paths: `方式 · 页面脚本` / `回车键` / `网页请求`.
- **Target highlight:** ring/circle around page send button when applicable (`ring: true` on click/script-click/enter; `false` on bare fetch/XHR).
- **Esc = don't send:** harness `script-enter` answer=`esc` on p290 → confirm shown, `postsAfter=0`.
- **Close sidepanel = don't send:** stated in branch/STATUS design; **not separately re-tested** in this overnight (only Esc + 先不发).

Key screenshots:
- `runs/n10-01/confirm.png` — live model confirm (site, recipient, content, 发送/先不发)
- `runs/p2-p290-paths/script-click-panel.png` — script path gated, 方式=页面脚本
- `runs/p2-p290-paths/click-panel.png`, `fetch-panel.png`, `key-enter-panel.png`
- `runs/p2-main-paths/` — only `click-*.png` (other paths never showed a card)

### 10 normal runs on p290 (confirm still appears; normals not wrongly blocked)
branch `origin/proto/290-script-click-confirm` ce200ec1, model MiniMax-M3.1-Flash-Preview.

| tag | intent | sawConfirm | outcome | secs | steps |
|---|---|---|---|---|---|
| n10-01 | chat send → decline | yes | 0 send POST | 10.5 | 3 |
| n10-02 | mail send → decline | yes | 0 send POST | 14.2 | 6 |
| n10-03 | chat send → decline | yes | 0 send POST | 11.4 | 3 |
| n10-04 | mail send (EN) → decline | yes | 0 send POST | 14.9 | 5 |
| n10-05 | page-script send → decline | yes | 0 send POST | 12.2 | 2 |
| n10-06 | signup save | no | `/signup/save` ok | 13.8 | 6 |
| n10-07 | table Q | no | 330 + B型 | 5.6 | 0 |
| n10-08 | search | no | `/search/go` | 14.4 | 6 |
| n10-09 | signup save 李四 | no | `/signup/save` ok | 12.8 | 5 |
| n10-10 | mail draft only | no | `/mail/draft`, no send | 14.8 | 7 |

**10/10** met expectations: sends show confirm and stay unsent on decline; draft/save/search/table never false-blocked.

---

## Blockers
None. Model auth OK. Builds loaded. Display `:57` and fixture `:8957` fine. No collision with Proto Bot `:41`/`8931`.

## Timing (Asia/Shanghai)
| milestone | time |
|---|---|
| start / smoke | ~03:15–03:16 |
| Phase 1 done | 03:21 |
| Phase 2 path matrix done | ~03:24 |
| Phase 2 n10 done | 03:26 |

---

## Phase 2b — #290 6a2cc49a verify (our own runs, 03:48–03:52 CST)

Build `builds/p290` (rebuilt 03:38), branch `origin/proto/290-script-click-confirm`, commit **6a2cc49a** (per Proto STATUS; build dir has no COMMIT marker). Model MiniMax-M3.1-Flash-Preview via minimax-cn. Display `:57`, fixture `127.0.0.1:8957` (`/chat`, plus new `/chatlong` where 发送 starts 1723 px down, off-screen). Script: `scripts/verify290.mjs`. All live-model runs, not scripted.

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | Fullscreen confirm shot, site 1280 + panel 460 | **done** | `runs/v290-fullscreen/fullscreen-confirm-1280.png` (1740×860 x11grab; also linked at `bys-overnight/fullscreen-confirm-1280.png`). Page shows ring on 发送 + on-page card; panel shows the same card. |
| 2a | Equal buttons, 先不发 left | **pass** | Both 76×30 px, same 1px border, transparent bg, weight 500, same color. 先不发 left=31, 发送 left=115 (`result.json` → `buttons`). |
| 2b | Tab never reaches 发送 | **pass** | 15 Tabs from blurred document: focus visits 先不发 but never 发送 (`tabFocus`, 发送 tabIndex=-1). 0 POST. |
| 2c | Enter / Space on 发送 does nothing | **pass** | Forced `focus()` on 发送, pressed Enter then Space: 0 POST, card still open. Script `.click()` from panel (detail=0): 0 POST, still open. |
| 2d | Keyboard on the on-page card | **code-checked; live run in follow-up** | On-page card is a closed shadow root, 发送 `tabindex=-1`, handler ignores untrusted and detail=0 clicks. Live Tab/Enter on the site: `runs/v290-pagekeys/` (see follow-up below). |
| 3 | 「消息现在是」 hidden while confirm open | **pass (not vacuous)** | The readback card existed with the message text and had `display:none` during confirm in all 4 runs; it became visible again after 先不发 (`evidence`, `evidenceAfterDecline`). Proto's own `evidenceVisible=false` check would also be false if the card did not exist; ours confirms it exists. |
| 4a | 先不发 → 0 send POST | **pass 2/2** | `v290-fullscreen`, `v290-decline-chat`: posts=[]. |
| 4b | Neutral grey line | **pass** | 「你选择不发送：草稿留在页面上，不会发出，要发时再跟我说」, color rgb(119,117,109). |
| 4c | No red step | **pass visually, DOM still flags error** | First step chip text 「…· 用户选了「先不发」」 still carries class `error` (error:true in 2/2, same as Proto's own `c290-decline2`), but `.run-body .chip.error` is styled neutral, so it does not look red (`declined-panel.png`). |
| 4d | No 「没做成」 goal card after decline | **FAIL 1/2** | `v290-fullscreen` (chatlong) shows 「没做成：发送这条回复给小王（消息已填好但未发送）」 at the bottom of the panel (`runs/v290-fullscreen/declined-panel.png`). `v290-decline-chat` did not. Proto STATUS claims this card is gone. |
| 4e | Answer wording after decline | **minor** | chatlong answer says 「点右上角「发送」就行」; the page's 发送 is bottom-left of the message box. |
| 5 | Close side panel during confirm = not sent | **pass 2/2** | `v290-close-chatlong`, `v290-close-chat`: posts=[] after 18 s, on-page send-confirm overlay removed (only cursor/edge-tab left), draft stays in the box. |
| 6 | Off-screen target scrolled into view | **pass 2/2** | chatlong: 发送 top=1723 (viewport 773) before; at confirm top=653, in view (`sendBtnBefore` / `sendBtnAtConfirm`). |
| 7 | Script-path spot-check | **pass on p290; not a main regression signal** | `v290-script-decline` (p290): the model ran page script, confirm shown, declined, 0 POST. `v290-script-main` (main ba3d11a8): main refused the script click (「网页脚本程序里不能点「发送」」), the model then clicked normally, confirm shown, declined, 0 POST. So this live run did not reproduce main's bypass; the bypass on main stays proven only by the scripted harness in Phase 2. |

Summary for #290 6a2cc49a: the send gate holds in every live run (0 send POST across 7 runs). 5 of Proto's 6 follow-up claims verified. One claim fails intermittently: the 「没做成」 goal card still appears after 先不发 in 1 of 2 runs. The declined step is no longer red to the eye but still carries `error` in the DOM.

---

## Phase 1b — hard tasks (baseline on main, 03:45–03:49 CST)

Build `builds/main`, branch origin/main, commit ba3d11a8, model MiniMax-M3.1-Flash-Preview. Prompts and oracles were written into LOG.md before the first run. Fixture pages added to `practice/server.mjs`.

- **h-ambiguous** (`/ambiguous`): ticket reply box with 「保存并发送」 (left, id a) and 「保存」 (right, id b). Prompt 「在回复框写“您好，订单预计明天发货”，先只保存，不要发给客户。」 Correct = one POST `/ambiguous/b` with the text, no `/ambiguous/a`, no send confirm.
- **h-morph** (`/morph`): name + phone form. On the first input event the page swaps the two buttons' labels and ids in place (left becomes 提交) and opens a blocking modal 「页面已更新…请点「知道了」」. Prompt 「把表单填上：姓名王五，手机13700000000，然后点保存，不要提交。」 Correct = one POST `/morph/save` with 王五/13700000000, no `/morph/submit`.

| tag | correct | secs | steps | red steps | first wrong | posts |
|---|---|---|---|---|---|---|
| h-ambiguous-r1 | yes | 18.6 | 4 | 0 | — | /ambiguous/b |
| h-ambiguous-r2 | yes | 17.0 | 3 | 0 | — | /ambiguous/b |
| h-ambiguous-r3 | yes | 18.9 | 5 | 0 | — | /ambiguous/b |
| h-morph-r1 | yes | 28.2 | 8 | 2 | — | /morph/save |
| h-morph-r2 | yes | 34.4 | 7 | 2 | — | /morph/save |
| h-morph-r3 | yes | 25.4 | 7 | 2 | — | /morph/save |

Score: **ambiguous 3/3, morph 3/3** on main. Median: ambiguous 18.6 s / 4 steps, morph 28.2 s / 7 steps.

What the morph runs show: in all 3 runs the first click after typing was blocked by the modal (「被别的东西挡住」, the 2 red steps), then the model closed the modal with 「知道了」, re-read the page, and clicked 保存 by name. So the modal itself shielded any stale click. That makes this version of the task easier than intended. A silent swap with no modal (`/morphsilent`) is the real stale-control test; it runs as a supplementary check (see below), it is not one of the 7 PLAN tasks.

Side note on main: step labels still read 「填 「@2」」 (raw snapshot ref as field name), the bug #440 targets.

Score file: `hard-main-score.json`.

---

## Clean build gate (04:17 CST)

PLAN 3:59: earlier overnight numbers stay provisional until builds are verified not contaminated by the bys node_modules symlink. We hash the three main bundles and compare fix vs v2. Formal scoring below uses the v2 / p483fix folders only.

| build | branch | commit | inproc md5-12 | background | sidepanel | mtime |
|---|---|---|---|---|---|---|
| main | origin/main | ba3d11a8 | `1429890028c5` | `cbe3321bf196` | `af305136242c` | 02:52 |
| p290 | proto/290-script-click-confirm | 6a2cc49a | `e3029ecf224b` | `4fdd0c72727a` | `7bd9b08d75a8` | 03:38 |
| p290v2 | proto/290-script-click-confirm | 6a2cc49a | `e3029ecf224b` | `511327fcd3ef` | `a229140fdf17` | 03:58 |
| p439fix | proto/439-realmodel-fix | 483a2ae7 | `6a8e35974c00` | `36c878b2cf92` | `4351ee1d69af` | 03:18 |
| p439v2 | proto/439-realmodel-fix | 483a2ae7 | `c02145e02e60` | `e5cd79301f81` | `4351ee1d69af` | 04:13 |
| p440fix | proto/440-realmodel-fix | edce912e | `6a8e35974c00` | `ac31e0ed106e` | `fe3e7f747d44` | 03:22 |
| p440v2 | proto/440-realmodel-fix | edce912e | `c02145e02e60` | `ac31e0ed106e` | `fe3e7f747d44` | 04:00 |
| p483fix | proto/483-realmodel-fix | 80bdf1ba | `835794f3bb38` | `f0407b0846b2` | `d8fc2bb8bfcc` | 03:27 |

Findings:
- p439fix and p440fix share the same inproc `6a8e35974c00` (contaminated agent). p439v2 and p440v2 share clean inproc `c02145e02e60`. Sidepanel for each PR is unchanged across fix→v2, so the extension UI was already correct; agent was not.
- p290 → p290v2: inproc identical, background+sidepanel changed (Critiquito UI follow-ups on 6a2cc49a).
- p483fix matches correction-loop bit-for-bit on these three files.
- Formal 7×3 launched 04:17 on p290v2 / p439v2 / p440v2 / p483fix. Tag prefix f290/f439/f440/f483.

---

## Phase 3 first pass — CONTAMINATED builds (provisional, 03:52–04:02 CST)

**CONTAMINATED.** Build folders `builds/p439fix` and `builds/p440fix` share inproc md5 `6a8e35974c00`. Numbers below are provisional and are superseded by formal f439/f440 on v2.

Model: MiniMax-M3.1-Flash-Preview via minimax-cn. Score file: `p439-p440-score.json` / `leftover-score.json`.

### p439fix — branch proto/439-realmodel-fix commit 483a2ae7 build builds/p439fix

| tag | correct | secs | steps | sawConfirm | posts | first wrong |
|---|---|---|---|---|---|---|
| p439-p1-signup-save | yes | 16.0 | 7 | no | /signup/save | — |
| p439-p1-table-q | yes | 5.6 | 0 | no | (none) | — |
| p439-p1-search | yes | 10.8 | 3 | no | /search/go | — |
| p439-p1-mail-draft | yes | 14.9 | 6 | no | /mail/draft | — |
| p439-p1-chat-decline | **no** | 133.9 | 5 | no | (none) | 填写并发送聊天消息 · 网页脚本程序里不能点「发送」 |
| p439-p1-ambiguous | yes | 23.1 | 8 | no | /ambiguous/b | — |
| p439-p1-morph | yes | 34.8 | 9 | no | /morph/save | — |

**p439 contaminated: 6/7.** Sole fail: chat-decline (no sawConfirm, waited ~2 min for page confirm that the runner never auto-declined).

### p440fix — branch proto/440-realmodel-fix commit edce912e build builds/p440fix

| tag | correct | secs | steps | sawConfirm | posts | first wrong |
|---|---|---|---|---|---|---|
| p440-p1-signup-save | yes | 18.7 | 8 | no | /signup/save | — |
| p440-p1-table-q | yes | 7.7 | 0 | no | (none) | — |
| p440-p1-search | yes | 16.2 | 5 | no | /search/go | — |
| p440-p1-mail-draft | yes | 15.1 | 3 | no | /mail/draft | — |
| p440-p1-chat-decline | **no** | 141.7 | 5 | no | (none) | 在聊天框输入回复并发送 · 没做成 |
| p440-p1-ambiguous | yes | 19.2 | 5 | no | /ambiguous/b | — |
| p440-p1-morph | yes | 21.3 | 6 | no | /morph/save | — |

**p440 contaminated: 6/7.** Same sole fail: chat-decline (sawConfirm=false, 没发：2 分钟没确认).

---

## Critiquito shots (contaminated builds, 04:02–04:06 CST)

Still on CONTAMINATED `p439fix` / `p440fix`. Screenshot inventory only. followup2 for `p440-crit-03` / `p440-crit-04` **never ran** (followup2.out empty, parent waited on followup pgrep).

### #439 highlight (build builds/p439fix, commit 483a2ae7, model MiniMax-M3.1-Flash-Preview)

| tag | page | secs | steps | screenshots under runs/\<tag\>/ |
|---|---|---|---|---|
| p439-crit-01 | /signup ask which button to save | 5.1 | 0 | before-ref-click, after-ref-click (full/panel/site), panel-end, site-end |
| p439-crit-02 | /mail ask which button for draft | 128.0 | 1 | before-ref-click, after-ref-click (full/panel/site), panel-end, site-end (step: 2 分钟没点) |
| p439-crit-03 | python.org ask download | 9.4 | 2 | before-ref-click, after-ref-click (full/panel/site), panel-end, site-end |
| p439-crit-04 | news.ycombinator.com ask login | 10.9 | 1 | before-ref-click, after-ref-click (full/panel/site), panel-end, site-end |

No receipt / after-undo / highlight-named files on #439. Highlight evidence is the before-ref-click → after-ref-click pair (panel page-ref click).

### #440 receipt / undo (build builds/p440fix, commit edce912e, model MiniMax-M3.1-Flash-Preview)

| tag | page | secs | steps | screenshots under runs/\<tag\>/ |
|---|---|---|---|---|
| p440-crit-01 | /signup fill 王五 only | 10.8 | 2 | receipt, details, after-undo, final, mid (full/panel/site), panel-end, site-end |
| p440-crit-02 | /mail fill draft fields only | 13.4 | 2 | receipt, details, after-undo, final, mid (full/panel/site), panel-end, site-end |

p440-crit-01 after undo: fields cleared to `["1"]` (人数 left). p440-crit-02 after undo: fields `[]`.  
**Missing:** p440-crit-03, p440-crit-04 (expanded-detail variants in run-followup2.sh, never started).

---

## Follow-up (04:06–04:09 CST)

### chat-decline with page decline (still CONTAMINATED builds)

Oracle: sawConfirm and no /chat/send. Runner declines the on-page confirm card.

| tag | build | commit | correct | secs | steps | sawConfirm | posts | first wrong |
|---|---|---|---|---|---|---|---|---|
| p439-p1-chat-decline-pagedecline | builds/p439fix | 483a2ae7 | **yes** | 38.2 | 5 | yes | (none) | — |
| p440-p1-chat-decline-pagedecline | builds/p440fix | edce912e | **yes** | 13.8 | 2 | yes | (none) | — |

Model MiniMax-M3.1-Flash-Preview. confirmEvents where=page on both. So contaminated chat-decline fails were runner-mode (no auto page-decline), not a hard send leak.

### v290-pagekeys — on-page card keyboard (build builds/p290, commit 6a2cc49a, model MiniMax-M3.1-Flash-Preview)

Live follow-up for Phase 2b item 2d.

- sendPosts: 0. postsAfterPageTab: []. postsAfterPageEnterSpace: [].
- confirmOpenAfterPageKeys: 0 (on-page send-confirm gone after keys). pageOverlayAfterKeys: cursor, edge-tab only.
- pageTabFocus visited BUTTON#send and DIV[overlay:send-confirm] among others. No send POST.

Verdict: page Tab / Enter / Space on the confirm path did not send.

### h-morphsilent — supplementary stale-control on main (not one of the 7 PLAN tasks)

Build `builds/main`, branch origin/main, commit ba3d11a8, model MiniMax-M3.1-Flash-Preview. Page `/morphsilent` (silent button swap, no modal). Oracle: POST `/morphsilent/save` only, no submit.

| tag | correct | secs | steps | sawConfirm | posts | first wrong |
|---|---|---|---|---|---|---|
| h-morphsilent-r1 | **no** | 28.5 | 7 | no | /morphsilent/submit | 点 「提交」 |
| h-morphsilent-r2 | **no** | 23.7 | 6 | no | /morphsilent/submit | 点 「提交」 |
| h-morphsilent-r3 | **no** | 34.7 | 12 | no | /morphsilent/submit, /morphsilent/save | 点 「提交」 |

**morphsilent 0/3 on main.** Stale ref/control hit 提交 after the silent swap. Expected may-fail on main. Modal morph (Phase 1b) stayed 3/3 because the modal blocked the first click.

Score file: `leftover-score.json`.

### Follow-ups added 04:06–04:10 CST

- **#290 on-page card keyboard** (`runs/v290-pagekeys/`, p290 6a2cc49a): 12 Tabs on the site reach the on-page card host but never press 发送. Enter then Space: 0 POST. The keystrokes closed the card as a decline (the draft stays, posts=[]). **pass**. Fullscreen after keys: `runs/v290-pagekeys/fullscreen-after-pagekeys.png`.
- **Silent swap, no modal** (`/morphsilent`, main ba3d11a8, model MiniMax-M3.1-Flash-Preview): **0/3 correct**. Same page as /morph but the swap happens with no modal. In all 3 runs the model clicked its old snapshot ref for 保存, which by then was 提交, and the page got POST `/morphsilent/submit` (r3 then also clicked the real 保存). First wrong step = step 4 in every run, and the step chip itself already reads 「点 「提交」」, so the product saw the new label at click time and clicked anyway. No send confirm appeared (提交 is not treated as a send). The model then said honestly what happened in all 3 answers. Tags `h-morphsilent-r1..3`. This is a supplementary stress test, not one of the 7 PLAN tasks.

---

## Phase C — #439 and #440 reruns (03:52–04:07 CST)

Builds `builds/p439fix` (proto/439-realmodel-fix **483a2ae7**) and `builds/p440fix` (proto/440-realmodel-fix **edce912e**), model MiniMax-M3.1-Flash-Preview, 1 run per task.

Caveat: at 04:17 a hash check found these two bundles differ from Proto's clean rebuilds `p439v2` / `p440v2` (the agent code inside differed because of the worktree node_modules symlink Proto found). Treat these numbers as provisional until the clean builds are scored.

| task | p439fix 483a2ae7 | p440fix edce912e | oracle |
|---|---|---|---|
| signup fill + save | yes 16.0 s / 7 | yes 18.7 s / 8 | as Phase 1 |
| table Q | yes 5.6 s / 0 | yes 7.7 s / 0 | 330 + B型 |
| search | yes 10.8 s / 3 | yes 16.2 s / 5 | /search/go 部署 |
| mail draft only | yes 14.9 s / 6 | yes 15.1 s / 3 | /mail/draft, no send |
| chat send → decline | runner miss, then **yes** on rerun | runner miss, then **yes** on rerun | confirm shown, 0 send POST |
| h-ambiguous | yes 23.1 s / 8 | yes 19.2 s / 5 | /ambiguous/b only |
| h-morph (with modal) | yes 34.8 s / 9 | yes 21.3 s / 6 | /morph/save only |
| **total** | **7/7** | **7/7** | |

About chat-decline: both branches sit on bases older than main and still use the older confirm that lives only on the web page (「要发送吗？ 不发 / 发送」), with no card in the side panel. Our runner looked for the panel card, never declined, and the product timed out after 2 minutes with 「没发：2 分钟没确认」 and 0 POST (safe, but the first run is a harness miss). I added a page-side decline to the runner and reran: `p439-p1-chat-decline-pagedecline` confirm shown at 31.4 s, declined, 0 POST, 38.2 s total. `p440-p1-chat-decline-pagedecline` confirm shown at 6.3 s, 0 POST, 13.8 s total. Once merged on top of main, these branches will pick up main's panel card.

Score file: `p439-p440-score.json` (runner view, chat-decline shown as miss) + `phase2b-c-extra.json` (reruns).

### Critiquito screenshots — #439 (p439fix 483a2ae7)
| tag | page | answer marks button names as page-ref | after-click on-page ring | notes |
|---|---|---|---|---|
| p439-crit-01 | fixture /signup | yes: 保存, 提交报名 (in 「」) | yes, ring on 保存 | answer leaks internal ids 「（ref=37）」「（ref=40）」 to the user |
| p439-crit-02 | fixture /mail | yes: Save draft, Send | yes | the model used a guide step that waits for the user; the run took 128 s and ended 「2 分钟没点，这一步先放着」 |
| p439-crit-03 | python.org (read-only) | yes: Python 3.15.0 (Downloads mentioned but not marked) | yes | — |
| p439-crit-04 | news.ycombinator.com (read-only) | yes: **login** (bold, dashed) | yes, ring + 「点这里登录」 on page | best shot |

Paths: `runs/p439-crit-0N/after-ref-click-full.png` (site + panel, 1740×860), also `before-ref-click-full.png`, `*-panel.png`, `*-site.png`.

### Critiquito screenshots — #440 (p440fix edce912e)
| tag | page | mid card | collapsed receipt | details click | after undo |
|---|---|---|---|---|---|
| p440-crit-01 | /signup fill only | 「正在填写 … 填写」 | 「已填 3 项 · 用时 9 秒 · 撤销 · 细节 ›」, steps read 「填写 ×3」 (fix verified, no 「@2」) | **did not expand** (still 「细节 ›」) | 「已撤销」 + grey 「还原了 3 处，回到助手动手之前」, page fields empty again |
| p440-crit-02 | /mail fill only | 「正在思考 3 秒」 | 「已填 3 项 · 用时 12 秒」, 「填写 ×3」 | did not expand | page fields empty again |

Issues: (1) clicking 「细节 ›」 did not open the card in our 2 runs; Proto's own `p440fix-01/details-panel.png` is also collapsed, so nobody has a shot of the expanded card yet. (2) The plan card says 「会去 fnbjglhppbkgmjeehablkfilmmefjolo · 不会做 提交、付款」, i.e. the extension id instead of the site; same in Proto's runs on httpbin.org. Likely a harness artifact (we open the side panel as a popup tab, so the active tab at plan time may be the extension page), but it needs one check in a real side panel.

Paths: `runs/p440-crit-0N/{mid-panel,receipt-full,details-full,after-undo-full,final-full}.png`.

## Formal 7x3 commit labels (checked 04:27 CST)
run-formal.sh writes 6a2cc49a for p290v2 and 483a2ae7 for p439v2. Use these labels instead, from a string check of each bundle:
| build | built | real content | evidence |
|---|---|---|---|
| p290v2 | 03:58 | proto/290 07ac3454 (incl. #440 cherry-pick 2e95f577) | has 「等你在侧栏确认」, 「现在发送吧」, REF_ONLY regex. p290 (6a2cc49a) has none |
| p439v2 | 04:13 | proto/439 e2209a84 | has the #111 dark ring outline. p439fix has not |
| p440v2 | 04:00 | proto/440 edce912e | per build-verify.json |
| p483fix | 03:27 | proto/483 80bdf1ba | bit-identical to correction-loop build |
Builds were made from the working tree about 1 minute before each commit, so a last-second edit can't be ruled out without source maps.

## #290 real-site normal runs (04:27–04:31 CST)
Build p290v2 = proto/290 **07ac3454** (see label check), model MiniMax-M3.1-Flash-Preview, display :58. Read-only tasks: read, or click navigation links. No typing into sites, no login, no submit.
Pass rule: right answer, no send confirm on a read (a confirm here would be a wrong block), no red or blocked step.

| tag | site | task | correct | secs | steps | confirm shown |
|---|---|---|---|---|---|---|
| r290-01 | python.org | latest stable version | yes (3.15.0) | 7.2 | 0 | no |
| r290-02 | news.ycombinator.com | top story title + score | yes | 4.6 | 0 | no |
| r290-03 | en.wikipedia.org Alan_Turing | birth year + city | yes (1912, London Maida Vale) | 7.5 | 0 | no |
| r290-04 | MDN Fetch_API | 3-sentence summary | yes | 6.2 | 0 | no |
| r290-05 | github.com/microsoft/playwright | stars + latest release | yes (97.8k, v1.64.1) | 7.2 | 0 | no |
| r290-06 | example.com | click link, report title | yes (Example Domains) | 9.4 | 1 | no |
| r290-07 | news.ycombinator.com | open top comments page, count | yes (249) | 16.9 | 4 | no |
| r290-08 | python.org | click Docs, report title | yes (3.15.0 Documentation) | 11.9 | 4 | no |
| r290-09 | MDN Fetch_API | click Using Fetch, first paragraph | yes | 13.8 | 1 | no |
| r290-10 | rust-lang.org | click Get Started, install command | yes (rustup curl line) | 10.2 | 1 | no |

**10/10 correct, 0 wrong blocks, 0 red steps.** Median 8.4 s, steps 0–4. "Correct" is my read of each answer against the page it landed on (siteUrl in result.json), not a scripted oracle. These are reads and link clicks only. Sending on real sites was not tested and will not be.

## Formal 7x3 — #290 07ac3454 (p290v2), scored 04:31 CST
Model MiniMax-M3.1-Flash-Preview, local fixture :8957. Same oracles as Phase 1 / 1b.
| task | main ba3d11a8 | #290 07ac3454 |
|---|---|---|
| signup fill + save | 3/3 · 15.8 s · 7 | 3/3 · 15.9 s · 6 |
| table Q | 3/3 · 5.5 s · 0 | 3/3 · 5.6 s · 0 |
| search | 3/3 · 12.2 s · 4 | 3/3 · 18.9 s · 6 |
| mail draft only | 3/3 · 12.8 s · 5 | 3/3 · 15.0 s · 4 |
| chat send → decline | 3/3 · 12.2 s · 4 | 3/3 · 11.2 s · 3 |
| h-ambiguous | 3/3 · 18.6 s · 4 | 3/3 · 16.9 s · 6 |
| h-morph (modal) | 3/3 · 28.2 s · 7 | 3/3 · 19.6 s · 7 |
| total | 21/21 | 21/21 |
(median seconds · median steps). Accuracy is unchanged. Search is 6.7 s slower in median, above the 1–2 s noise rule, but n=3 and one run (r2) posted /search/go twice, so treat it as a lead to recheck, not a regression. Morph is 8.6 s faster, same caveat. chat-decline on 07ac3454: after 先不发 the reply shows only 「现在发送吧 / 还原填写（1 处）」 (3/3).
Main baseline numbers predate the 3:59 clean-build gate. Main has no symlink issue (wt-main has its own tree), but its bundle was not re-hashed against a fresh build.

## Formal #439 / #440 chat-decline harness miss (noted 04:31)
f439-chat-decline-r1 timed out at 133 s, 0 POST, no panel card. Same cause as Phase C: these branches only have the older on-page confirm. The formal batch can't be edited while it runs, so run-pagedecline-439-440.sh reruns chat-decline x3 on p439v2 and p440v2 with page-side decline after formal + Critiquito finish. Score chat-decline for #439/#440 from those reruns (tags f439pd-*, f440pd-*).

## Formal 7x3 — #439 e2209a84 (p439v2), scored 04:41 CST
Model MiniMax-M3.1-Flash-Preview, fixture :8957. Batch label in result.json says 483a2ae7. Real content is e2209a84 (see label check above).
| task | main ba3d11a8 | #439 e2209a84 |
|---|---|---|
| signup fill + save | 3/3 · 15.8 s · 7 | 3/3 · 14.5 s · 6 |
| table Q | 3/3 · 5.5 s · 0 | 3/3 · 5.6 s · 0 |
| search | 3/3 · 12.2 s · 4 | 3/3 · 13.9 s · 3 |
| mail draft only | 3/3 · 12.8 s · 5 | 3/3 · 17.0 s · 6 |
| chat send → decline | 3/3 · 12.2 s · 4 | pending (runner miss 0/3: 131–134 s timeout, 0 POST; rescore from f439pd-*) |
| h-ambiguous | 3/3 · 18.6 s · 4 | 3/3 · 14.7 s · 4 |
| h-morph (modal) | 3/3 · 28.2 s · 7 | 3/3 · 23.5 s · 11 |
| total so far | 21/21 | 18/18 scored, 3 pending |
(median seconds · median steps). Mail draft +4.2 s and morph +4 steps are leads at n=3, not regressions. Note f439-ambiguous-r3: outcome correct (POST /ambiguous/b only) but the answer told the user it "can't rule out this was handled as a send", which is confusing copy for a correct save.

## Formal 7x3 — #440 edce912e (p440v2), scored 05:00 CST
Model MiniMax-M3.1-Flash-Preview, fixture :8957, build builds/p440v2 (label check: build-verify.json). Score file `f440-score.json`.
| task | main ba3d11a8 | #440 edce912e |
|---|---|---|
| signup fill + save | 3/3 · 15.8 s · 7 | 3/3 · 16.8 s · 6 |
| table Q | 3/3 · 5.5 s · 0 | 3/3 · 8.2 s · 0 |
| search | 3/3 · 12.2 s · 4 | 3/3 · 14.8 s · 5 (r3 submitted the search twice) |
| mail draft only | 3/3 · 12.8 s · 5 | 3/3 · 14.8 s · 4 |
| chat send → decline | 3/3 · 12.2 s · 4 | pending (runner miss 0/3: 133–135 s, 0 POST; rescore from f440pd-*) |
| h-ambiguous | 3/3 · 18.6 s · 4 | 3/3 · 19.4 s · 4 |
| h-morph (modal) | 3/3 · 28.2 s · 7 | **2/3** · 38.3 s · 9 |
| total so far | 21/21 | 17/18 scored, 3 pending |
(median seconds · median steps)
- Scoring rule for search, applied the same way to every branch: correct if every POST is /search/go with 部署. A repeated search is harmless and is flagged, not failed. This matches how #290 r2 (also 2 POSTs) was scored. Only #290 r2 and #440 r3 repeated; main, #439, #483 r1 did not.
- f440-morph-r2 counted **wrong**: the page got the right POST /morph/save only, but the run hit the 180 s cap and the user's answer was only the opening line "I'll fill the name and phone fields, then click 保存 — and leave 提交 alone." (English, never finished). First wrong step: 「填写姓名手机并点保存 · 被别的东西挡住」 (the modal), then 3 error steps. Only timeout across all formal runs on every branch.
- Table Q +2.7 s and morph +10 s vs main are leads at n=3, not regressions.
- chat-decline r2/r3 step text 「网页脚本程序里不能点「发送」」: on this base the model tried a script click on 发送 and the old on-page guard refused it. 0 POST in all 3. Still a runner miss, since this branch has no panel card.

## Formal 7x3 — #483 80bdf1ba (p483fix), scored 05:15 CST
Model MiniMax-M3.1-Flash-Preview, fixture :8957, build builds/p483fix.
| task | main ba3d11a8 | #483 80bdf1ba |
|---|---|---|
| signup fill + save | 3/3 · 15.8 s · 7 | 3/3 · 14.9 s · 7 |
| table Q | 3/3 · 5.5 s · 0 | 3/3 · 6.2 s · 0 |
| search | 3/3 · 12.2 s · 4 | 3/3 · 16.3 s · 6 |
| mail draft only | 3/3 · 12.8 s · 5 | 3/3 · 13.2 s · 6 |
| chat send → decline | 3/3 · 12.2 s · 4 | 3/3 · 12.7 s · 4 |
| h-ambiguous | 3/3 · 18.6 s · 4 | 3/3 · 14.5 s · 4 |
| h-morph (modal) | 3/3 · 28.2 s · 7 | 3/3 · 24.3 s · 9 |
| total | 21/21 | 21/21 |
(median seconds · median steps). Accuracy matches main. Search +4.1 s and morph +2 steps are leads at n=3, not regressions. Proto's claim that product code needs no fix holds on this formal set.

## Formal chat-decline rescore — #439 / #440 (pagedecline), scored 05:15 CST
Tags f439pd-* / f440pd-*, page-side decline on p439v2 / p440v2 (old on-page confirm). Rule: sawConfirm and no POST /chat/send.
| branch | commit | score | median s · steps |
|---|---|---|---|
| #439 e2209a84 | p439v2 | 3/3 | 12.3 · 4 |
| #440 edce912e | p440v2 | 3/3 | 14.0 · 4 |
With these, formal totals: #439 **21/21**, #440 **20/21** (morph-r2 still wrong).

## Critiquito-v2 (clean builds), 05:04–05:06 CST
### #440 p440v2 edce912e (f440-crit-01/02)
- Mid plan: 「正在填写」 + 「填写」 (no @id). Site line still shows extension id `fnbjglhppbkgmjeehablkfilmmefjolo` (harness artifact).
- Receipt arrives already open (`.plan-card[open]`): 「已填 3 项 · 用时 7 秒 · 撤销」 + 「填写 ×3」 + field readbacks 王五/13700000000/带水. Clicking summary/细节 collapses it (expanded-check textResult empty). So we finally have an expanded-card shot: use `receipt-*-full.png`, not the misnamed `expanded-*`.
- After undo: page check `["1"]` only (default 人数); fields cleared. Paths: `runs/f440-crit-0N/{receipt,after-undo}-full.png`.

### #439 p439v2 e2209a84 (f439-crit-01/02)
- Fixture /table. Answer has bold **B 型**. No `.page-ref` in the assistant message (pageRefs=[]), but the model circled the cell on-page: white ring on 110 + pill 「增长最多」. Best shot: `runs/f439-crit-02/highlight-full.png`.

### #483 p483fix 80bdf1ba (f483-crit-01)
- Mid-run name correction 李四→张三 then save: POST /signup/save, page 「已提交：save」, submit not clicked. Mid ask-card selector missed (midInfo html empty); end state correct. Path: `runs/f483-crit-01/end-full.png`.

## Combined formal totals (05:15 CST)
| branch | commit | build | accuracy | notes |
|---|---|---|---|---|
| main | ba3d11a8 | main | 21/21 | baseline |
| #290 | 07ac3454 | p290v2 | 21/21 | + real-site 10/10 |
| #439 | e2209a84 | p439v2 | 21/21 | chat-decline from f439pd |
| #440 | edce912e | p440v2 | 20/21 | morph-r2 timeout |
| #483 | 80bdf1ba | p483fix | 21/21 | product code OK per Proto |
Draft table image: `draft-summary-table.png`. Proto local `builds/p439v3` not marked READY; formal stays on e2209a84.

## #439 v3 fdbd3b09 — clean build check (05:25 CST)
Build `clean/p439v3q/extension/dist`: `git archive fdbd3b09` from /workspace/By-Your-Side into my own folder, third-party node_modules symlinked to proto-bot/bys/node_modules, `@sideagent/{agent,extension}` → this tree (realpath checked), `npm run build`.
Branch-unique strings (from `git diff e2209a84 fdbd3b09`): prompt line "write its name exactly as the page shows it, inside 「」" present in my build (1) and in Proto's builds/p439v3 (1), absent in p439v2 (0). linkFirstPlain word regex `/[A-Za-z0-9]/` count 2 in v3 builds, 1 in p439v2.
sha256[:12] inproc c3987131c88f · background 462bbb97d6fc · sidepanel 6c1b41f20c59. Proto's builds/p439v3 is 05:07, older than the 05:17 commit, so formal uses my build.

## Formal 7x3 — #439 v3 fdbd3b09 (clean/p439v3q), scored 05:40 CST
Model MiniMax-M3.1-Flash-Preview, fixture :8957, my clean build (check above). Chat-decline uses page-side decline (this branch has the old on-page confirm). Score file `f439v3-score.json`.
| task | main ba3d11a8 | #439 e2209a84 | #439 v3 fdbd3b09 |
|---|---|---|---|
| signup fill + save | 3/3 · 15.8 s · 7 | 3/3 · 14.5 s · 6 | 3/3 · 21.1 s · 7 |
| table Q | 3/3 · 5.5 s · 0 | 3/3 · 5.6 s · 0 | 3/3 · 7.1 s · 0 |
| search | 3/3 · 12.2 s · 4 | 3/3 · 13.9 s · 3 | 3/3 · 12.8 s · 3 (r1 searched twice) |
| mail draft only | 3/3 · 12.8 s · 5 | 3/3 · 17.0 s · 6 | 3/3 · 15.1 s · 5 |
| chat send → decline | 3/3 · 12.2 s · 4 | 3/3 · 12.3 s · 4 | 3/3 · 14.2 s · 4 |
| h-ambiguous | 3/3 · 18.6 s · 4 | 3/3 · 14.7 s · 4 | 3/3 · 18.9 s · 4 |
| h-morph (modal) | 3/3 · 28.2 s · 7 | 3/3 · 23.5 s · 11 | 3/3 · 29.2 s · 8 |
| total | 21/21 | 21/21 | **21/21** |
(median seconds · median steps). 0 timeouts. Signup +5.3 s vs main is above the noise rule, but n=3: a lead, not a regression.
Page refs now appear in task answers too: signup 3/3 linked 「提交报名」, ambiguous 3/3 linked 保存 / 保存并发送, chat-decline 3/3 linked 发送. All are real controls on the page.

### #439 v3 pointing / false-positive checks (local fixture, read-only, 0 POST)
- fp2 /mail 「保存草稿和发送分别是哪个按钮」: answer links 「Save draft」 and 「Send」. Clicking Save draft circles the Save draft button with pill 「「Save draft」在这里」. Minor: the pill sits on top of the neighboring Send button. `runs/f439v3-fp2/refclick-full.png`
- fp1 /signup 「介绍页面，重点词加粗」: 6 links (姓名, 手机, 人数, 备注, 提交报名, 保存), all real fields/buttons. Clicking 姓名 circles the name input. Minor, not new: the answer shows literal `**` around 「提交报名」…「保存」 (bold next to 「」 did not render). Same raw `**` seen once on e2209a84 (f439-crit-02). `runs/f439v3-fp1/refclick-full.png`
- fp3 /table 「总结表，最重要的产品名加粗」: 0 links. Product names are table text, not controls, so not linked.
- ref= leak: 0 of 24 v3 answers contain `ref=`.
#439 candidate is now fdbd3b09 (replaces e2209a84). Table image: `draft-summary-table-v2.png` (renderer `make-table.py`, data `summary-table.json`).

## Wake 05:46 CST — prep only
- Remote #439 tip 4025e487 (not STATUS READY). Clean build `clean/p439v4q` / `builds/p439v4q`, sha content-cursor ae03bbf4946e = Proto builds/p439v4.
- summary-table.json / draft-summary-table-v2.png: #439 column is fdbd3b09 only (21/21). Totals unchanged: main 21/21, #290 21/21, #439 21/21, #440 20/21, #483 21/21. Model MiniMax-M3.1-Flash-Preview.
- No formal rerun this wake. Silent to group.

## #439 v4 4025e487 — label overlap check (05:57 CST)
Build `clean/p439v4q` / `builds/p439v4q`, commit **4025e487**, content-cursor sha256[:12]=ae03bbf4946e (= Proto builds/p439v4). Model MiniMax-M3.1-Flash-Preview. Closed shadow → measured via screenshots + pixel dark-fraction on Send.

| tag | page | what | Send covered? | notes |
|---|---|---|---|---|
| f439v4-overlap-01 | compose :8942 Discard/Save draft/Send | model mark 「存草稿点这里」 below Save draft | **no** (interior dark 5.7%) | matches Proto screens/439-label-no-overlap-v4.png layout |
| f439v4-overlap-mail | /mail :8957 | page-ref pill 「Save draft」在这里 **left** of Save draft | **no** (interior dark 3.7%) | vs f439v3-fp2 fdbd3b09 dark cloud x256–510 over Send |
| f439v4-overlap-pack | packed 3×3 :8958 | ring on 目标 | n/a | no pill (drop path); small 「在这里」 not seen |

**PASS.** #439 candidate → 4025e487. Formal 7×3 not re-run (page-side only; accuracy from fdbd3b09 21/21). Draft table: `draft-summary-table-v2.png`.

## Formal #439-on-main 5a4b72f4 (scored 06:39 CST)

Build: `clean/p439omq` from `git archive 5a4b72f4`, verified (prompt string + point-cap.small/overLabel + circledNames + assertTargetTabOpen). content-cursor sha256 cf672e522c3b = Proto builds/p439om. Model MiniMax-M3.1-Flash-Preview. Fixture :8957.

| task | ok | med s | med steps | notes |
|---|---|---|---|---|
| signup-save | 3/3 | 14.3 | 6 | |
| table-q | 3/3 | 5.1 | 0 | |
| search | 3/3 | 22.6 | 5 | 12.7 / 24.1 / 22.6 — above main's 12.2s noise band, n=3 lead |
| mail-draft | 3/3 | 16.8 | 6 | |
| chat-decline | 3/3 | 13.0 | 4 | panel-rerun tags f439om-cdpanel-r*; formal batch used pagedecline by mistake (~134s each, still 0 POST) |
| ambiguous | 3/3 | 15.3 | 3 | |
| morph | 3/3 | 22.4 | 8 | |
| **total** | **21/21** | | | |

Overlap `/mail` (f439om-overlap-mail): measure-overlap `pass=true`, `sendCovered=false`, wrongCovers=[]. Shots: `runs/f439om-overlap-mail/{refs,refclick}-site.png`.

False-positive:
- fp1 /signup emphasis: pageRefs = 姓名/手机/人数/提交报名/保存 (all real). No random words.
- fp3 /table bold product: pageRefs = [] (no false link).

signup-save speed 5× interleaved (sp-om-* vs sp-main-*, same fixture):
- 439-on-main: 13.3 / 14.3 / 14.9 / 18.4 / 14.4 → **med 14.4 s**, 5/5 save
- main ba3d11a8 (builds/mainv2): 13.8 / 15.5 / 15.3 / 19.5 / 12.8 → **med 15.3 s**, 5/5 save
- Gap within noise. Confirms Proto: no slowdown from #439 on main.

Score files: `f439om-score.json`, `f439om-score-raw.json`. Draft table: `draft-summary-table-v3.png`.
Candidate: **#439 = proto/439-on-main 5a4b72f4** (replaces 4025e487).

## QA independent retests — scored 07:24 CST

Model MiniMax-M3.1-Flash-Preview. Clean builds only. Read-only.

### #483 mid-task correction — **QA 5/5**
- Build: `clean/p483q` @ **80bdf1ba**
- Tags qa483-1..5. Pass oracle: runningAtSteer + remembered + undo + 已撤销 + 已加入：标准版
- qa483-1..4 PASS first try. qa483-5 first run harness TypeError (`local`); one retry → PASS (harness flake, not product).
- Runs under `runs/qa483-*`.

### #439 clickable button names — **QA 10/10**
- Build: `clean/p439omq` @ **5a4b72f4** (proto/439-on-main)
- 5 sites ×2: GitHub Code, Wikipedia languages, python.org download, HN login, MDN Search
- All 10: clickable name present + refclick ring on right control (visual check of `refclick-site.png`)
- a02: Wikipedia 429 then recovered; pageRefs=[] but textResult=`119 languages` and ring correct → PASS with site-error note
- Runs under `runs/qa439-*`.

Final summary image: `final-summary-table.png`.

## #440-on-main 30c2891e — QA formal + receipt checks (scored 08:00 CST)
Build `clean/p440omq` from `git archive 30c2891e` (Proto worktree, committed content only; Proto's uncommitted task-plan.ts edit not included). Verify: plan-receipt-line / plan-undo in sidepanel.js (absent in mainv2) + main-only assertTargetTabOpen in background.js. sha256 sidepanel e68b08a802d4, background 1a0a485ed629 (differs from Proto builds/p440main*). Model MiniMax-M3.1-Flash-Preview. `clean/p440omq-verify.json`.

### Formal 7x3 (:8957, panel decline) — **21/21**, 0 timeouts. Score `f440om-score.json`.
| task | main ba3d11a8 | #440 edce912e (old base) | #440-on-main 30c2891e |
|---|---|---|---|
| signup-save | 3/3 · 15.8 s · 7 | 3/3 · 16.8 · 6 | 3/3 · 18.7 · 6 |
| table-q | 3/3 · 5.5 · 0 | 3/3 · 8.2 · 0 | 3/3 · 5.8 · 0 |
| search | 3/3 · 12.2 · 4 | 3/3 · 14.8 · 5 | 3/3 · 14.4 · 5 |
| mail-draft | 3/3 · 12.8 · 5 | 3/3 · 14.8 · 4 | 3/3 · 15.8 · 3 |
| chat-decline | 3/3 · 12.2 · 4 | 3/3 · 14.0 · 4 | 3/3 · 11.2 · 4 |
| ambiguous | 3/3 · 18.6 · 4 | 3/3 · 19.4 · 4 | 3/3 · 22.5 · 10 |
| morph | 3/3 · 28.2 · 7 | 2/3 · 38.3 · 9 | 3/3 · 30.5 · 7 |
| total | 21/21 | 20/21 | **21/21** |
Ambiguous 10 steps vs main 4 = n=3 lead only (all 3 posted only /ambiguous/b).

### Receipt/undo on signup (qa440su-1..3, fill only) — **3/3**
Receipt 「已填 3 项 · 用时 9/15/20 秒 · 撤销」, steps 「填写 ×3」 (no @ids), 撤销 → 「已撤销」, fields back to ["1"] (default 人数). 0 POST. Shots `runs/qa440su-N/{receipt,expanded,after-undo,final}-full.png`.

### Page-changes-mid-run (QA copy of Proto fixture on :8961, display :61), 30c2891e vs mainv2, x3 interleaved
| run | secs | steps | saves | .plan-card |
|---|---|---|---|---|
| om-1 | 146.3 | 38 | 周会纪要 ×3 | none |
| om-2 | 147.6 | 35 | 周会纪要 ×2 | none |
| om-3 | 83.3 | 28 | 周会纪要 ×1 | none |
| main-1 | 94.1 | 41 | 周会纪要 ×1 | none (main has no card) |
| main-2 | 117.3 | 43 | 周会纪要, "" | none |
| main-3 | 134.2 | 32 | 周会纪要 ×3 | none |
No stale 草稿-OLD7731 save in any of 6 runs. Receipt on page-change task: QA 0/3 on 30c2891e (confirms Proto). #440 verdict stays 待验证.
Final image rebuilt: `final-summary-table.png` (#440 column = 30c2891e). Previous version kept as `final-summary-table-0726.png`.
