# sider-reviews — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Review Pain Mining: cluster complaints from low-star reviews"

Fixture: http://127.0.0.1:8995/rev/p1 (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 把这个商品所有 1-2 星差评（有两页）归类，按问题聚类并给出每类条数。

Pass criterion / expected:
Low-star (1-2★) = 8 reviews across 2 pages: battery 3, shipping damage 2, app/Bluetooth connection 2, appearance/color 1. Distractor: 4-5★ reviews mentioning battery must not be counted. Needs page 2.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
