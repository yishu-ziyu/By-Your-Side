# Competitor examples replicated in BYS — 自测 (self-test, local fixtures only)

Build main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02 (clean worktree builds/wt-ba3d11a8). Model MiniMax-M3.1-Flash-Preview (minimax-cn). 1 recorded run per example (ego-passenger: 3 runs). Fixtures: replicate/_fx/server.mjs on port 8995 (ego-passenger: its own server on 8991). Each example has replicate/<slug>/{criteria.md,run.mp4,final.png} and runs/<slug>/r1/{result.json(with build),state.json,panel-end.png,site-end.png}. Scoring uses server state and the final page, not BYS's summary.
Issue links: the open issues in yishu-ziyu/By-Your-Side (#237, #290, #291, #484) don't cover any of the missing capabilities below, so each still needs an issue filed (not filed — no public actions taken).

**Totals (20 new examples): 通过 13 · 做错了 2 · 缺功能 5; plus ego-passenger 通过 2/3 runs**

## 通过
| example | claim | BYS was asked | what went wrong | 用户知不知道发生了什么 | video |
|---|---|---|---|---|---|
| ego-passenger | flights→nonstop preferred→cheapest→pre-fill→stop at payment | full flow, 18 fields (3 runs) | 2/3 pass; r1 total ¥4,920 without tax (page ¥5,560); false 「已提交，收不回」 | 知道 | ego-passenger/run.mp4 |
| ego-x-leaderboard | 7-day main-post leaderboard + averages | rank @lumen_ai main posts, avg views/likes | none (correct order, 18,740 / 400) | 知道 | ego-x-leaderboard/run.mp4 |
| ego-mortgage | filter homes, top match, recalc mortgage | Hangzhou ≤3M apartment, down 900k | correct (Wensan Rd 88, ¥2,850,000, ¥8,756); placeholder 「见下方卡片」 shown in place of 2nd listing price | 知道 | ego-mortgage/run.mp4 |
| ego-linkedin-jobs | AI SWE SF, drop senior/stale, 10 companies + links | 2-page list | all 10 correct, links correct; answer text self-contradicts ("3 个超过 30 天…实际只有这两个") | 知道 | ego-linkedin-jobs/run.mp4 |
| ego-generic | research + fill forms | lightest laptop ≥10h → purchase form | correct (FeatherX 13, 9299, 2, 出差用, approver empty, not submitted) | 知道 | ego-generic/run.mp4 |
| ego-e2e | numbered E2E steps, pass/fail with evidence | todo app 5 steps (delete bug) | correct (4 pass, step 5 fail, root cause found); it added extra items 甲/乙 to reproduce and rebuilt the page state on its own | 知道 | ego-e2e/run.mp4 |
| sider-forms | manage tools, fill forms, check data | toggles + contact + check total | correct; total ¥1,320 vs ¥1,230 found; template placeholder 「{=real}」 leaked into answer | 知道 | sider-forms/run.mp4 |
| sider-seo | Ahrefs competitor keywords/pages/backlinks/gaps | rivala/rivalb vs mysite | correct gaps + backlinks | 知道 | sider-seo/run.mp4 |
| sider-hiring | career pages → talent brief | Alpha/Beta/Gamma counts by dept | counts correct (6/6/2, closed role excluded); brief wrongly says the closed Head of Sales was Beta's (it is Gamma's) | 知道 | sider-hiring/run.mp4 |
| sider-reviews | cluster low-star complaints | 2 pages, 1-2★ | correct (battery 3, shipping 2, app 2, color 1); typo 「差验」 | 知道 | sider-reviews/run.mp4 |
| sider-reddit | hot posts across subs → idea sheet | top 3 per sub, no pinned | correct (9 posts) | 知道 | sider-reddit/run.mp4 |
| sider-yt-sheets | YouTube metadata → Sheets | top 5 non-ad/non-short into mock sheet | correct A1:D6 in sheet (header row repeated in answer card) | 知道 | sider-yt-sheets/run.mp4 |
| sider-events | event dates/locations/prices | 3 sites, regular ticket | correct (¥1,280 / ¥699 / ¥599) | 知道 | sider-events/run.mp4 |
| sider-contacts (rerun r3) | contact pages → spreadsheet | 3 companies' email/phone/address → spreadsheet file | r2 died the same way as r1 (「模型这次没有回答」 after 3 steps, 8 s); r3 (BYS_RERUN=1) passed: all 3 emails/phones/addresses correct, careers/press emails and fax numbers excluded, and a 「生成文件」 step produced a CSV that it says can be downloaded from the sidebar (I didn't open the file). Addresses were translated to Chinese; raw markdown links shown in the source line | 知道 | sider-contacts/run.mp4 (r3; r2 in run-r2.mp4) |

## 做错了 (has the capability, did it wrong)
| example | claim | BYS was asked | what went wrong | 用户知不知道发生了什么 | video |
|---|---|---|---|---|---|
| ego-chess | play a game until it ends, reading the board each turn | play White vs bot until the game ends | hit the 420 s cap: only 7 White moves (e4, Nf3, Bb5, a4, Bd3, h4, c4), no plan to mate. Cause (from state timestamps + panel): after move 3 it stalled ~6.5 min re-reading the board through repeated 「在页面里运行代码」 steps (12 step errors, "12 步换了做法"), then made aimless pawn moves. Clicking squares worked, so the capability exists; the failure is slow, aimless play. | 不知道 (panel stuck on 「正在等待」, no status or ending) | ego-chess/run.mp4 |
| sider-price | Amazon price tracker → spreadsheet | top 5 non-sponsored → CSV file | 0 steps, 6 s: answered 「我直接生成 CSV」 and stopped; no table, no file, no data | 不知道 | sider-price/run.mp4 |

## 缺功能 (BYS lacks the capability; issue to be filed)
| example | claim | BYS was asked | where it stopped / missing capability | 用户知不知道发生了什么 | video |
|---|---|---|---|---|---|
| ego-job-apply | fill application from resume PDF, stop before submit | find job, fill from ~/Documents/resume.pdf incl. upload | found the right job (Nimbus) and opened careers; 「上传文件 · 找不到文件 resume.pdf」 failed; no fields filled; panel went 「已暂停 / 你在操作·助手在旁边等」 until the 240 s timeout. Missing: **reading local files / local file upload** | 不知道 | ego-job-apply/run.mp4 |
| ego-social | reply/quote with own notes, monitor mentions | use ~/notes/evals.md, quote, hourly monitoring | stopped cleanly, nothing posted. Missing: **local notes access, scheduled monitoring** | 知道 (explains both gaps, asks for notes) | ego-social/run.mp4 |
| ego-devqa | find layout bug, edit repo, reload, verify | fix App.css in repo | said it can't edit disk files, then the model timed out (retry card); no answer. Missing: **editing the local repo** | 知道 | ego-devqa/run.mp4 |
| sider-files | research → PPT/PDF/DOC; monitor prices | PPT + PDF from page, daily monitoring | tried to build PPTX/PDF with page code and download them (1 failed), memory writes timed out ×2, ended at 151 s with no final answer; the files were not confirmed. Missing: **file generation (PPT/PDF), scheduling** | 不知道 | sider-files/run.mp4 |
| sider-code | change page by NL and remember per site | remove Shorts, auto-remove every visit | removed the Shorts shelf (kept the 'Shorts vs long videos' distractor), but persistence is only a memory note: it admits "刷新一下 Shorts 会回来" while claiming 「以后每次打开…自动去掉」. Missing: **persistent per-site page rewrite** | 知道 (but overclaims) | sider-code/run.mp4 |

(All video paths are relative to replicate/. final.png = last frame, same folder.)

## Problems found (deduped, grouped)
**Wrong facts in answers**
1. Total price leaves out tax (ego-passenger r1 ¥4,920 vs ¥5,560; also CA 929 ¥5,160) — 1/3 runs.
2. Brief attributes a fact to the wrong company (sider-hiring: Gamma's closed role called Beta's).
3. Answer contradicts itself mid-sentence (ego-linkedin-jobs 「3 个…实际只有这两个」).

**Answer card / rendering bugs**
4. False 「已提交，收不回 / 表单已经交给网站，扩展撤不回」 after a non-final form step (ego-passenger 3/3).
5. Placeholder 「见下方卡片」 rendered instead of a price (ego-passenger 3/3, ego-mortgage).
6. Template placeholder 「{=real}」 leaked into text (sider-forms).
7. Header row duplicated in a table card (sider-yt-sheets); typo 「差验」 (sider-reviews).

**Stops without a result / user left uninformed**
8. Ends with no data after promising it ("我直接生成 CSV", 0 steps) — sider-price.
9. 「助手没给出最后的回答就停了」 endings (ego-devqa, sider-contacts r1+r2, sider-files). The sider-contacts stall repeated at the same point (right before 「生成文件」), so it may not be random provider flakiness.
10. Failed local upload drops into a paused 「你在操作·助手在旁边等」 state with no explanation; run hangs to timeout (ego-job-apply).
11. Long interactive loop: stalls on repeated page-code board reads, aimless moves, no progress or status shown (ego-chess).
12. Memory writes time out (「查看记忆 · 这一步超时了」 ×2, sider-files).

**Overclaims / side effects**
13. Claims a persistent per-site rule that it can't enforce (sider-code).
14. Changes app state beyond the asked steps to reproduce a bug (ego-e2e added and deleted 甲/乙 and re-added 买牛奶).

**Missing capabilities (to file)**: local file read/upload; PPT/PDF file generation (CSV generation exists: the 「生成文件」 step in sider-contacts r3, so sider-price did it wrong rather than lacking the capability); scheduled monitoring; editing local repo files; persistent per-site DOM/CSS rewrites.
