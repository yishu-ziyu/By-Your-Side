# Pattern: 设置的提示和实际效果各读各的默认值

## 现象

侧栏「操作方式」按钮的悬浮提示写「右击切换手绘动效：持续微抖」，页面上画出来的圈却是「生长定格」；右击切换后提示变了，圈还是旧的。没有报错，单元测试全过。

## 原因

- 同一个偏好有两个默认值：侧栏 `main.ts` 是 boil（2026-09-09 用户决定），后台 `mode.ts` 仍是 grow。storage 里没存过偏好时，两边各显示/执行各自的默认。
- 后台把偏好缓存在模块变量里，只在自己的 setter 里更新；侧栏右击直接写 `chrome.storage.local`，后台缓存不知道。
- 旧单测分别测了后台 getter/setter 的往返，从没把「提示文字」和「画出来的结果」放在一起比。

## 方法

- 用户可见的设置，提示与效果读同一个来源；跨进程（侧栏/后台）时每次现读 storage，不缓存，或订阅 `storage.onChanged`。
- 默认值只定义一处；另一处必须 import，不抄常量。
- 验收断言「提示说的 == 实际发生的」，而且覆盖「未存偏好」和「切换一次后」两种状态：`scripts/acceptance/real-path/mark-motion-toggle.mts` 读按钮 title，再用 `DOM.getDocument({pierce:true})` 读封闭 shadow root 里圈画的 class。

## 适用条件

扩展里侧栏与后台（service worker）分别持有同一偏好的场景；其他「显示层和执行层分属不同进程」的设置同理。

## 验证与来源

- [仓库清理](../../../docs/evals/20260923-repo-cleanup.md)「清理暴露并修掉的两个真问题」第 1 条：修复前 2 项 no，修复后全 yes，产物在 `out/acceptance/real-path/`。
- 2026-09-23，仓库清理会话主代理。
