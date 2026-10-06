# 把扩展代码移植进离线 HTML 预览原型的四个坑

> 现象、原因、方法、适用条件、验证与来源。一事一页；不自动成为指令。

## 现象

把扩展里的模块（光球引擎、手绘圈、弹簧）移植进 `docs/previews/*.html` 做可双击打开的预览原型时，反复踩同一组坑；每个坑都是「页面能打开但效果不对/交互死掉」，语法检查全过。

## 原因与方法

1. **`file://` 不能 `import` ES module**（CORS  origin 为 null）。方法：用 node 脚本把引擎源码的 `export` 块剥掉后整体内联进 `<script>`，再显式把需要的内部函数挂到 `window.__orbs` 之类的全局对象上。
2. **引擎内部顶层标识符可能与应用脚本撞名**。`thinking-orbs.js` 顶层有变量 `$`，应用脚本里再写 `const $ = ...` 直接 SyntaxError，整段脚本不执行。方法：应用侧统一改名（如 `qs`），不动引擎。
3. **`display:flex` 等自定义样式会覆盖 `[hidden]` 的 UA 样式**。卡片同时有 `hidden` 和 `display:flex` 时仍然显示。方法：预览 CSS 固定带一条 `[hidden]{display:none!important}`。
4. **SVG 是替换元素，`position:absolute; inset:0` 不撑满容器**（保持默认 300×150，手绘圈路径被裁）。方法：显式 `width:100%; height:100%`。

另有一条验证方法教训：弹簧动画 settle 后 DOM 状态才更新（如收拢完成才 `remove()`），验证脚本按动画名义时长等待会误判 FAIL；要按 settle 条件留余量或用轮询，别把脚本等待不足当产品 bug。

## 适用条件

- 适用于一切「从扩展/product 代码抽模块做离线 HTML 预览」的工作（首启引导、出错恢复、记忆管理三个原型都踩过并复用了这套解法）。
- 不适用于扩展内开发（扩展构建走 esbuild，不存在 `file://` 限制）。

## 验证

三个原型（`docs/previews/first-run-guide.html`、`error-states.html`、`memory-management.html`）最终 Playwright 全路径通过、无 pageerror；每坑修前可稳定复现、修后消失。

## 来源

- UX 三缺口预览任务（2026-10-06），验收：`docs/evals/20261006-first-run-guide.md`、`docs/evals/20261006-error-states.md`、`docs/evals/20261006-memory-management.md`。
