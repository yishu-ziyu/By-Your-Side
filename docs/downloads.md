# 文件下载

[协议](protocol.md) · [使用说明](guides/usage.md#下载文件) · [验收入口](testing/acceptance.md)

页面下载：先订阅下载事件，再点页面的下载入口。文件由 Chrome 存进用户的下载文件夹。是否下完只看 Chrome 的下载状态；中断时作为失败返回。扩展调试通道拒绝浏览器级 `Page.setDownloadBehavior`，所以不用它（[09-23 记录](evals/20260923-ci-gate-failures.md)）。

按链接下载（`download_url`）适用于链接只打开 PDF 阅读器的情况。只接 HTTP(S)，文件名不能带路径，沿用页面控制的闸门，不增权限。

- 只有 Chrome 报完成才算存好。没下完时返回下载编号，不应为查询再下载一次。
- 危险下载留给 Chrome 的人工决定。
- 按 Chrome 返回的精确编号登记并检查会话归属，避免按相同 URL 串到别的下载。
- 登记在扩展后台内存，重启后旧编号不可查询。

验收见[PDF 下载](evals/20261002-pdf-download.md)。
