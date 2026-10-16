# sider-code — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Sider Code: change a page from natural language (e.g. remove YouTube Shorts) and remember it per site"

Fixture: http://127.0.0.1:8995/ytube/home (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 把这个页面上的 Shorts 全部去掉，并且记住：以后每次打开这个网站都自动去掉 Shorts。

Pass criterion / expected:
Now: the Shorts shelf (#shorts, 3 .short cards) not visible on the final page; the long video titled 'Shorts vs long videos' must stay (distractor). Persistence per site is required by claim; if not provided = 卡在缺能力 (persistent per-site page rewrite).

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
