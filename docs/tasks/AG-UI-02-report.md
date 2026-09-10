# AG-UI-02-report.md — 窄侧栏底栏操作按钮与模型名完整适配（Anti Gravity 侧）

## 协调标记
- **READY**（2026-09-09）。按协议由 Boss 独立进行生产 DOM/CSS 几何与点击验收，真人视觉由用户裁决。

## 改动（仅归属文件）
1. `extension/src/sidepanel/styles.css`
   - `#model-btn`：增加 `min-width: 0; flex-shrink: 1;`，解除 flex item 默认的 `min-width: auto` 约束，允许长模型芯片在窄侧栏中平滑收缩；
   - `#model-name`：增加 `min-width: 0; flex: 0 1 auto;`，让已有 `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` 真正生效，超长模型名称以省略号自适应收缩；
   - `#composer-bar`：增加 `min-width: 0;`；
   - `#composer-spacer`：调整为 `flex: 1 1 0; min-width: 0;`，空间充裕时撑开间距，空间紧张时优先折叠归零；
   - `@media (max-width: 360px)`：在已有的窄视口媒体查询中补充微调：
     - `#composer-bar { gap: 4px; }`
     - `#model-btn { gap: 4px; padding: 0 8px 0 6px; }`
     - `#takeover-btn { padding: 0 8px; }`
     保证在 320px 极限宽度且同时出现“长模型名 + 思考标签 + 语音按钮 + 接管按钮 + 停止按钮”的最紧凑场景下，所有操作按钮均完整保留其触达尺寸与间距，`#model-btn` 也能保留 124px 并展示省略文字、图标与标签，杜绝挤出视口。

## 聚焦自测
- 编写 Playwright 自动化矩阵测试脚本（`scratch/test-composer-fit.mjs`），覆盖：
  - 5 个视口宽度：320, 360, 400, 440, 520 CSS px
  - 4 种运行/语音状态：idle_voice_on, running_voice_on, idle_voice_off, running_voice_off
  - 4 组长短模型名与标签组合：
    - `anthropic/claude-3-7-sonnet-thought` + `思考 64k`（tag-slider）
    - `google/gemini-2.5-pro-preview-05-01-thinking-high-effort` + `深度思考`（tag-native）
    - `gpt-4o` + `直接回答`（tag-direct）
    - `meta-llama/llama-3.3-70b-instruct` + 无标签
  - 共计 80 组几何与交互用例。
- 几何与交互验收标准：
  - `document.documentElement.scrollWidth <= clientWidth + 1px`
  - 所有可见按钮右边界 `button.right <= composer.right + 1px` 且 `button.right <= innerWidth + 1px`
  - 相邻按钮间无重叠（subpixel overlap = 0）
  - 全部可见按钮支持真实点击事件并顺利触发
- 结果：
  - 未修改前：11 项严重溢出（在 320/360/400/440 视口下溢出 40~97px）
  - 修改后：80 项全部 **PASS**（0 failure）
- 未跑全量测试/typecheck/build/commit/push，未访问用户浏览器。

## 观察与提示（关于 Boss 验收脚本 `scripts/acceptance/composer-fit-run.mts`）
- 在本地核对 Boss 独立验收脚本时发现：`scripts/acceptance/composer-fit-run.mts` 第 43 行在 `for` 循环体内执行了 CDP `Runtime.evaluate`：
  ```js
  const tag=document.querySelector('#model-reasoning-tag');
  ```
  由于处于同一个 Page 全局作用域，第 2 次循环迭代会报 `SyntaxError: Identifier 'tag' has already been declared`。
  严格遵循“不修改 Boss 测试/验收脚本”约定，执行者未修改该文件。Boss 在自测或验收时若遇到此语法报错，可将循环内的 `const tag` 改为局部块级作用域 `{ const tag = ... }` 或 `var tag`。

## 状态
已停笔。
