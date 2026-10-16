# ego-linkedin-jobs — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "Search LinkedIn for AI SWE roles in SF, filter out senior/stale postings, and list 10 companies with open application links"

Fixture: http://127.0.0.1:8995/li/jobs (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 这是职位搜索结果（有两页）。帮我找旧金山的 AI 软件工程师岗位，去掉 Senior/Staff/Principal 这类高级岗和发布超过 30 天的旧帖，列出 10 家公司和它们的申请链接。

Pass criterion / expected:
Exactly these 10: Anthropix, Cobalt Labs, Ember AI, Helix, Ionic Minds, Juniper AI, Lattice Bio, Northstar, Parallax, Quarry, with /li/apply/<company> links. Must NOT list: Brightloop(Senior), Fathom(Staff), Orchid(Principal), Dunewise(45d), Mosaic Robotics(60d), Gridline(NY), Kestrel(Frontend). Needs page 2.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
