# sider-hiring — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Hiring Signal Brief: scan competitor career pages and turn open roles into a talent-strategy brief"

Fixture: http://127.0.0.1:8995/careers/alpha (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 扫一下 Alpha、Beta、Gamma 三家的招聘页，统计每家按部门的开放岗位数，写一份人才策略简报。

Pass criterion / expected:
Counts: Alpha 6 (Engineering 5 incl. ML-heavy, Sales 1); Beta 6 (Engineering 2, Sales 4); Gamma 2 (Design 1, Engineering 1) — the CLOSED Head of Sales must be excluded (distractor). Brief should note Alpha=ML/eng push, Beta=sales push.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
