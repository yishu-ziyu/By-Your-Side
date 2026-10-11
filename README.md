# assets/proto-20261011

2026-10-11 的两个界面原型和一份延迟追踪报告。不是产品代码，不合并进 main。基线 main `6a8587b`。

- `20261011-stream-proto/`：回答流式手感，现在 vs 按 Claude 实测参数改后（节拍器、按段淡入、拆壳、弹簧入场）。`index.html` 直接打开；录像 `compare.mp4`、`compare-serif.mp4`；静图 `compare.png`、`stills/`；说明 `README.md`。
- `20261011-proto-steps/`：过程块三种改法 + 用户选定的 AC（进行中一行「现在」，做完收成一行回执）。`index.html` 直接打开；录像 `videos/AC.mp4`、`videos/AC-err.mp4`；静图 `stills/AC.png`、`stills/compare-AC.png`；说明 `README.md`。
- `20261011-latency-trace/`：延迟追踪报告 `REPORT.md` 和瀑布图。原始运行数据（请求体、诊断记录）没有放上来。

两个原型的 `product-styles.css` 是当时仓库 `extension/src/sidepanel/styles.css` 的副本。`vendor/` 里是 marked（MIT）和 DOMPurify（Apache-2.0 / MPL-2.0）的发行文件。原型里的界面文字写于 #247 文案审校之前，落地时按 #247 的核准词表改（例如「做了 N 件事」→「做了 N 步」）。
