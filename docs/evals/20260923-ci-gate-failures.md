# 验收失败收口：real-path 入库、C01 跨页比较、C2 滚轮

2026-09-23。承接上一轮 CI 与隔离验收报告里的三个遗留问题。用户同时要求不再使用 cliproxy，改用自己的套餐（OpenCode Go、智谱 GLM 编程版、Kimi For Coding）。

## 1. real-path 用例入库

`scripts/acceptance/real-path/` 原来只存在于本地工作区。提交 `db0ad34` 只含这一个目录，没有带上其他未提交改动。提交钩子要求通过 anti-slop 检查，因此补了 `SAFETY:` 说明和 JSON 读数类型，没有改用例行为。改完后用 Kimi 跑 `mark-motion-toggle`，5/5 通过。

harness 新增 `--model=provider/id`：只替换测试伴随进程的模型，日常 `config.json` 不动。

用例覆盖的标注读数、用户点选等产品改动仍未提交，所以在只含已提交代码的树上，部分用例会失败。

## 2. C01 跨页比较：产品缺口，夹具保留

**现象。** 模型并行 `fetch` 三个 `127.0.0.1` 报价页，全部被私网规则拒绝。连续失败保护按工具名计数，把这三次当成"同一操作连续失败三次"，直接结束了任务，没有改为打开页面阅读。

**判断。** 私网拒绝本身是正确的：带登录态的请求不能指向本机服务。但真实用户会遇到公司内网页面，这正是 127.0.0.1 夹具在模拟的情形，所以夹具保留。缺的是两件事：拒绝时没有给出替代做法；三个不同页面的失败被误算成重试。

**修复。**
- `shared/fetch.ts`：私网拒绝标记为 `not_executed`，错误信息提示改用 `open_tab`/`navigate` 后 `snapshot`。
- `agent/src/tool-failure-policy.ts`：按「工具＋参数＋错误」计数。同一操作仍在第三次相同错误时停止。

**证据。**
- 单元测试：`agent/test/tool-failure-policy.test.ts` 新增用例，三个不同 URL 各失败一次不停，同一 URL 第三次停；`extension/test/fetch-guard.test.ts` 8/8 通过。
- 真实路径 `--case C01`：Kimi K2.8 用 144 秒通过，DeepSeek V4 Flash（OpenCode Go）用 87 秒通过，GLM 5.3 Flash 用 216 秒通过。
- **未证明：** 这三个模型都直接打开了页面，没有调用 `fetch`，所以"被拒后改为打开页面"的回退路径没有在真实模型上跑到。原先复现失败的是 cliproxy 上的 MiMo，按用户要求没有再用它。

## 3. 隔离验收 C2：隐藏页上的滚轮

**现象。** `wheel` 的 `mouseMoved` 等待确认 3 秒后超时，重试又等 5 秒，最终记为"是否滚过未知"。同一页面上每次点击都要 6 秒以上。

**定位（实验，不是推断）。**
- 滚轮前读页面状态：`visibilityState: hidden`，`hasFocus: false`。
- 按设计，窗口未聚焦时产品不把工作页切到前台（`foreground.ts`，避免把 macOS Space 拽回来）；无头窗口从不聚焦，所以工作页一直隐藏。Chrome 不给隐藏页处理滚轮。
- 同一场景先把页切到前台：点击降到 0.5 至 1 秒，滚轮 63 毫秒，C2 4/4 通过。
- 分别去掉中键和右键重跑，都仍然失败，排除了前序输入的干扰。

**判断。** 这是产品问题，真实用户也会遇到：窗口未聚焦时，工作页在后台。滚轮链路本身没有坏。

**修复。**
- `extension/src/background/exec/input.ts`：滚轮前先查可见性。页面隐藏时立即回 `not_executed`，说明原因，并提示改用 `scroll` 或请用户切回窗口；不派发任何事件。
- `extension/test/pointer-input.test.ts`：新增隐藏页用例，24/24 通过。
- C2 场景先验证"隐藏页快速拒绝、页面没收到事件"，再切到前台验证落点。连续两轮 5/5 通过，拒绝耗时 11 至 20 毫秒（原来 8 秒后记为未知）。
- CI 门槛子集加入 C2。本地按新门槛跑一轮（`--only=F1,F2,F3,F4,F4b,F5,C1,C2,S1,S2`）：10 个场景全部通过，exit 0；产物在 `out/acceptance/browser-capability-integration-v2-2026-09-23T11-53-56-050Z/`。

## 4. C3 下载：已知缺口，未处理

`Page.setDownloadBehavior` 在扩展调试通道里返回 `Cannot not access browser-level commands`，与 [09-22 记录](20260922-browser-capability-integration-v2.md) 相同。修复需要换用 `chrome.downloads`，这要申请覆盖整个浏览器配置的下载权限，并设计下载归属到哪个任务。这是权限范围的产品决定，本轮没有改。

## 未做

- 没有推送，GitHub 上的 Linux 试跑还没有运行。
- 除 `db0ad34` 外，本轮改动都没有提交；工作区里其他会话的未提交改动也没有动。
- 没有跑全量隔离验收和全量单元测试，只跑了受影响的测试文件和门槛子集。
