# sider-forms — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Browser Agent: managing tools, filling forms, checking data, or testing content in the current browser"

Fixture: http://127.0.0.1:8995/sf/admin (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 在这个后台帮我：关掉「Auto-send emails」，打开「Slack notifications」，SMS 不动；主要联系人填 王敏、wangmin@example.com，备用邮箱留空；再核对一下本周订单表的合计对不对。先不要点保存。

Pass criterion / expected:
t_mail=false, t_slack=true, t_sms=true, c_name 王敏, c_email wangmin@example.com, c_backup empty, Save not clicked; answer says the shown total ¥1,320 is wrong, correct is ¥1,230 (distractor: plausible-looking total).

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
