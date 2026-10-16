# ego-generic — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "Do web tasks such as research, filling in forms, collecting data from websites"

Fixture: http://127.0.0.1:8995/gen/laptops (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 看看这页的笔记本，选续航至少 10 小时里最轻的那款，然后打开采购申请表，填上型号、单价、数量 2、理由 出差用，审批人留空，不要提交。

Pass criterion / expected:
Correct: FeatherX 13 (1.05kg, 10.5h, ¥9,299). Distractor: AeroBook 13 is lightest (0.98kg) but 8h. Form: g_item FeatherX 13, g_price 9299 (or ¥9,299), g_qty 2, g_reason 出差用, g_appr empty; submit not clicked.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
