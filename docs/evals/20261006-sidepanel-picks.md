# 任务: 侧栏落地选定版——顶栏 B、chip C、过程行 A、记忆展开 A

来源：[#58 交接评论](https://github.com/yishu-ziyu/By-Your-Side/issues/58#issuecomment-6011562876)，原型见草稿 PR #60。用户 2026-10-06 在高保真原型里选定四项；交接单留下 5 个问题由 Claude 决定。

## 规则
- R1 顶栏：任务名 + 新会话、记忆两枚灰图标 + ⋯。⋯ 菜单里不再有「记忆」。
  - 例子(正)：顶栏右侧依次是铅笔、记忆、⋯，点记忆图标打开记忆抽屉 — 谁检查：`memory-used-line.mts`（R3 经顶栏打开记忆面板）+ 截图
- R2 chip C：每条用户消息下面右对齐一排描边 chip，写这一轮带给助手的页面（网站真图标 + 标题）和选段。只读，不给「×」。重新载入侧栏后仍在。
  - 例子(正)：在「订票」页问话，气泡下出现「🌐 订票」 — 谁检查：`answer-receipt.mts`
  - 例子(反)：过程行收尾后挪到 chip 前面，chip 掉到过程行下面 — 谁检查：`process-line.mts`（DOM 顺序 msg → ctx-chips → run-steps）
- R3 过程行 A：一行灰字，不放图标；进行中可点开；做完收成「做了 N 件事」。展开为弹簧（stiffness 420 / damping 34），收起 180ms。
  - 例子(正)：「做了 3 件事 ⌄」下一步一行 — 谁检查：`process-line.mts`
- R4 记忆 D + X1：「用了 N 条记忆 ›」接在首句末尾，点开在首段下面弹簧撑开小条（14px 图标 + 12px 灰字）。「来源」面板只放网页。复制回答不带这行灰字。
  - 例子(正)：首句后灰字，展开三条，每条悬停有「忘掉」「这里别用」 — 谁检查：`memory-used-line.mts`
- R5 系统「减少动效」打开时，灰字淡入、记忆小条、过程展开都直接出现。
  - 例子(反)：减少动效下过程展开仍走 0.39s — 谁检查：`reduced-motion.mts`
- R6 观感是否达到原型截图的水准 — 谁检查：人

## 还没答上的问题
- 无。交接单 5 问的决定见下节。

## 交接单 5 问的决定
1. 记忆只留一处：句尾灰字 + 首段下小条（用户选的 A 是这种形态的动效）。59a0905 收进「来源」面板的做法撤回。
2. ⋯ 菜单保留原生 popover。功能相同，不加 Floating UI。
3. 弹簧不装 motion：把弹簧方程采样成 CSS `linear()` 曲线，挂在原有 `::details-content` 网格过渡上。手感参数与原型一致，零新依赖。
4. 记忆图标用 Database（main 菜单原用），不用 Brain：Brain 已是「思考」步骤的图标。
5. 输入框上方的页面条（`#page-pill`）隐藏：选定版截图里没有它，「这一轮带了哪页」改由 chip 说明。它打开的「标签页检查器」是调试用，入口一并隐藏。

## 技术前提
- 前提：`linear()` 采样的弹簧能用在 `grid-template-rows` 过渡上；打开、收起各取目标状态上的 transition。小实验：`scripts/probes/shell/reduced-motion.mts` 读计算样式（0.39s / 0.42s）。结果：通过
- 前提：后台在查完活动标签页后把页面写回那条用户历史，侧栏按 seq 补画。结果：通过（重载后 chip 仍在）

## 边界与不做
- chip 不可删除：消息已发出，删 chip 改变不了已带的内容。
- 原型里的「···」「继续」、lucide 链接图标以 main 为准，不照抄。
- 「去发送」（只圈出发送键）和诊断折叠不在本次范围。

## 证据
- `memory-used-line.mts` 16/16（脚本改回句尾形态；展开后等 600ms 再点按钮，首跑时点在弹簧动画中途，R4 两项失败）。截图 `out/acceptance/memory-used-line/R2-expanded.png`。
- `answer-receipt.mts` 全过（新增 chip 当场与重载两项；「正文不夹记忆」一项按本次决定改写）。截图 `out/probes/shell/receipt-open.png`。
- `process-line.mts` 全过；截图 `out/probes/shell/process-ok-open.png`。首跑发现 chip 被过程行挤到后面，已修。
- `reduced-motion.mts` 2/2；首跑发现减少动效下过程展开仍有 0.39s，已修。
- `npm run check`：文档、模块边界、类型通过；测试 2409/2412，3 个 agent 测试（main-effort-session、cap02a-events、browser-program-binding）全量时超时，独占复跑 13/13 通过，本次未改 agent；构建通过。
- 10-06 补跑（`answer-receipt.mts` 全过）：划词提问那一轮出现第二枚选段 chip；键盘 Tab 到记忆、Enter 打开、Esc 关上并回到图标，Enter 展开和收起过程行；暗色下 chip、过程行、顶栏图标对比度 6.1–7.9（下限 3）。截图 `out/probes/shell/receipt-dark.png`。首跑把 oklch 颜色当 rgb 读，数字不可信，改用画布换算后重跑。
