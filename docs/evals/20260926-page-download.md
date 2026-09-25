# 任务: 用户让助手下载页面提供的文件，文件落进下载文件夹，侧栏如实说下好了或没下好

## 背景

C3 页面下载一直失败：扩展调试通道拒绝 `Page.setDownloadBehavior`（`Cannot not access browser-level commands`），见 [09-23 记录](20260923-ci-gate-failures.md)第 4 节与 [09-22 记录](20260922-browser-capability-integration-v2.md)。只装扩展时还更早就失败：宿主要先建临时目录，扩展里没有本机文件。改用 `chrome.downloads` 需要整个浏览器配置的下载权限，这项决定由用户（captain）批准（2026-09-26，经 firstmate 下达：“申请权限，补上页面下载”）。

## 做法

- manifest 加 `downloads` 权限。
- 仍走原来的 `arm_event → 点击 → wait_event`、控制闸门和事件账本，不另开一条路。`Page.downloadWillBegin` 把下载归到已 arm 的标签页（实测不需要 `setDownloadBehavior` 也会发）；`chrome.downloads.onCreated` 按 URL 与它对上。
- 完成与否只看 `chrome.downloads`：`complete` 才记完成并带路径和字节；`interrupted` 记 Chrome 的错误码。CDP 的 `downloadProgress` 把中断也报成 `canceled`，不再使用。
- `wait_event` 对下载匹配后再等结束（默认 60 秒）。模型工具的回执：完成写“confirmed by Chrome's downloads API … saved to …”；中断直接作为失败返回；没下完或被 Chrome 判为有害时写“not saved yet”。
- 文件由 Chrome 存进用户的下载文件夹，不再建临时目录；`download_delete` 只忘记记录、不删文件；`download_cancel` 不把已下完的说成已取消。
- 两个隔离启动器都把下载文件夹指到临时目录。

## 完成标准

- [x] 1. 用户在真侧栏说“帮我把这个页面上的季度报表下载下来”，文件以原内容落进下载文件夹，Chrome 记为 complete — 谁检查: `page-download.mts --case=complete`（临时下载文件夹里的实际文件字节、`chrome.downloads.search`，均不经产品代码）
- [x] 2. 同一路径下载一个服务器中途断开的文件，Chrome 记为 interrupted，下载文件夹里没有完整文件，侧栏回答说没下好 — 谁检查: `page-download.mts --case=broken`（回答判据只拦明显说反）
- [x] 3. 侧栏回答措辞如实、用户能看懂 — 谁检查: 人（截图见下）；本轮由执行者看过截图，最终观感待用户判断
- [x] 4. 不用模型的扩展层回归：QA-01 C3 下载相关断言通过 — 谁检查: `ONLY=C3 browser-capability-integration-v2.mts --headless`
- [x] 5. 测试不写用户真实的下载文件夹 — 谁检查: 运行前后 `~/Downloads` 里没有测试文件

## 证据

隔离 Chrome for Testing（无头）+ 当前源码构建的解压扩展（随机 key），不注册 Native Messaging，模型 `stepfun/step-3.7-flash`（扩展存储里的凭据，来自本机既有配置）。练习页是夹具服务器的 `downloads.html`。产物在 `out/acceptance/real-path/`（本地、不入库）。

| 运行 | 结果 | 用户看到的 |
|---|---|---|
| `2026-09-25T17-42-24-729Z-page-download-complete` | 5/5 通过，17 秒 | “已完成下载。页面上的「季度报表（quarterly-report.csv）」已经成功保存到浏览器下载目录中，文件大小为 37 B。” |
| `2026-09-25T17-43-38-609Z-page-download-complete` | 5/5 通过，19 秒 | “已帮你下载成功。文件 quarterly-report.csv 已保存到下载目录中。” |
| `2026-09-25T17-48-48-879Z-page-download-complete`（最终代码） | 5/5 通过，19 秒 | “已帮你下载完成。季度报表（quarterly-report.csv）已保存到浏览器下载目录，文件大小约 37 B。” |
| `2026-09-25T17-42-53-027Z-page-download-broken` | 5/5 通过，29 秒 | “…Chrome 报告服务器返回内容长度不匹配（SERVER_CONTENT_LENGTH_MISMATCH），文件未成功保存。”下方一行“还有 1 项没完成：下载项目归档文件” |
| `2026-09-25T17-44-01-222Z-page-download-broken` | 5/5 通过，28 秒 | “项目归档下载失败了…文件未保存成功。我尝试改用直接下载的方式获取文件，但系统提示有未确认的上一步操作，当前写入已暂停，无法继续。” |
| `2026-09-25T17-49-11-027Z-page-download-broken`（最终代码） | 5/5 通过，25 秒 | “…Chrome 报告 SERVER_CONTENT_LENGTH_MISMATCH…导致文件未能完整保存。”+ 未完成行 |

每个目录里有 `panel.png`（侧栏截图）、`page.png`、`panel-transcript.txt`、`result.json`（含 Chrome 下载记录和下载文件夹清单）。中断用例 Chrome 记录均为 `interrupted / SERVER_CONTENT_LENGTH_MISMATCH`，下载文件夹为空。

QA-01 C3（无模型）：改前 `browser-capability-integration-v2-2026-09-22T23-19-34-312Z` 为 5/8；本轮 `…2026-09-25T17-45-26-409Z` 与最终代码 `…2026-09-25T17-49-39-303Z` 均为 8/8（页面生成的 blob 下载、`download_save_as` 读回内容、两次同名下载 id 不同）。

## 发现与修正

- QA-01 C3 的第一次复跑把测试 blob 写进了用户真实的 `~/Downloads`（`qa01-blob.txt` 两份，内容 `BLOB-DL-CONTENT`），因为 `isolated-extension.mts` 没指定下载文件夹。已删除这两份本轮产物，并让启动器默认把下载文件夹指到临时目录；复跑后 `~/Downloads` 无测试文件。
- 同一脚本原先从 `wait_event` 结果的顶层读 `downloadId`，而协议把它放在 `download` 里；改前的“两次下载 id 不同”失败有一部分来自这里，已按协议读取。

## 仍未验证或未解决

- 日常 Chrome 未重载，真人未试用。已加载旧版的需在 `chrome://extensions` 重新加载才拿到下载权限。
- 失败回答直接露出 Chrome 错误码（如 `SERVER_CONTENT_LENGTH_MISMATCH`），是否该换成人话由用户判断。
- 失败回合的“做了 N 步”标题仍是绿色勾（已有界面行为，本轮未改）。
- 一次中断用例里模型自己尝试“直接下载”补救，被控制闸门挡住后如实说明；没有伪造成功，但多了步骤。
- 超过等待时间（默认 60 秒，模型可给到 120 秒）的大文件只会说“还没下完”，扩展模式下模型没有稍后再查的工具。
- 同一 URL 恰好同时在别的标签页被下载时，按 URL 对上可能串到那一条；本轮未覆盖。
- 本机伴随进程模式只经 QA-01 C3 覆盖工具层，没有跑真侧栏 + 伴随进程的下载用例。
- 全量单元测试 3060 项全部通过，另有 1 个 `extension/test/delivery-receipt.test.ts` 的未处理异常（`uplink.ts` 调用测试替身里没有的 `chrome.storage.onChanged`），与本改动无关，未处理。
