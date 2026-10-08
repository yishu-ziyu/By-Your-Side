# GPT-Live 用 ChatGPT 登录态：前提实验

日期：2026-10-09。用户意图：边用浏览器边说话，助手分清闲聊与要动手的事，动手时边做边播报。本文只证明技术前提，产品功能尚未实施。接续 [Step Plan 全双工接入](20260908-step-plan-full-duplex-integration.md)。

## 结论

ChatGPT 登录态（不用 API key）可以开 `gpt-live-1-codex` 全双工语音。真实会话中，闲聊由语音模型直接回答；网页请求产生一次委派，委派带用户原话；回传结果后语音模型口播。助手说话时用户开口，约 0.2 秒后旧回答被截断，服务端自己判停，不需要本地音量判定。

用户提供的调研称会员额度不覆盖 GPT-Live。这只适用于公开模型 `gpt-live-1`；订阅走另一个模型和入口。

## 来源

- [openclaw](https://github.com/openclaw/openclaw) `extensions/openai/realtime-quicksilver-*.ts`：TypeScript，订阅路径完整实现。只读，未运行。
- [GPT-Live 1](https://developers.openai.com/api/docs/models/gpt-live-1.md)、[委派](https://developers.openai.com/api/docs/guides/live-delegation)：公开 API，要求 Platform key。
- 社区同类实现：[opencode-gpt-live](https://github.com/shuv1337/opencode-gpt-live)、[hermes-live-voice](https://github.com/Synero/hermes-live-voice)。未读源码。

## 实测

探针：[WebSocket](../../scripts/probes/gpt-live-login-premise.mts)、[WebRTC](../../scripts/probes/gpt-live-webrtc-premise.mts)。凭据取自 `~/.pi/agent/auth.json` 的 `openai-codex`，只在内存使用，未刷新、未打印、未写入原件。三次会话共约 2 分钟，计入用户 ChatGPT 套餐。

| 路径 | 结果 | 原件（`out/acceptance/gpt-live/`） |
|---|---|---|
| WebSocket `/v1/live` | 拒绝：`Voice session access denied` | `2026-10-08T16-04-51-922Z-login-premise` |
| WebRTC，闲聊后查词 | 通过：闲聊直答，委派 1 次，口播结果 | `2026-10-08T16-07-45-355Z-webrtc-premise` |
| WebRTC，回答中插话查词 | 通过：旧回答截断，委派 1 次，口播结果 | `2026-10-08T16-10-13-401Z-webrtc-premise` |

## 对产品的约束

- 只能走 WebRTC。建通话请求发往 `chatgpt.com`，扩展需要该主机权限。浏览器建立音频连接；事件经 `oai-events` 数据通道到达，委派也在其中。结果能否也经数据通道回传未验；若不能，需要带鉴权头的 sideband，沿用现有加头方式。
- 语音模型会添油加醋。第二次口播加了回传结果里没有的“半双工”一句。项目规则是只播已核验的结果，桥接层必须约束它，不能只靠提示词。
- 委派早于用户说完：委派在第 14.2 秒，用户话轮在第 15.2 秒结束。拆句、改口与旧委派作废要按现有[调度](../voice-dispatch.md)规则处理。
- 两次闲聊开头都丢了字。原因是假麦克风先于连接播放，属于探针问题；产品里仍按“开口不丢字”另验。
- 现有工具里，`mark` 一次圈一个元素，不能按词圈多处；“圈高频词”需要新能力。

## 未验证

- 扩展内运行：本实验是 Node 加无头 Chrome，不是扩展路径。
- 真人外放与回声、长会话时限、套餐用量上限、并发委派、委派取消。
