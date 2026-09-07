# 观察与点击可靠性：cmux 编排

编排与最终校验：Codex，workspace:8/surface:11。
标准：`docs/evals/20260907-observation-click-integrity.md`。

| 执行者 | 现场模型配置 | 所有权 | 回应报告 | 状态 |
|---|---|---|---|---|
| OpenCode / surface:12 | Muse Spark 1.3 Contributor, xhigh | 截图、快照及其元数据 | 20260907-opencode-observation-report.md | 已接收，执行中 |
| Grok / surface:13 | Grok 4.6, high | 点击、交还约束及其测试 | 20260907-grok-click-report.md | 已接收，执行中 |
| Antigravity / surface:9 | Gemini 3.8 Flash, medium | 前端干扰夹具、独立验收脚本 | 20260907-antigravity-fixture-report.md | 已接收，准备中 |

模型配置来自派工前实际终端画面，不推断其他会话的配置，不擅自切模型。

- 每位执行者先读锁定标准，保留其他未提交工作，不能改变完成定义。
- 未授权新的子代理、分支切换、worktree、提交/push、全量build或重载。
- 浏览器目前由Codex持有；任何执行者运行真实浏览器前需要Codex授予独占时段，避免不同代理影响测试起点。
- 完成/阻塞必须主动cmux send到surface:11，并附报告路径；REVIEW_READY不等于最终通过。
- 模型出错、权限提示、契约冲突由Codex按已授权范围协调，不把协调工作反复丢给用户。
- 基础构建hash与工作树差异快照在 `out/acceptance/integrity-coordination/`，现场工件不默认进入Git。

## 第一轮复核与基线

- OpenCode首轮14项聚焦测试通过，但A2缺捕获后身份核对、PNG解码失败仍回0；已退回补齐锁定标准。另授权最小修改content/snapshot.ts处理viewport下视口外iframe泄漏，非全量iframe实现。
- Antigravity初版断言存在假通过风险（工作页未切回、缺字段跳检、遮挡OR判定、伪handback）；已要求修正，B3真实模型和A2/B1故障注入不许冒充已覆盖。
- 当前浏览器独占：Antigravity，仅旧构建viewport基线，禁止build/reload；其余执行者继续代码工作。完成后须明确释放并回报。

## 集成检查

- OpenCode补齐捕获前后URL/活动页/视口核对、解码失败拒绝、viewport iframe占位、程序/日志元数据透传，代码已冻结。
- Grok补齐真实mouseenter后按下前命中、纯坐标对象检查与AX/shadow边界；配套类型错误已修，代码已冻结。
- Codex独立运行：51文件482测试通过、npm run typecheck通过、npm run build通过。
- 接下来部署修复版：Antigravity跑普通六场景；Codex另跑fault注入与B3同会话真实模型，各自独占浏览器。

- 22:10左右：最新源码集成再次通过typecheck、482测试和build，扩展已reload。
- 浏览器独占授予Antigravity：修复版普通六场景；B3与故障分支保留未覆盖，由Codex之后接手。禁止其他执行者重载/抢浏览器。
