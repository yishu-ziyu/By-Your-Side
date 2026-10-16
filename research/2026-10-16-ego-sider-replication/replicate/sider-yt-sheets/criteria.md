# sider-yt-sheets — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "YouTube Topic Research: capture top video metadata and organize it in Sheets"

Fixture: http://127.0.0.1:8995/yt/results (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 把这个搜索结果里前 5 个正常视频（广告和 Shorts 不算）的标题、频道、播放量、发布时间写进我的表格 http://127.0.0.1:8995/yt/sheet ，第一行写表头。

Pass criterion / expected:
Sheet rows 2-6 = Browser agents explained…; I built an AI that books flights; Agentic workflows: full course; Why AI agents fail…; Computer-use models compared (with channel/views/date). Distractors: Ad and #shorts. Scored from sheet cell state.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
