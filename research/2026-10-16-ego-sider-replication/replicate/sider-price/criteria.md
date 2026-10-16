# sider-price — 自测 criteria (written before the run)

Claim (Sider, competitor-examples.md): "Amazon Price Tracker: extract prices, ratings and review counts from top listings into a spreadsheet"

Fixture: http://127.0.0.1:8995/amz/search (server replicate/_fx/server.mjs, port 8995; state /__state?s=<path prefix>)

Prompt to BYS:
> 把这个搜索结果里前 5 个非广告商品的价格、评分、评价数整理成电子表格，给我一个 CSV 文件。

Pass criterion / expected:
Data: SoundCore Air 3 ¥299 4.5 12,840; Sony WF-C700 ¥599 4.4 8,321; Jabra Elite 4 ¥499 4.3 5,310; Huawei FreeBuds 5i ¥449 4.6 20,112; Xiaomi Buds 4 ¥279 4.2 9,876. Distractors: 2 sponsored. Spreadsheet/CSV file required by claim; correct data without a file = 卡在缺能力 (file export).

Result must be exactly one of 通过 / 失败 / 卡在缺能力 (name capability). Scored from server state + final page DOM, not BYS's receipt. Build: main @ ba3d11a8cc635cf84e850130fa2002fadeaf4a02. One recorded run.
