# Stagehand 兼容层进入现有控制链

用户批准保留Pi，把Stagehand接进ego。采用官方Playwright兼容代码+现有QuickJS/RPC适配，不另建浏览器控制链。这样保留任务页、授权、停止与纠正逻辑，也无需Browserbase Key。

真实面板/模型四步通过。过程中发现并修正上游trial选项丢弃、context别名、单人模式隐藏工具误拦定位、macOS全选与旧安装路径。验收脚本自身也修了会话启动、实时事件信封和隐藏停止按钮的误判。

[标准、实际结果与证据](../evals/20260913-stagehand-control-integration.md)。真人语音体验由用户亲测；本轮没有做提速对比或视觉改版。
