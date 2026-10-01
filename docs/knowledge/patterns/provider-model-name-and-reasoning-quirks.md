# Pattern: 模型「调得通」不等于名字对、参数对、指令被听

## 现象（10-01 实测）

- MiniMax Anthropic 接口收到不认识的模型名（如 `Totally-Fake-Model-9`）不报错，静默换成 MiniMax-M3 回答；回答里模型还自报名字。真模型 `MiniMax-M3.1-Flash-Preview` 不在 `/anthropic/v1/models` 列表里，却真实可用。
- 同一个「最低思考档」：OpenCode mimo-v2.6-flash 拒绝 `minimal`（400）；MiniMax-M3.1 反过来要求必须思考，不传档位时库默认发「关闭思考」被 400。后台判断因此整批静默失败。
- 开了思考后 pi-ai 的 OpenAI 兼容适配把系统提示词改用 `developer` 角色，阶跃 step-3.7-flash 忽略它，直接和用户聊天，「只回 JSON」0/9。

## 方法

- 判断模型名是否真实：看响应体里的 `model` 字段是否被服务端改写（与编造名对照），不看能否调通、不看模型自报名字；列表接口可能滞后。
- 思考档位、能否关闭思考、系统提示词角色、能否收图，按 provider/model 实测登记在一处（`shared/model-capabilities.ts`），不按名字猜；被拒时换档重试并记原因。
- 后台判断的「格式不对」要能被诊断看见，并修复重试一次。

## 适用条件

2026-10-01 实测：MiniMax 国内 Token Plan（`api.minimaxi.com/anthropic`）、OpenCode Go mimo、阶跃 Step Plan。其他服务商未验证。

## 验证与来源

- [模型思考档与后台判断](../../evals/20261001-model-effort-and-side-judgments.md)：探针表与「实测中的发现」。
- [答非所问诊断](../../evals/20261001-offtopic-reply-diagnostics.md)：mimo minimal 400。
