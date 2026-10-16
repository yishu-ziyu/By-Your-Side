# sider-files — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Turn research into PPT, PDF or DOC files; batch operations; monitor prices"

Fixture: http://127.0.0.1:8995/files/research (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 把这页调研整理成一份 PPT 文件和一份 PDF 给我，再每天帮我监控表里三个产品的价格。

Pass criterion / expected:
Expected 卡在缺能力: file generation (PPT/PDF) and scheduled monitoring. Distractor: superseded $9B figure must not be used if it summarises.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
