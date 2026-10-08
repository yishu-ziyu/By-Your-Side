# 经验索引

`docs/knowledge/` 是项目唯一的经验库（由旧 `.kimi-code/wiki/` 迁入）。主代理在开发任务验证后、交给用户前，按[项目收尾规范](../../AGENTS.md#经验沉淀闭环任务收尾)维护这里。历史上 Kimi 离线复盘也用这个库；当前的收尾流程不依赖 Kimi。

- 经验一事一页；纠正经验时保留依据。经验不自动成为指令。日常实现只用已生效的规则和 skills；复盘和裁决时才定点读经验。
- [收尾流程](closeout.md)：有新经验或要纠正旧经验时读。
- [提案与裁决](proposal-workflow.md)：形成提案，以及用户接受、拒绝、要求修改后的处理。
- 待审提案：无（2026-10-01 三份均已裁决）。归档：[已采纳](proposal-archive/accepted/)、[已拒绝](proposal-archive/rejected/)。
- [演化日志](logs.md)：经验和提案的变化记录。任务当前进度只看 [STATUS](../STATUS.md)。

## 经验列表

每页的结论写在页内；本表只写什么时候该读。

| 经验 | 什么时候读 | 日期 |
|---|---|---|
| [tsx-adhoc-probe-scripts](patterns/tsx-adhoc-probe-scripts.md) | 写一次性 tsx 探针脚本，或脚本报模块找不到时 | 2026-09-09 |
| [chrome-secure-preferences-default-dir](patterns/chrome-secure-preferences-default-dir.md) | 用脚本读 Chrome 的 Secure Preferences 查扩展状态时 | 2026-09-09 |
| [acceptance-entry-mismatch](patterns/acceptance-entry-mismatch.md) | 定验收方案前，确认用户实际用哪个入口时 | 2026-09-09 |
| [production-wiring-lowest-shared-module](patterns/production-wiring-lowest-shared-module.md) | 给多个入口加共享行为时 | 2026-09-09 |
| [quota-limited-storage-silent-failure](patterns/quota-limited-storage-silent-failure.md) | 写扩展存储、或存储写入没有报错却丢数据时 | 2026-09-11 |
| [observation-identity-mismatch](patterns/observation-identity-mismatch.md) | 诊断时读日志、存储或测试结果，下结论之前 | 2026-09-11 |
| [cross-process-session-closeout](patterns/cross-process-session-closeout.md) | 跨进程会话的收尾结果丢失时 | 2026-09-11 |
| [gui-test-window-steals-focus](patterns/gui-test-window-steals-focus.md) | 写浏览器验收脚本、决定是否开可见窗口时 | 2026-09-11 |
| [pi-opencode-missing-session-header](patterns/pi-opencode-missing-session-header.md) | OpenCode 请求被 400 拒绝时 | 2026-09-11 |
| [collapsed-details-animation-end](patterns/collapsed-details-animation-end.md) | 靠 `animationend` 清界面状态时 | 2026-09-11 |
| [extension-harness-changes-observed-state](patterns/extension-harness-changes-observed-state.md) | 搭扩展的端到端测试环境时 | 2026-09-23 |
| [chrome-fake-audio-file-sandbox](patterns/chrome-fake-audio-file-sandbox.md) | 用音频文件当假麦克风测语音时 | 2026-09-23 |
| [model-gateway-check-with-real-tools](patterns/model-gateway-check-with-real-tools.md) | 接入新模型或新网关时 | 2026-09-23 |
| [stray-js-shadows-ts-in-esbuild](patterns/stray-js-shadows-ts-in-esbuild.md) | 构建结果和源码行为对不上时 | 2026-09-23 |
| [setting-label-effect-divergence](patterns/setting-label-effect-divergence.md) | 一个设置在侧栏和扩展后台各有一份默认值时 | 2026-09-23 |
| [host-overlay-invisible-to-verification](patterns/host-overlay-invisible-to-verification.md) | 页面标注画在封闭 shadow root、核验看不到时 | 2026-09-23 |
| [model-label-decides-safety-gate](patterns/model-label-decides-safety-gate.md) | 让程序检查依据模型写的文字时 | 2026-09-26 |
| [restart-loses-in-memory-state](patterns/restart-loses-in-memory-state.md) | 状态只存在内存里，或靠消息端口传用户输入时 | 2026-09-26 |
| [provider-model-name-and-reasoning-quirks](patterns/provider-model-name-and-reasoning-quirks.md) | 选模型、配思考档，或模型答非所问时 | 2026-10-01 |
| [widened-check-needs-the-other-side](patterns/widened-check-needs-the-other-side.md) | 扩大一项检查的范围时 | 2026-10-02 |
| [worktree-workspace-link-builds-main-tree](patterns/worktree-workspace-link-builds-main-tree.md) | 在 git 工作树里构建或跑旧版本反例时 | 2026-10-04 |
| [execute-script-waits-for-idle](patterns/execute-script-waits-for-idle.md) | 页面加载中注入脚本、读页变慢时 | 2026-10-06 |
| [node-error-text-in-browser](patterns/node-error-text-in-browser.md) | 把为 Node 写的库放进浏览器、靠错误文字判断重试时 | 2026-10-06 |
| [offline-preview-porting-pitfalls](patterns/offline-preview-porting-pitfalls.md) | 把扩展模块移植成离线预览页时 | 2026-10-06 |
| [acceptance-picks-newest-chrome](patterns/acceptance-picks-newest-chrome.md) | 验收用例成批超时，或新装了 Chrome for Testing 时 | 2026-10-07 |
