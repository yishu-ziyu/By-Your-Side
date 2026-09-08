# 任务: 父 Agent 能接管和关闭同会话 worker 创建的页面

## 完成标准
- [x] 1. worker 打开的多个页面，在完成、失败、取消后全部交回同会话父 Agent，保留页面内容；父 Agent 能切换、读取和关闭。— 谁检查: 聚焦测试及真实扩展生产工具链
- [x] 2. 父 Agent 接管仍在运行的 worker 页面时，先停止相关 worker、拒绝晚到操作，等待已开始的操作结束后才移交；不停止无关 worker。— 谁检查: Fleet 与扩展竞态测试及真实浏览器
- [x] 3. 其他会话无法接管、关闭或共享该页；普通 worker 无管理权；用户接管期间父 Agent 不能写页面。— 谁检查: 权限反例测试及真实扩展生产工具链
- [x] 4. 旧 worker 已不存在但页面仍留有归属时，父 Agent 可收回；报错区分跨会话、同会话未共享和已停止的 worker。— 谁检查: 状态持久化与旧数据测试
- [x] 5. npm run typecheck、npm test、npm run build、git diff --check 全部通过。— 谁检查: 机器
- [x] 6. 从父 Agent 发出清理请求后页面实际关闭，不要求用户手动点关闭。— 谁检查: 浏览器模型路径；表述是否清楚由人检查

## 边界与不做
- 不增加跨会话超级管理员权限；不关闭用户未要求关闭的现有页面。
- 不改变当前界面布局和已有用户接管流程。保留工作区已有记忆功能等修改。
- 验收只新建测试页面，不清理截图中的用户页面。


## 验证结果

- 2026-09-08：`npm run typecheck`、`npm test`（最终 71 文件 / 616 项）、`npm run build`、`git diff --check` 通过。工作区同时有另一项侧栏修改，保留其成果。
- 真实 Chrome 生产调用链 10 项通过：`/tmp/sideagent-parent-tab-evidence/result.json`。先出现原权限拒绝，再移交、读回并实际关闭两个页面；迟到写入和跨会话管理均拒绝。
- 真实 MiniMax-M3 worker + 父 Agent 清理 4 项通过：`/tmp/sideagent-parent-model-evidence/result.json`。测试通过生产 Fleet 接口安排 worker，worker 真实读取并打开第二页；父 Agent 模型收到清理请求后实际关闭全部页面。该结果不证明模型自主派工策略。
- 现有会话/共享页/用户接管浏览器回归全部通过：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-sessions-2026-09-08T08-28-35-645Z/result.json`。
- 验收先后遇到：桥接脚本 RPC 编号错误；自主派工多开一个空白页；自主派工模型超时。均未算通过。固定生产派工初始条件后验证核心清理路径，保留模型失败记录。一次无关经验测试在清理临时目录时 ENOTEMPTY，聚焦与完整重跑通过，未改其断言。
- 扩展已重载。仅清理本轮测试页面，用户原有页面未关闭。尚未由人评价“接管页面”等提示是否清楚。
