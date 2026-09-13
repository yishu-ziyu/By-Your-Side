# 回答排版预览

字体、回答层次和设置方案均已获用户认可并进入实际侧栏。当前状态见[STATUS](../../STATUS.md)，正式操作证据见[阅读外观验收](../../evals/20260913-reading-settings.md)。

启动：先执行 npm run build，再执行 node docs/previews/reading/server.mjs。页面使用真实构建的侧栏，注入本地样文和消息替身；不连接模型或账户。设置在预览localStorage保存，与真实扩展存储不同。

顶部切换原段落与整理后段落，栏宽320/440/600。两边使用当前生产样式，candidate.css保留为历史参考且已禁用。sample.md与sample-structured.md仅用于排版，内容未重新核查。

历史截图before.png/after.png用于第一步字体比较；structure-before.png/structure-after.png用于第二步回答层次比较。它们不代表所有回答会固定采用同一模板，也不证明当前设置存储或真实模型行为。
