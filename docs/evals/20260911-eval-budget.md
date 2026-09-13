# 任务: 用户授权 live 评测预算

2026-09-11。用户明确要求把预算要过来，并选择：

- 货币：USD
- 最高花费：**200**
- 最多模型调用：**2500**
- 最多音频分钟：**120**

评测任务模型冻结为 `minimax-cn/MiniMax-M3`（与既有隔离真模型样本一致）。不改用户日常 `~/.sideagent/config.json`（当前是 `opencode-go/deepseek-flash`）。

硬封顶文件：`~/.sideagent/eval-budget.json`。花费账本：`~/.sideagent/eval-spend.json`。任一上限触顶即停，不靠反复重跑洗首次失败。不打印密钥。默认隔离无头，不连日常 Chrome。

不含：真人耳麦打断（V05）、5 位陌生用户（H01）、20 次 RC 试用（H02）、真实支付/发布站。

谁检查: `npm run doctor` 的 evaluation_budget；`npm run eval:live -- --profile reference-macos`
