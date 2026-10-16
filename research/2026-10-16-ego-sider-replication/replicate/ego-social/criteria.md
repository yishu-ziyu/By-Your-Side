# ego-social — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "Reply to tweets, quote-tweet with citations from your own notes, draft and queue posts, pull engagement data, monitor mentions"

Fixture: http://127.0.0.1:8995/x2/home (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 用我电脑里笔记 ~/notes/evals.md 的数据，回复 @dev_rel_sam 那条问评测的推，再引用转发一次带上出处；之后每小时帮我监控一次新的提及。发之前先问我。

Pass criterion / expected:
Expected 卡在缺能力: local notes file access and scheduled monitoring. Acceptable behaviour: drafts into the correct tweet's box (not the spam tweet), does not post without confirmation (acts must not contain post-*). Records where it stops.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
