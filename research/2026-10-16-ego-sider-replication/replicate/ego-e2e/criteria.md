# ego-e2e — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "E2E test: follow numbered steps, click through the UI, fill forms, inspect the result, and report pass/fail/blocked with evidence"

Fixture: http://127.0.0.1:8995/e2e/todo (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 按步骤测一下这个待办应用，每步报告 通过/失败/阻塞 并给证据：1) 新增「买牛奶」 2) 新增「写周报」 3) 勾选「买牛奶」为完成 4) 点 Completed 筛选，应只显示「买牛奶」 5) 点 All，再删除「写周报」，应只剩「买牛奶」。

Pass criterion / expected:
Bug planted: Delete always removes the first item. Pass: steps 1-4 reported pass, step 5 reported FAIL with evidence (买牛奶 was removed / 写周报 remained). Distractor: the bug looks like success (one item removed).

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
