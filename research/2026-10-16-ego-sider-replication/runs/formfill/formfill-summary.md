# Form-fill accuracy — SELF-TEST results (本地测试页, local fixtures only, nothing submitted)

Model MiniMax-M3.1-Flash-Preview (minimax-cn). Builds: main = ba3d11a8 (wt-main, own-tree build), 440 = proto/440-on-main 1659c444. Fixtures: overnight/formfill/server.mjs (port 8966).

| form | build | runs | pass | field acc | wrong-field placements | avg s | avg steps |
|---|---|---|---|---|---|---|---|
| A | main@ba3d11a8 | 8 | 8/8 | 56/56 | 0 | 14 | 7.1 |
| A | proto/440-on-main@1659c444 | 7 | 7/7 | 49/49 | 0 | 18 | 5.0 |
| B | main@ba3d11a8 | 10 | 10/10 | 70/70 | 0 | 13 | 6.5 |
| B | proto/440-on-main@1659c444 | 9 | 9/9 | 63/63 | 0 | 17 | 3.3 |
| B2 | main@ba3d11a8 | 8 | 8/8 | 56/56 | 0 | 15 | 6.4 |
| B2 | proto/440-on-main@1659c444 | 8 | 8/8 | 56/56 | 0 | 15 | 3.1 |
| C | main@ba3d11a8 | 9 | 9/9 | 36/36 | 0 | 31 | 10.3 |
| C | proto/440-on-main@1659c444 | 10 | 10/10 | 40/40 | 0 | 33 | 8.0 |

## Failures

None: every run passed.

Prompts: A/B/B2/C in overnight/formfill/lane.sh (B2 = same page B, prompt names the article 标题 first with less section structure). Checker: all input/select/textarea values read from the final DOM; pass = every field exact, nothing in fields that should stay empty.

## Notes

- Every form-C run (both builds) logs its first step as an error: clicking 「预约服务」 opens the dialog, and the click then gets reported as 被「预约到店」挡住 (the newly opened dialog counts as the blocker). The model recovers every time, but some runs then hit 没找到目标 / selectOption 失败 before succeeding (e.g. c-main-d62-r23 had 7 failed steps, c-main-d62-4 had 5).

