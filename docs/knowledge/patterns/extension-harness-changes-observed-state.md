# Pattern: 测试的托管方式会改掉被测扩展看到的环境

## 现象

两种现有做法让隔离验收测到的状态，是用户永远不会遇到的：

- **一直挂着调试会话，扩展后台就永远不被回收。** 没有 Native 连接、也没挂会话时，扩展后台约 30 s 被回收；挂上调试会话（`Runtime.enable`）后，观察的 65 s 内一直在；断开会话后约 25 s 内被回收。`scripts/acceptance/isolated-extension.mts` 从启动起就一直挂着会话，所以“回收后重连、回放”这条日常路径在它下面测不到。9/23 晚“点模型芯片没反应”就是在扩展后台重连后回放连接状态时丢了模型目录（[那次验收](../../../docs/evals/20260923-model-picker-empty-catalog.md)）。
- **面板放在普通标签页里打开，它会把自己当成当前页。** 在真侧栏里，`chrome.tabs.getCurrent()` 是 `null`，`tabs.query({active, currentWindow|lastFocusedWindow})` 返回的是用户的网页；在标签页里，这三个查询返回的都是面板自己。侧栏代码有 4 处这样取当前页（`sidepanel/main.ts` 的页面标牌、按站点列技能、恢复上下文、活动标签页 ID）。

## 原因

- 调试会话本身会让 Chrome 保持扩展后台存活。这是测量手段带来的副作用，不是产品行为。
- 面板页在标签页里时，它自己就是那个窗口的活动标签页；真侧栏不是标签页。

## 方法

- 只在需要时短暂挂上扩展后台的调试会话，用完就断开。要测“回收后重连”，先让 Native 连接断开（连接开着时扩展后台不会被回收，观察的 70 s 内一直在），再等 30 s 以上。
- 在真侧栏里测：先打开一个扩展页，在那里用带 `userGesture: true` 的 `Runtime.evaluate` 调 `chrome.sidePanel.open({windowId})`。从扩展后台直接调会被拒（“may only be called in response to a user gesture”）。真侧栏在调试协议里是一个 `page` 类型的目标，可以挂上去读。

## 适用条件

Chrome 149 `--headless=new` 下，隔离浏览器目录加真实构建扩展的实测结论。其他版本或有窗口模式未测。

## 验证与来源

- [端到端测试基础设施小实验](../../../docs/evals/20260923-e2e-infra-probes.md) 第 3、5 节。原始结果在本机 `out/probes/20260923-e2e-infra/`（git 忽略）。
- 2026-09-23，本轮主代理。
