# 任务: 查清用户已有的四家模型通道能否做「一个 token 出选项概率」的判断

背景：Privatemode 公开了用 GLM-5.3-Flash 做 Jev 式判断的方法（[原文](https://www.privatemode.ai/blog/system-one-from-glm-flash)、[实现](https://github.com/edgelesssys/privatemode-decisions)）：预填回答开头，把输出限定在选项编号，读取指定 token 的概率。它依赖 vLLM 的扩展参数（`logprob_token_ids`、`allowed_token_ids`、预填）。若用户自己的模型通道能返回选项概率，`AskJev` 可以有第二个实现，陌生人安装时不必另开 TypeSafe 账号，也能把截图作为状态。2026-09-29 用户同意先各发 1 次请求探路。

## 完成标准

- [x] 1. 四家通道各 1 次请求（三选一分诊题，`logprobs: true`、`top_logprobs: 5`、温度 0），记录是否返回逐 token 概率 — 谁检查: 探针脚本输出
- [x] 2. 不改产品代码 — 谁检查: 人

## 结果

| 通道（套餐） | 模型 | 回答 | 概率 |
|---|---|---|---|
| 智谱 GLM Coding Plan `open.bigmodel.cn/api/coding/paas/v4` | glm-5.3-flash（关思考） | `0` | 接受参数但不返回（`logprobs: null`） |
| 阶跃 Step Plan `api.stepfun.com/step_plan/v1` | step-5-preview | `0` | 返回，但第一个 token 是思考文字 `We`（-0.08），`0` 只排第三（-7.5）；45 个输出 token |
| MiniMax `api.minimaxi.com/v1` | MiniMax-M2.7-highspeed | 64 token 内仍在 `<think>` | 不返回（`logprobs: null`） |
| Kimi Code `api.kimi.com/coding/v1` | kimi-for-coding | — | HTTP 400：`invalid value for param logprobs` |

合计约 390 token。Kimi 的 OAuth 已过期，按 Pi 自己的刷新流程续期后再请求（写回 `~/.pi/agent/auth.json`，与 Pi 平时的行为相同）。

## 结论

- 四家都不能直接用这个方法：三家拿不到概率；阶跃能拿到，但思考关不掉，第一个位置不是答案。
- 阶跃在答案那个位置的 `top_logprobs` 是否可用（即原文的「先思考再判断」变体）没有测；即使可用，每次要几十个思考 token、约 2.7 s，不是一次前向的快判断。
- `AskJev` 的第二个实现暂不做；Jev 维持现状。要换通道，需要能返回指定 token 概率的服务（vLLM 自部署或 Privatemode，后者要本机代理，和「只装扩展」冲突），届时另行评估。
