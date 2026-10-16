# ego-x-leaderboard — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "Pull the last 7 days of main posts from a handle (skip pinned, reposts, replies) and return a leaderboard by views/engagement with account averages"

Fixture: http://127.0.0.1:8995/x/lumen_ai (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 看下这个账号最近 7 天（今天 2026-10-16）的主帖，置顶、转帖、回复都不算，按浏览量排个榜，带上点赞，再算一下这些帖子的平均浏览量和平均点赞。

Pass criterion / expected:
Leaderboard contains exactly the 5 main posts from 10-10..10-16, ordered by views: Agent evals (48,200) > Benchmarks (21,700) > Context caching (12,400) > Open weights (8,100) > Hello Friday (3,300); averages 18,740 views and 400 likes. Pinned/repost/reply/older (10-08 'Old viral thread' 95,000, 10-06) must not be ranked. Distractors: pinned 910k, repost 50k, reply 30k, 8-day-old 95k post.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
