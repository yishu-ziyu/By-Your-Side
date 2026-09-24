# 当前状态

核对日期：2026-09-23。本页按已有验收记录汇总，不把文档整理当成产品复验。

开发预览版，尚无完整发布通过结论。源码、日常构建、运行进程、本机配置与真人结果必须分别核对；本页不维护容易过期的 PID、模型目录或 Git 快照。

## 当前结论

| 范围 | 已知结论 | 尚缺什么／证据 |
|---|---|---|
| 验收遗留（real-path 入库、C01、C2） | real-path 已提交（`db0ad34`）；C2 隐藏页滚轮已修，门槛子集 10/10 通过；C01 在 3 个模型上通过 | C01 的"fetch 被拒后改为打开页面"回退没有在真实模型上跑到；C3 下载需要权限决定；未推送；[收口记录](evals/20260923-ci-gate-failures.md) |
| 用户点选元素 | 文字主会话已实现；选择、Esc、侧栏停止的真实隔离路径通过，未加载日常 | 语音、刷新/接管、多会话、三系统和真人观感未验收；[点选验收](evals/20260923-user-points-element.md) |
| 真实路径基础设施与清理 | 已有真侧栏、Native Messaging、真实模型入口；清理后保留两项基线测试失败 | 不能据此宣称发布通过；[清理记录](evals/20260923-repo-cleanup.md)、[验收入口](testing/acceptance.md) |
| 圈画结果核验 | 已补宿主标注读数；相关真实路径有通过证据 | 中文目标仍会升级主模型复核，额外耗时未解决；[标注证据](evals/20260923-mark-completion-evidence.md) |
| Browser v2 | REV 续接只确认过滤范围，旧全绿记录包含无效证明 | S6、下载后端、其他 CAP 缺口与审计/恢复红灯仍未关闭；[REV 记录](evals/20260922-browser-capability-integration-v2.md) |
| 语音与请求级开口 | 有专项实现、真实供应商与真人试用记录，试用后也有未加载修复 | 不把旧「未证明减话」继续作为最终结论，也不据单次成功推断全链稳定；[V2.3 全部证据](evals/20260922-v22-spoken-result-shadow.md) |
| 文档管理 | 短入口、26 份说明迁移与本地检查已完成；结构和文件同步检查通过 | 历史引用提醒保留，远端 CI 未运行；[标准与验证](evals/20260923-documentation-governance.md) |

## 仍需解决

- 改口后改写已有成功回执的字段、重启后的检查点续接与真人接管/交还仍有缺口。保留原对象、来源范围与未知写入保护，不靠放松核验消除失败；见[Computer Use 复测](evals/20260922-computer-use-product-path.md)。
- CAP-02 的 filechooser 停止清理、疑似重复测试尚未处理；详见[清理记录](evals/20260923-repo-cleanup.md)。
- 长任务、技能复用与旧票组不能因新专项通过自动关闭；见[产品复核](evals/20260919-product-review-repair.md)、[技能集成](evals/20260919-skill-loop-integration.md)、[票组裁决](evals/20260919-product-review-status-sync.md)。

## 下一步

分发方向：只做扩展（见 [路线图](ROADMAP.md) 第 6 条）。扩展内 agent 实验（2026-09-24 并入主目录并提交，`de381b0`）已证明：扩展内 agent 能用用户套餐完成圈画；扩展能直连 StepFun 实时语音，音色可在设置页切换。

2026-09-24 起的顺序：① 分批提交（完成）→ ② 语音鉴权头只给本扩展发起的连接（完成，`inproc-voice` 的 `pageCannotBorrowKey` 判据；修复前网页能用用户的 key 拿到已鉴权会话）→ ③ 同一组行为契约分别经过本机与扩展入口的测试（完成） → ④ 把任务核心搬进扩展，替换 `extension/src/inproc/host.ts` 的简化循环。④ 的分步、验收、决定与已知风险见[工作流跟踪](work/20260924-core-into-extension.md)，每步完成即更新。

日常 `extension/dist` 于 2026-09-24 被误重建为当时的主目录代码（接近 `de381b0`），之后未再改动；日常 Chrome 重载扩展前后行为会不同。不自动 push、重载或改日常配置。

## 历史

整理前的原始状态完整保存为[原文快照](history/20260923-status-before-governance.txt)。它保留当时的矛盾和旧“下一步”，只用于追溯，不作为当前指令。更早记录见[历史索引](history/README.md)。
