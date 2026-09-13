# 审阅证据与边界

固定审阅SHA：`176e23fd103497e522c5fc0428af2c559733e6c8`。所有源文件以这个SHA读取。

## 读取记录

以下为本次主要检查点。行号是原文件请求读取范围，不代表全文审计；接口部分长响应有截断，结论仅基于实际可见部分。

### E01 · 分支身份与保护状态
路径：`GitHub branches/main API`。

当前读取SHA为176e23f；protected:false。仅据此判断当前分支保护，不据此推断所有CI都不存在。

### E02 · 产品架构与README漂移
路径：`README.md:1–230; package.json`。

MV3 + Node/Pi +原生侧栏；README关闭重开恢复旧会话的描述与最新STATUS/提交不一致。

### E03 · 作者报告而非本次实测
路径：`docs/STATUS.md:1–150`。

作者报告153文件1341项测试通过；单动作对照3次/新版本5次，多步探针仍有1/3没交付；真人观感未验。

### E04 · 持久化请求去重
路径：`agent/src/task-dispatcher.ts`。

canonical fingerprint、原子claim、unknown不自动重做；list同步扫描文件，规模风险须实测。

### E05 · 真实快慢链路已接通
路径：`agent/src/main.ts; agent/src/voice-service.ts`。

VoiceService从任务快照读取，并把请求交给ConversationManager；不是一个只有语音输入的空壳。

### E06 · 语音状态集中
路径：`agent/src/voice-session.ts:1–600`。

读取了连接、重连、输入映射、打断、挂起请求、早回应、TTS和交付队列关键区间；未声称全文所有分支均完成审计。

### E07 · 实际任务路由和复合计划
路径：`agent/src/conversation-manager.ts:1–220; agent/src/voice-intent.ts:1–160`。

已存在目标消歧、原文覆盖、否定/引用规则、plan和receipts；不能当作这些能力完全缺失。

### E08 · 按工具名触发写保护
路径：`shared/control.ts:1–170; agent/src/tools.ts:1–155`。

WRITE_TOOLS不含fetch；tools.call对isWriteTool检查canWrite/epoch；未知副作用请求需补边界。

### E09 · fetch副作用与重定向
路径：`extension/src/background/exec/fetch-url.ts; shared/fetch.ts`。

允许GET/POST、带credentials、redirect follow；只检查初始hostname。静态确认实现，未在用户登录网站实施攻击或确认实际危害。

### E10 · 响应上限失效形态
路径：`shared/fetch.ts`。

readCappedText先arrayBuffer再subarray；是展示截断，不是增量读取内存限制。

### E11 · 默认诊断录音
路径：`extension/src/sidepanel/voice-client.ts:126–235; agent/src/voice-capture-store.ts:1–150`。

普通start发送capture:true；store支持WAV和转写，14天/2GiB；修改默认需与明确诊断模式区分。

### E12 · 现有UI结构
路径：`extension/src/sidepanel/main.ts:1–155; sidepanel目录树`。

原生DOM、marked/DOMPurify、已有教学/知识/新会话/模型/语音入口；未在本次环境渲染截图或裁定实际视觉品质。

### E13 · 测试类型边界
路径：`scripts/acceptance/run-status-ui.mts:1–95`。

真实构建UI+mock chrome.runtime/合成事件；有效渲染测试，不是产品端到端。

### E14 · 可移植验收缺口
路径：`scripts/acceptance/run.mjs:1–170`。

现有入口连接特定ChromeMain；需另建隔离可重复正式验收入口，而非默认打开用户Chrome。

### E15 · 已有控制/结果/执行基础
路径：`agent/src/conversation-runtime.ts:1–205; agent/src/session.ts:1–100; extension/src/background/index.ts:1–115; extension/src/background/exec/evaluate.ts`。

保留既有控制/身份/核验；rawJS本身不是只读沙盒，工具功能收窄不能仅靠提示词。

### E16 · 仓库开发授权与规范
路径：`AGENTS.md:1–160`。

主代理独立开发；先标准后实现；隔离与真实入口不混淆；默认无头；不以文档自行授予破坏性权限。

## 源文件定位方式

把路径代入以下固定提交模板，避免main继续变化造成对不上：
```text
https://github.com/yishu-ziyu/By-Your-Side/blob/176e23fd103497e522c5fc0428af2c559733e6c8/<path>
```

## 平台事实的一手资料

Chrome扩展生命周期和Native Messaging限制；读取策略参考MDN Response/ReadableStream。具体实现时再次核对目标Chrome版本，不采用旧Chrome Apps文档中的过时上限。

```text
https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
https://playwright.dev/docs/chrome-extensions
https://developer.mozilla.org/en-US/docs/Web/API/Response/arrayBuffer
https://developer.mozilla.org/en-US/docs/Web/API/Response/body
```

## 不能据此宣称的事情

没有本次全仓test/build结果；没有真实Step Plan可用性、延迟或转写准确率；没有真实声学AEC证明；没有实际用户UI观感评测；没有执行恶意网络副作用探针；没有完成所有存储迁移验证。

因此本包没有给当前版本颁发PASS，也没有将任何建议目标写成已测数据。fetch与默认录音问题属于静态实现检查；对实际跨层危害的结论须用隔离fixture证明。

GitHub连接用于读取。尝试容器克隆未成功，环境无法解析github.com；未通过替代用户登录态或打开个人Chrome绕过。
