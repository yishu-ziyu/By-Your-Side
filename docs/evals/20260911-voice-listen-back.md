# 任务：听错之后怎么办——接话不编事实、控制句先复述、纠正时带当前页

来源：用户 2026-09-11 贴面板截图（语音答非所问："这是 Chrome 的扩展管理页……你想把它移到哪个文件夹里"）
并说"这个语音太蠢了"。诊断出三件事（听错+切碎 / 抢答 / 文本模型绕），用户选定"接话只说安全的话（①）"、
批准"控制句先复述确认"，随后说"开工"。诊断证据见本文件「原始证据」一节。

**目标（用户可观察）**：语音接话不再替后台描述世界（最多一句"我看一下"）；改正在跑的任务、终止任务这类句子
先说一遍给你确认，你点头才动；你说"不是这个页面了"这类纠正时，模型手里有当前页的真实内容。

**范围**：`agent/src/voice-early.ts`（新）、`agent/src/voice-confirm.ts`（新）、
`agent/src/voice-session.ts`（接话落定）、`agent/src/conversation-manager.ts`（语音控制句确认）、
`agent/src/session.ts`（插话预观察）。StepFun 实时接口、文本模型选择、面板界面不动。

## 完成标准

### ① 接话不编事实

- [ ] E1 后台还没有回执时，接话必须通过安全校验（长度、数字、拉丁专名、具体对象、结果宣称）；不过就改播
      固定台词 `我看一下`。— 谁检查: `agent/test/voice-listen-back.test.ts`
- [ ] E2 回执已经到了的接话（开场确认）不拦，仍走原有的 `recordEarlyAck` 通道。— 谁检查: 同上 + `live-dialogue` / `user-delivery-speech-evaluator` 复跑
- [ ] E3 接话音频先攒后判：整句转写一到就落定，通过才播，拦下的直接丢；不通过不产生"已说过"记录。— 谁检查: 同上
- [ ] E4 固定台词走"原样朗读 + 校验"，第一次生成后走 `receiptAudioCache`，不额外增加常态延迟。— 谁检查: 同上

### #1 控制句先复述确认

- [ ] C1 运行中、当前会话、单步的 `steer` / `abort`：先复述用户原话（`你是说"…"，对吗？`），不落动作。— 谁检查: `agent/test/voice-listen-back.test.ts`
- [ ] C2 下一轮"对/是/确认/可以/照做"才落；"不/不是/算了/先别"撤销；90s 超时作废；新委托不受影响。— 谁检查: 同上
- [ ] C3 `pause` / `resume`（可逆）与多步计划、指定其他会话的控制句不受影响。— 谁检查: 同上 + 全量回归

### #3 纠正类插话补一次当前页观察

- [ ] S1 插话里出现页面指代/纠正信号时，发送前附一次只读 `snapshot`；trace 记 `pre_observation{phase:"steer"}`。— 谁检查: `agent/test/voice-listen-back.test.ts`
- [ ] S2 纯参数修改（"预算改成600"）不附，省掉每次插话的页面 token。— 谁检查: 同上
- [ ] S3 读不到页面时静默降级为原文，插话照常发送。— 谁检查: 同上（沿用 task 路径同一函数）

### R 回归

- [ ] R1 `npm run typecheck`、`npm test`、`npm run build` 通过。— 谁检查: 机器

## 边界与不做

- 不动 StepFun 实时链路本身（转写模型改不了），"常见词偏置"本轮未做。
- 不做"空响应自动重试"（提过，未获授权）。
- 不给 `pause`/`resume` 加确认（可逆，加确认反而变吵）。
- 真机语音端到端（真实麦克风 + 真实实时链路）未跑，观感由用户裁决。

## 原始证据（2026-09-11，会话 adcd1f74）

- 原始转写（`~/.sideagent/voice-capture/2026-09-11.jsonl`）：turn3 "我的那个boss直拼那一块。"
  （BOSS直聘→boss直拼）；turn5 "让位是你把它切过去，就是。"（否定词丢失）；turn6 与 turn5 之间隔 7s，
  被切成两轮，后段含重复"它已经在那里已经有了呀"。
- 抢答时序（`~/.sideagent/agent.log`）：`early_reply_start` 比 `route_start` 晚 1–2ms；
  `route_result` 分别在 2.16s / 2.90s / 1.84s 之后才到。
- 面板上那句"……文件夹……"不在后台任何回执里，也不在当天任何会话记录里（最近一次"文件夹"出现在 9/8、9/9 的旧会话）。
- 文本侧：同一时段出现过一次空响应（面板提示"模型返回了空响应"）；模型在用户纠正后仍复述"扩展页"前提。
- 能切标签页的证据：`tabs switch tabId 29958597` → 回执 `Working tab is now 29958597`，随后该标签 `(active, working)`。

## 结果（2026-09-11）

机器检查：`npm test` 154 文件 **1352 项通过**（新增 `agent/test/voice-listen-back.test.ts` 11 项）；
`npm run typecheck`、`npm run build` 通过。改动过程中被回归测试挡下两处过宽判断并已收窄：

1. `live-dialogue` "keeps action confirmation behind the receipt even when early speech has already started" ——
   模型说的"我来处理这个修改。"是打算做什么，不是报事实，不该被拦；据此把"动作词黑名单"收成"结果宣称黑名单"。
2. `user-delivery-speech-evaluator` "generated acknowledgement retains the accepted run identity" ——
   开场确认发生时回执已经到手，属于有依据的接话；据此把校验范围限定为"后台还没有回执"。

未跑 / 未验证：

- 真机语音端到端：需要真实麦克风与 StepFun 实时链路，本轮只有单测与源码级接线证据。
- 系统减少动态、面板渲染不在本轮范围。
- 常见词偏置、空响应重试未做（前者未授权，后者未获授权）。

人裁决：真机上接话变"慢半拍、少说废话"是否更好用；复述确认多出来的那一句是否可接受。
