# 续接要点

当前进度只看[STATUS](STATUS.md)。本页保留不容易从单个函数或测试看出的因果约束；旧工作记录完整保存在[历史快照](history/20260913-notes-snapshot.md)。

## 本轮整理边界

起点有大量未提交产品修复，本轮以工作树为基线。不要把相对HEAD的全部改动归为本轮，不重置、不顺手删除临时资料。模块边界与扩展位置见[架构文档](architecture.md)，验收见[仓库整理](evals/20260913-repository-maintainability.md)。

## 行为与验证

- 执行账本的 satisfied 只表示已记录动作完成，不等于用户目标已完成；正式交付有独立生命周期。这个区别曾导致提前收尾和重复交付，见[账本验收](evals/20260911-turn-economy-ledger.md)。
- 确认需要保留原请求页面、附件、任务身份；孤立的确认和预观察测试都通过也可能丢跨模块载荷。原生入口和生产装配测试不能互相替代，见[确认上下文](evals/20260912-voice-confirm-context.md)。
- 页面控制按tab归属，不按整个成员停工；同一成员可能还在别页。授权必须绑定原参数与身份，不能因收到旧“好的”放行。见[移交与授权](evals/20260913-architecture-closures.md)。
- 跨页提示的外层当前性检查不足，ensureCursor之后也可能迟到；共享提示清理必须按owner撤回。先后顺序和最终显示都需检查，见[同类缺陷](evals/20260913-interaction-loop-audit.md)。
- 重新打开侧栏是新会话；连接恢复不是重新打开。历史上下文恢复不自动重放网页动作。实际草稿与控制隔离证据同上。

## 环境与证据

- 隔离浏览器运行器复制dist后移除manifest key，因此不能接上日常native host。隔离测试、真实侧栏与真人声音分别留证；不可把任一种冒充另一种。
- 测试下载用 SIDEAGENT_DOWNLOADS_DIR 指向临时目录。生成物与个人运行数据不进入生产源码。
- 原生电脑控制曾出现截图/AX时序与下拉菜单焦点异常。动作报错不证明没发生；先核对新画面和有时间戳的日志，别重复发送。旧wrapper stderr多进程混写，不能按行序推断时间。
- 评测门槛以 eval/protected/quality-gates.json 为准；历史保护/发布情况不是新授权，缺真人或留出集仍记未通过。

## 资料位置

- 当前开发入口：[架构与维护](architecture.md)
- 历史经验、旧宿主故障与完整续接材料：[NOTES原文](history/20260913-notes-snapshot.md)
- 历史状态及旧性能数字：[STATUS原文](history/20260913-status-snapshot.md)
- 设计方向发生变化时写devlog；普通检查结果写eval，不再把日常流水复制到本页。
