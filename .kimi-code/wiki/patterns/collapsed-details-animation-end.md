# Pattern: 折叠内容里的 CSS 动画不会启动，`animationend` 不会来

## 现象

2026-09-11 做面板运行态收束（A+B 动效）时，给光球加一次性收束动画，本想用
`animationend` 摘掉 class，结果 class 永久残留：在折叠的 `details` 里（思考块、执行块默认都是收起的），
动画从来没跑过，事件自然也不会来。若只在展开态手测，会完全看不出问题。

## 根因

关闭的 `details` 里的非 `summary` 内容不在渲染中，动画不会被创建——但**计算样式仍然报告动画名**，
所以"看 `getComputedStyle().animationName`"判断不出这件事。必须看事件是否触发或 `getAnimations()`。

## 方法

- 靠"动画结束"清理状态时，不要只依赖 `animationend`；折叠内容用 `setTimeout` 按时长兜底摘除，
  或把清理挂在真正的业务事件（工具结束、状态行落定）上。
- 需要在折叠态也保持正确时，把还原动作写成"移除 class 即回到常态"，而不是"必须等动画播完"。
- 判断动画是否真的在跑，用 `document.getAnimations().length` 或像素/属性变化，不用计算样式。

## 适用条件

任何"动画结束后摘 class / 切状态"的写法，且该元素可能位于关闭的 `details`、`hidden`、
未激活标签页等不渲染的容器里。前景可见的常驻元素不受影响。

## 验证

2026-09-11 隔离 headless Chrome for Testing 探针（`details` 默认关闭，内部元素带 `fadeIn 120ms`）：

| 状态 | `animationstart` | `animationend` | `document.getAnimations().length` | 计算样式 `animationName` |
|---|---:|---:|---:|---|
| 关闭 | 0 | 0 | 0 | `fadeIn` |
| 打开后 | 1 | 1 | 0（已结束） | `fadeIn` |

复现要点：`<details id="d"><summary>s</summary><span id="x">a</span></details>` +
`#x{animation:fadeIn 120ms linear}`，先读一次计数，再 `d.open = true` 读第二次。

## 来源

本轮面板运行态动效实现（[验收](../../../docs/evals/20260911-panel-live-motion.md)，
代码留痕在 `extension/src/sidepanel/orb.ts` 的 `setRunning(false)`）。用户在此前会话要求
"一点改动也要记录"，故单独成条。
