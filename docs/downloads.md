# 文件下载

[协议](protocol.md) · [使用说明](guides/usage.md#下载文件) · [验收入口](testing/acceptance.md)

页面下载：`arm_event{type:"download"}` → 点页面的下载入口 → `wait_event`。`Page.downloadWillBegin` 把下载归到已 arm 的标签页，文件由 Chrome 存进用户的下载文件夹；是否下完只看 `chrome.downloads`（两者按 URL 对上）。`wait_event` 匹配后再等下载结束（默认最多 60 秒），`download.completed` 只在 Chrome 报 `complete` 时为真并带 `path`/`bytes`；中断时 `failure` 是 Chrome 的错误码，模型工具把它作为失败返回。`download_cancel` 不取消已下完的文件，`download_delete` 只忘掉记录、不删文件；本机伴随进程的 `download_save_as` 在完成后复制到指定路径；只装扩展时没有本机文件，这个工具不列给模型。扩展调试通道拒绝浏览器级 `Page.setDownloadBehavior`，所以不再用它（[09-23 记录](evals/20260923-ci-gate-failures.md)）。

按链接下载：`download_url{url,filename?,timeoutMs?,tabId?}` 直接用 `chrome.downloads.download`，适用于链接仅打开 PDF 阅读器的情况。只接 HTTP(S)，文件名不能带路径，沿用页面控制权闸门，不增权限。默认等20秒（可设1–20秒）；未结束时回 `completed:false` 和宿主签发的 `downloadId`，模型用独立工具 `download_stat` 查询，不能为查询重复下载。路径和字节数只在 Chrome 报完成后给出；网络中断仍报失败，危险下载留给 Chrome 的人工决定。直接下载按 Chrome 返回的精确编号登记，并核对会话归属，避免按相同 URL 串到别的下载；登记在后台内存，重启后旧编号不可查询，与原页面下载登记边界相同。已完成的下载不会被取消，移除登记不删除文件。验收见[PDF 下载](evals/20261002-pdf-download.md)。
