# 任务：结束的网页操作确认卡退出侧栏，不被迟到列表复活

## 完成标准

- [x] 拒绝后旧卡不显示；真实工具返回未执行，服务器 POST 为 0。— 谁检查：主代理运行脚本
- [x] 允许后旧卡不显示；服务器 POST 精确为 1。— 谁检查：主代理运行脚本
- [x] 实际 20 秒到期后旧卡不显示，无新增 POST。— 谁检查：主代理运行脚本
- [x] 新 pending 请求正常显示当前参数。收到旧已结束请求的迟到列表后，旧卡不复活，新卡仍可决定。— 谁检查：主代理运行脚本
- [x] 如旧卡错误复活，通过真实侧栏重放其已拒 requestId 不能产生 POST。每次决定记录精确请求、参数及时间。— 谁检查：主代理运行脚本

## 边界与不做

- 仅修改侧栏确认卡状态与渲染，不改变后台批准、指纹、取消及有效期规则。
- 使用当前源码的临时隔离构建、无头 Chrome 和真实 sidepanel。保留日用 extension/dist 指纹。
- 工具调用从共享验收 RPC 进入生产执行路径。延迟 consent_list 从共享验收 hook 的受限列表入口注入；不铸造 grant，不修改后台 pending。
- 本脚本不是日用模型/SDK 全链路。#40 原始截图缺少 requestId，不能据此断定原始卡片就是已结束请求。
- 日用截图来源身份及权威文档同步由主代理完成。

## 复现入口与证据

`node --import tsx scripts/acceptance/consent-card-retirement.mts --headless`

每次运行写入 `out/consent-card-retirement/<UTC时间>/`：构建日志、四类截图、逐卡身份与参数、后台 pending、决定时间、独立服务器 POST、清理结果、日用构建指纹。

- 首轮 `2026-10-03T05-12-02-893Z`：注入 hook 返回 undefined，脚本 JSON 解析失败。该轮不算有效产品红。主代理已让 hook 返回 true，不改变消息内容或批准规则。
- 有效红 `2026-10-03T05-13-42-628Z/result.json`：主代理运行，FAIL。拒绝、允许、到期后旧卡仍显示；新请求后迟到列表复活旧卡；后续拒绝的卡仍显示。共五项界面失败。服务器 POST 精确为 1，旧已拒 ID 重放不新增 POST；日用 dist 未变。
- 实现已写入：render 只显示 pending；结束记录仅在原有效期已过后清理。保留同一个 Map，不改后台批准及列表 authoritative 缺失条目清理。
- 定点 lint：脚本及生产文件通过。构建、浏览器与产品测试由主代理独占；修改后真实路径尚未运行。
- 对有效红的解释：结束条目仍渲染为 `consent-complete`；新请求删除未到期结束记录，迟到列表重建旧 pending 卡。原始日用截图的具体身份仍未由此确定。
- 验收基础设施：继续使用 `__saSetSecurityHost` 隔离真实 inproc 生命周期。共享 hook 的 `__saConsentListForAcceptance` 只转发先前实际请求的迟到展示列表；主代理维护该 hook。

## 最终结果与原问题解释

专项 `out/consent-card-retirement/2026-10-03T05-49-01-268Z/result.json`：PASS，四类请求、14 份证据，POST 精确一次，结束 / 过期旧卡不显示，迟到列表不复活旧卡。新增文字断言核对 activation 显示真实动作而非旧会话目标。

真实扩展内 Agent 和实际侧栏入口 `out/security-confirmation/real-path/2026-10-03T05-28-12-613Z/result.json`：4 PASS、POST 一次，12 张卡均有原生请求来源、独立 requestId 和 pending 状态。四个 runId 不同，但后台 goal 始终取首个 conversation.title。因而“旧任务名又出现”至少包含新请求借用旧标题，不是所有卡都属于旧批准复活。界面现显示实际工具动作和目标，不改后台授权语义。使用本地脚本模型，不替代真人体验。

已加载日常并核对侧栏运行源码，原数据保留，见[部署](20261003-issue-fixes-deployment.md)。
