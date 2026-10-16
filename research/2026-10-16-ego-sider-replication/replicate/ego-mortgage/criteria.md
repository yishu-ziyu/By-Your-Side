# ego-mortgage — 自测 criteria (written before the run)

Claim (EGO, competitor-examples.md): "Filter home listings by city/budget/type, open the top match, recalculate the mortgage at your down payment, and return address, price and monthly cost"

Fixture: http://127.0.0.1:8995/home/listings (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 帮我筛杭州、总价 300 万以内、公寓的房源，打开排第一的那套，用首付 90 万重新算一下房贷，告诉我地址、总价和月供。

Pass criterion / expected:
Top match after filters: 'Xihu District, Wensan Rd 88, 3-1201', ¥2,850,000 (distractor: Wensan Rd 12 ¥3,400,000 listed first but over budget; villa; Shanghai). Down payment input = 900000, recalculated; answer reports address, ¥2,850,000 and monthly ¥8,756.

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
