# GitHub Issue正文草案

本包未创建远端Issue。以下可由获得相应授权的Coding Agent逐项创建，或先保存在仓库任务目录。

# 主Issue：收敛到可验证正式版

目标：保留现有MV3/Node/Pi架构，修复安全与交付边界，达到锁定指标后晋级。以CODEX_EXECUTION_SPEC为需求，以quality-gates为门槛；缺证据BLOCKED。

总验收：安全、任务效果、交付、语音、恢复、UI、成本、迁移、真人验收全部通过；精确构建产物匹配；正式包仅一个生产实现；未删除历史和用户数据。

## 子Issue 00：建立基线与受保护的评测入口
依赖：无。
改动范围：AGENTS/STATUS；现有npm scripts；scripts/acceptance；CI与报告。

完成标准：
- [ ] 可运行的离线/隔离测试入口，不默认连接个人Chrome
- [ ] 故意失败、缺证据、伪造artifact SHA、候选改门槛都被拒绝
- [ ] 明确记录mock/native/live/human类型；建立费用上限

证据：首次失败与修复后结果、执行环境与SHA、去敏trace、FAIL/BLOCKED、docs/evals入口。

## 子Issue 01：堵住网络副作用边界，修正响应上限和默认录音
依赖：前序工作包已交付必要边界和证据。
改动范围：shared/fetch/control；tools/fetch-batch；background fetch handlers；voice-client/capture-store。

完成标准：
- [ ] 隔离服务端证明未授权副作用为零，覆盖POST和嵌套入口
- [ ] 流式限额、截止时间、取消、重定向拒绝和UTF8跨块均通过
- [ ] 普通语音零原始音频落盘，诊断显式授权且可关闭

证据：首次失败与修复后结果、执行环境与SHA、去敏trace、FAIL/BLOCKED、docs/evals入口。

## 子Issue 02：任务终态必须有唯一可核对交付
依赖：前序工作包已交付必要边界和证据。
改动范围：session/task-results/task-progress/user-delivery/conversation-manager/voice-service。

完成标准：
- [ ] 复现动作完成但没有结果的缺口并补回归
- [ ] 500例终态唯一且不丢交付；partial/unknown不能变成功
- [ ] 语音失败保留文字；补交付不可调用写工具

证据：首次失败与修复后结果、执行环境与SHA、去敏trace、FAIL/BLOCKED、docs/evals入口。

## 子Issue 03：分离语音输入、播放与任务生命周期
依赖：前序工作包已交付必要边界和证据。
改动范围：voice-session/voice-intent/voice-plan-store；TaskDispatcher保持权威。

完成标准：
- [ ] 固定事件回放先建立，迁移前后有效行为一致
- [ ] 晚到ASR、重复commit、只读插话、复合指令全部覆盖
- [ ] 真实声学打断单独测；未测标BLOCKED

证据：首次失败与修复后结果、执行环境与SHA、去敏trace、FAIL/BLOCKED、docs/evals入口。

## 子Issue 04：连接、存储规模和安装诊断
依赖：前序工作包已交付必要边界和证据。
改动范围：task-dispatcher/store；transport；main/uplink；doctor/settings。

完成标准：
- [ ] 20k回执与200会话下性能达标，去重语义不因清理退化
- [ ] 100次故障恢复无错误重放；帧限额与控制优先级通过
- [ ] 升级/回滚不丢凭据、记忆、会话和请求身份

证据：首次失败与修复后结果、执行环境与SHA、去敏trace、FAIL/BLOCKED、docs/evals入口。

## 子Issue 05：收敛侧栏信息层级，不丢输入和控制权
依赖：前序工作包已交付必要边界和证据。
改动范围：sidepanel main/styles/steps/voice-ui/models/memory；独立store/selectors。

完成标准：
- [ ] 新开面板仍为新会话，后台任务可返回
- [ ] 默认只突出页面/任务/结果/控制；进阶能力第二层保留
- [ ] 尺寸、200%缩放、键盘、减少动态、长历史交互通过并真人审阅

证据：首次失败与修复后结果、执行环境与SHA、去敏trace、FAIL/BLOCKED、docs/evals入口。

## 子Issue 06：按固定任务集优化正确率、延迟和成本
依赖：前序工作包已交付必要边界和证据。
改动范围：prompt/observation/session/IO/voice；只按trace定位瓶颈。

完成标准：
- [ ] 150次独立核验总成功率≥95%、每类≥90%
- [ ] 单动作首动作p95≤6秒、核验终态p95≤10秒；语音有意义首音p95≤2秒（合格子集）
- [ ] 成本计算含失败/路由/TTS，不改门槛刷通过

证据：首次失败与修复后结果、执行环境与SHA、去敏trace、FAIL/BLOCKED、docs/evals入口。

## 子Issue 07：晋级精确产物并移除旧生产路径
依赖：前序工作包已交付必要边界和证据。
改动范围：release verify、构建、README/STATUS、迁移与旧路径清单。

完成标准：
- [ ] 移除旧路径后再次验证，不将双实现测试结果套在不同产物
- [ ] 所有必需门槛PASS+真人签字；FAIL/BLOCKED不正式发布
- [ ] 保留至少两个既有稳定安装包；无稳定版本则保留恢复快照，不删除Git历史

证据：首次失败与修复后结果、执行环境与SHA、去敏trace、FAIL/BLOCKED、docs/evals入口。
