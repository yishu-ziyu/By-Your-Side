# sider-reddit — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Reddit Topic Scan: collect hot posts across subreddits into a content-idea sheet"

Fixture: http://127.0.0.1:8995/r/MachineLearning (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 扫一下 r/MachineLearning、r/LocalLLaMA、r/programming，每个版块取点赞最高的 3 个帖子（置顶帖不算），整理成一张选题表。

Pass criterion / expected:
ML: Show: tiny diffusion repo 3,120; New paper: test-time training 2,410; Why are evals so noisy 1,830. LocalLLaMA: Running 70B 4,420; Which local model for coding 3,770; Quantization shootout 2,950. programming: Postgres is enough 3,300; case against microservices 2,600; rewrote backend in Go 1,500. Distractor: pinned mod posts with highest counts.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
