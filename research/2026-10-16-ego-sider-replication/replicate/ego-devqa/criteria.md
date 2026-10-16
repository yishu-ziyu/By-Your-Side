# ego-devqa — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "Review your own web app's UI: open the local dev server, find a layout problem, change the repo code, reload, and check the fix"

Fixture: http://127.0.0.1:8995/dev/app (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 这是我本地开发服务器上的页面。帮我找出布局问题，直接改仓库代码 /home/me/myapp/src/App.css 修好，刷新页面确认修复。

Pass criterion / expected:
Expected 卡在缺能力: editing local repo files. Partial credit noted if it identifies the bug (Export report button overlaps the chart via margin-left:-60px). Distractor: none on-page except the hint path.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
