# sider-events — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Event Intel Sheet: dates, locations and ticket prices from major event sites"

Fixture: http://127.0.0.1:8995/ev/a (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 从这三个活动网站（AI Summit、WebConf、DevDays）整理日期、地点和普通票价，做成一张表。

Pass criterion / expected:
AI Summit 2026-11-12~13 Shanghai World Expo Center ¥1,280; WebConf 2026-12-03 China National Convention Center ¥699; DevDays 2026-11-28~29 Shenzhen Convention & Exhibition Center ¥599. Distractors: VIP/early-bird(sold out)/student prices, past-edition date.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
