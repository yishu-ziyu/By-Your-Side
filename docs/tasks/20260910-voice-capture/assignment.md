# 子任务：语音采集改为正常使用中自动进行（DeepSeek 实现）

你是用户授权的 DeepSeek 主要实现者，通过 jcode 运行。目标：完成 `docs/evals/20260910-voice-capture-normal-mode.md` 的全部实现与定点测试，不扩大成分析平台。

先读：该验收契约、`docs/evals/20260910-voice-diagnostic-capture.md`、`docs/tasks/20260910-voice-diagnostics/lessons.md`、`docs/tasks/20260910-voice-diagnostics/evidence-r1-implementer.md`，再读你要改的文件。你不是唯一工作者：不要撤回他人的改动，不要重排无关空白。

## 背景（上一轮已实现，本轮复用）

手动诊断模式已经能记录：C0（扩展侧、分类器之前的连续 24k PCM）、C1（agent 侧 `socket.send` 成功后的真实字节）、服务原始转写（旧轮过滤前）、实际转发文字、界面文字。本轮把它接到正常使用路径：用户日常用语音时自动记录，不再手动开，且不能改变任何语音行为。

## 必须实现

### 1. 协议（`shared/voice.ts`）

- `{kind:'start'}` 增加可选 `capture?: true`：只采集、不改变行为。
- 新命令 `{kind:'capture'; turn: number; data?: string; sampleRate?: number; serverText?: string; displayText?: string; mark?: true; note?: string}`，语义：扩展把这一轮它自己才知道的信息交给 agent 落盘；同一条命令允许分多次发（先发 C0，文字确定后再发文字），agent 按 voiceId+turn 归并即可。
- 校验（写进 `isVoiceClientMessage`，并与 `VOICE_DIAG_TEXT_MAX` 对齐）：
  - `turn` 合法（>0 安全整数）；
  - 至少要有 `data`、`mark`、`serverText`、`displayText` 之一，否则非法；
  - `data` 为非空 base64（字符集与长度倍数同 `validPCM` 规则），上限新常量 `VOICE_CAPTURE_MAX_BASE64 = 8_000_000`；
  - `sampleRate` 缺省允许，给了就要 >0 且 ≤192000；
  - `serverText`/`displayText` 用 `diagTextField` 同一上限；`note` ≤200。

### 2. agent：记录与禁动作解耦

- `VoiceDiagnosticTrace` 把“记录”和“改变行为”拆成两件事：`capture`（是否记录）与 `blocking`（是否禁 route/steer/网页动作）。`active` 保持“记录开启”的语义，新增 `blocking`；所有**改变行为**的分支改用 `blocking`，所有**记录**分支保持 `active`。
- 逐条检查 `agent/src/voice-session.ts` 里现有的 `this.diag.active` 判断，把“诊断模式不执行任务/不接话/不发动作/连接断就 fail”这类改成 `blocking`；把“记录 append/commit/item/asr/forward/gap、60 秒上限”这类保留为 `capture` 或按原诊断语义处理。正常采集不得禁用 route/steer，也不得改变已有的 90 秒上限。
- `agent/src/voice-service.ts`：`start.diagnostic===true` → blocking + capture；`start.capture===true` → 只 capture。

### 3. agent：落盘（新文件 `agent/src/voice-capture-store.ts`）

- 目录 `~/.sideagent/voice-capture/`，事件写 `YYYY-MM-DD.jsonl`，一行一条 JSON：`at`、`voiceId`、`conversationId`、`turn`、`type` 及该类型字段。音频**不**内联进 JSONL，写路径。
- 音频目录 `audio/<YYYY-MM-DD>/`：C0 写 `<voiceId>-t<turn>-c0.wav`；C1 在该轮 `commit` 时把它这一轮所有 `append` 的字节按序拼成 `<voiceId>-t<turn>-c1.wav`（24k 单声道 16bit WAV，自己写 header）。
- 追加写；任何写失败只记一条缺口（事件里带 `write_failed`），绝不能抛到语音链路里。
- 清理：新会话开始时执行一次，音频超过 14 天、或目录总量超过 2GB 时删最旧，直到满足。清理失败只记日志。
- 提供一键清空：`node scripts/clear-voice-capture.mjs`，并在 `package.json` 加 `capture:clear`。清空前打印将删除的路径与总量，删除 `~/.sideagent/voice-capture/` 内容但不删目录本身。
- `agent/src/main.ts` 接线：构造 store，把会话的采集事件与 `capture` 命令交给它。

### 4. 扩展：自动采集 + 一秒标记

- `voice-client.ts`：正常会话启动时带 `capture:true`；保留现有手动诊断模式（`diagnostic:true` 时仍然 capture + blocking，行为不变）。
- C0：正常模式下也按轮累积连续 PCM，一轮结束时一次性发 `{kind:'capture', turn, sampleRate, data}`（不要每帧发一条）。上限沿用每轮 60 秒。分类器与上行音频的处理顺序不得改变。
- 界面文字：该轮 question 文字渲染确定后，再补发一次 `{kind:'capture', turn, displayText}`；已有 serverText 的记录保持不变。
- 标记：把侧栏现有的诊断 `<details>` 区块改成“语音记录”区块，加一个「这条不对」按钮，点一下对**最近一轮**发送 `{kind:'capture', turn, mark:true}`，并在按钮旁给可见反馈（例如“已标记 18:42”）。一次点击完成，不弹输入框、不中断录音、不停止语音、不改变任何语音状态。保留原有开始/结束/导出/清空等调试能力，不要把它们删掉。
- 不自动播放音频、不自动上传、不把密钥写进记录。

### 5. 测试

- 新增 `agent/test/voice-capture-store.test.ts`（JSONL 与 WAV 写入、C1 拼接、14 天/2GB 清理、写失败只记缺口）。
- 更新 `agent/test/voice-diagnostic.test.ts`、`extension/test/voice-diagnostic.test.ts`，新增 `extension/test/voice-capture-command.test.ts`（或等价名字）：正常采集不禁 route/steer（反例：旧诊断仍禁）、capture 命令校验（缺字段/超长/base64 非法被拒）、C0 一轮一次、标记只发一次且不改语音状态、displayText 补发。
- 跑：`npx vitest run` 相关定点文件、`npm run typecheck`、`npm run build`。不要跑全量测试套件。

## 所有权

只有你能改：`shared/voice.ts`、`agent/src/voice-diagnostic.ts`、`agent/src/voice-session.ts`、`agent/src/voice-service.ts`、`agent/src/main.ts`、新 `agent/src/voice-capture-store.ts`、`extension/src/sidepanel/voice-client.ts`、`extension/src/sidepanel/voice-diagnostic.ts`、`extension/src/sidepanel/voice-ui.ts`、`extension/src/sidepanel/styles.css`（只追加）、相关测试、新 `scripts/clear-voice-capture.mjs`、`package.json`（只加脚本）。

不要改：`AGENTS.md`、`docs/STATUS.md`、`docs/NOTES.md`、图标/光标相关文件、任务执行模块、模型参数、VAD/断句/滤词参数，以及其它未列出的文件。确实需要最小接线时先报告。

## 纪律

- 最多 20 次定点读取后开始写最小实现，不扫全库。
- 每轮失败把“检查项 / 失败值 / 根因”追加到 `docs/tasks/20260910-voice-capture/lessons.md`；同一检查连续 3 次失败或 3 轮就停，报告后交给主代理。
- 不得启动浏览器、服务、真实 ASR 或录音；不提交、不推送；不读凭据。
- 完成后报告：改了哪些文件、定点结果、尚未验证的点。不要用单元测试通过宣称语音体验已改善。
