# sider-seo — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Competitive SEO Intelligence: analyze competitor domains in Ahrefs (keywords, top pages, backlinks, content gaps)"

Fixture: http://127.0.0.1:8995/ahrefs/site?d=mysite.com (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 用这个 Ahrefs 看板对比竞品 rivala.com 和 rivalb.com：各自的关键词、Top 页面、外链数，然后找出两个竞品都有排名、但我们 mysite.com 没有的内容缺口关键词。

Pass criterion / expected:
Backlinks rivala 1,840, rivalb 920 (mysite 310). Gap keywords = exactly 'ai agent pricing' and 'browser automation tutorial'. Distractors: 'llm evals' (all three rank), 'web scraping api' (rivala + mine), 'rpa vs ai agents' (rivalb only) must not be called gaps.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
