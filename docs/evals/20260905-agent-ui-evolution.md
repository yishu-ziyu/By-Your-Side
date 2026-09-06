# 任务: 侧栏界面层重构：吸收开源 Agent UI 与交互物理（tool-ui / agent-elements / prompt-kit / Emil / Paco / Rauno）

来源：2026-09-05 用户反馈与设计指导。
1. **开源 Agent UI 仓库参考**：
   - `assistant-ui / tool-ui`：Plan（任务计划）、Progress Tracker（进度追踪）、Approval Card（确认卡）、Terminal/Data Table。
   - `21st-dev / agent-elements`：Edit、Search、Todo、Plan、Clarifying Question、Input Bar 等执行流原语。
   - `Vercel AI Elements`：tool、agent、checkpoint、confirmation、model-selector、reasoning。
   - `prompt-kit`：极度克制适合窄侧栏的 Composer、附件/上下文、Search、Reasoning、Loader。
   - `shadcn Sidebar`：侧栏空间结构（Header / Group / Rail / collapse / scroll）。
2. **5 位顶级设计工程师的设计理念与交互物理**：
   - **Emil Kowalski (@emilkowalski)**：微动效物理、状态变化阻尼过渡、Tab/Toast 连续性、平滑高度变化无弹出感。
   - **Rauno Freiberg (@raunofreiberg)**：Interaction Physics、空间连续性、手势直接操纵、动能物理（Kinetic Physics）。
   - **Paco Coursey (@pacocoursey)**：`cmdk`、Keyboard-first UI、轻量 Popover、快捷操作。
   - **Jordan Singer (@jsngr)**：AI streaming 表达、内容即时直接操作。
   - **Glenn Hitchcock (@glennui)**：AI coding 系统级整洁产品设计。
3. **图标语言**：`reicon.dev` 级高精度统一线框 SVG 图标。
4. **技术约束**：By-Your-Side 侧边栏为 **原生 TS + DOM**（无 React 运行时），必须将上述 Pattern 萃取并纯粹原生化移植，保持轻量高效与零依赖负担。

```
Change:     侧边栏界面层从「简单折叠 + 裸 JSON Chip」跃迁为「有自主交互语言的现代 Browser Agent UI」：
            ① 引入 Todo/Plan Tracker 与语义化 Action Block（明确展示动宾、目标元素、耗时、状态，展开分层而非裸 JSON）；
            ② Composer 吸收 prompt-kit 结构，内嵌当前活跃页面锚点胶囊（Page Context Pill）与快捷动作提示；
            ③ 微交互与动效全面注入 Emil / Rauno 动能物理（无跳变高度折叠、直接操作 scale 反馈、平滑状态 morphing）；
            ④ 图标全量对齐 reicon.dev 级 1.75px 统一几何线框规范。
Not this:   粗暴引入 React/Node 笨重依赖破坏轻量架构；简单加粗加大字号；不给用户选择直接修改生产代码。
Evaluator:  人评三案并排 HTML。机器：资源完备性、无控制台报错、Playwright 自动化交互验证、深浅模式与 reduced-motion 走查。
Evidence:   本卡 + docs/evals/20260905-agent-ui-evolution.html。
```

## 这一步真正要判断的 3 件事

1. **执行流的呈现形态（Execution Stream Architecture）**：
   - **方案 A【语义化动作流 + 任务计划追踪器 · 推荐】（Semantic Action Stream & Progress Tracker · 融合 tool-ui + agent-elements + prompt-kit）**：
     - 顶部内嵌动态 Todo 计划卡（动态勾选进度，用户一秒掌握 Agent 意图与当前阶段）；
     - 每一个步骤呈现为精简高质感语义行（动词 + 目标元素高亮名牌 + 耗时 pill）；
     - 展开为优雅的分层抽屉（目标定位串、操作入参、返回摘要），彻底告别裸露 `<pre>` JSON 杂乱感。
   - **方案 B【超紧凑微型行 + 弹窗检查器】（Compact Micro-Rows & Popover Inspector · 融合 Paco cmdk + Linear）**：
     - 为极致窄屏（<320px）设计，步骤只占一行单线，点击时不占垂直空间展开，而是通过 Paco 式浮层 Popover 检查详细数据。
   - **方案 C【独立模块化卡片组】（Modular Card Deck · 类似 Vercel AI Elements）**：
     - 每个步骤均为全包裹卡片，包含 Header、Code Snippet、Footer 状态区，视觉独立度最高但纵向滚动成本较高。

2. **输入区 Composer 的信息密度与锚点设计（prompt-kit & Paco）**：
   - 输入框顶部集成 **当前页面锚点胶囊（Page Context Pill）**：显示当前活跃标签页 Favicon + 标题 + 域名，支持点击重新同步或解绑；
   - 底部操作栏布局：模型切换胶囊 + 接管/发送键的物理按压动效。

3. **微动效与空间连续性物理（Emil Kowalski & Rauno Freiberg）**：
   - 步骤入场与折叠平滑过渡（Zero-Pop Height Transition）；
   - 按压触感：所有操作按钮拥有 `active: scale(0.96)` 瞬时下沉与弹簧回弹；
   - 状态点从脉动呼吸（pulsing）到落定绿勾的平滑形态收敛。

## 对照过的 Will's S，以及为什么落到这一页

1. **Refactoring UI:《Hierarchy / Size isn’t everything》**
   - 之前的问题是：要突出步骤就只能做大卡片，导致侧栏拥挤。解决方案：通过色彩对比（Subtle Surface-2）、字重（Medium 500）、灰度文本（Text-2 / Text-3）和微型胶囊（Pills）建立 3 级清晰层级，而非靠单纯撑大容器。
2. **Refactoring UI:《Emphasize by de-emphasizing》**
   - 原始工具名（如 `execute_script`, `domops_click`）对用户是干扰噪音，用 `color: var(--text-3); font-size: 11px; font-mono` 弱化沉底；将自然语言意图（如 `在「搜索框」输入 "MiroFish"`）作为视觉核心。
3. **Refactoring UI:《Avoid ambiguous spacing》**
   - 严格落实 4px 网格系统：组件内边距 8px/12px，元素间距 6px/8px，卡片间距 12px/16px，严禁无规则间距导致视觉散乱。
4. **Rauno Freiberg《Invisible Details of Interaction Design》**
   - **Direct Manipulation & Kinetic Feedback**：点击与按压拥有即时位移与阻尼，减少机器执行的冰冷机械感。
   - **Spatial Continuity**：展开与收起计算实际 scrollHeight 平滑过渡，禁止原生 details 无动画瞬间突变。

## 完成标准

- [x] 1. HTML 并排呈现三种界面演化方案（语义动作流+计划追踪【推荐】 / 超紧凑微型行+弹层 / 独立模块化卡片），同一条用户路径（flomo 搜索并归档 MiroFish）贯穿三案 — evaluator: 人评通过
- [x] 2. 真实集成 `tool-ui` 计划追踪器（Progress Tracker）、`agent-elements` 动作表达卡与就地确认卡（Approval Card） — evaluator: 人评通过
- [x] 3. Composer 完整具备 `prompt-kit` 级页面上下文胶囊（Page Context Pill）与 Reicon 级精致图标 — evaluator: 人评通过
- [x] 4. 具有 Emil / Rauno 级按压物理、弹簧过渡与平滑无突变抽屉 — evaluator: 人评通过
- [x] 5. 机器自检：无控制台报错、深色模式 100% 适配、`prefers-reduced-motion` 优雅降级、自动化截图走查全过 — evaluator: 机器全绿
- [x] 6. 用户首肯方向后，已完整落地到生产侧边栏环境 (`extension/src/sidepanel/`) — evaluator: 机器全绿 (`npm run typecheck && npm test && npm run build`)

## 边界与不做

- 不引入外部 React/Vite 庞大构建流，所有模式萃取为最干净的原生 DOM 与 CSS，编译产物保持轻量（257KB）。

## 2026-09-05 用户人评反馈与生产代码落地

- **用户裁决**：确认方案 A（语义动作流 + 计划追踪器），要求对齐苹果 Liquid Glass 与灵动物理动效。
- **生产代码正式重构落地**：
  1. **彻底剥离生硬蓝底**：`extension/src/sidepanel/styles.css` 中 `.msg.user` 改为实体微晶卡片（Solid Surface），无刺眼高饱和色块；
  2. **Liquid Glass 材质**：`topbar` 与 `composer` 享有真实的晨曦微光采样、`backdrop-filter: blur(24px) saturate(190%)`、高光倒角（Specular Rim）与 SVG 光学折射滤镜；
  3. **Dynamic Island 灵动状态胶囊**：顶栏状态胶囊常驻绿色呼吸心跳点，适配浅色与深色高对比度，执行时灵动伸缩；
  4. **悬浮 Dock Composer + 页面感知胶囊**：内嵌活跃标签页 Favicon 与标题，点击在原位液态舒展展开为检查面板（Morphing Sheet）；
  5. **Send / Stop 原位形变按钮**：单一 DOM 按钮承载发送与中止，圆角从 50% 到 9px 弹簧过渡，重心毫厘不移；
  6. **步骤抽屉展开平滑推挤**：测量实际高度，展开具有物理弹簧与阻尼，消灭原生瞬间跳动；
  7. **macOS Alert 危险确认卡**：敏感动作就地拦截，带有触感按压物理。

