# 任务: 侧栏不再发黄、对比度更高，AI 做的事在页面和侧栏用同一种墨蓝；小伙伴 M 可以关掉

## 背景

2026-09-25 用户觉得扩展底色太黄，希望在视觉风格和明暗对比上往 Claude 靠，参考了 [facebook/astryx](https://github.com/facebook/astryx) 与 [macapp.supply](https://macapp.supply/)。

核对的来源：
- Anthropic 官方 [brand-guidelines](https://github.com/anthropics/skills/tree/main/skills/brand-guidelines)：浅底 `#faf9f5`、深色 `#141413`、浅灰 `#e8e6dc`、中灰 `#b0aea5`，强调色陶土橙 `#d97757`。claude.ai 登录页实测强调色同为 `#d97757`，底色 `#fcfcfb`。
- 官方 [frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) 把「暖奶油底 + 衬线 + 陶土橙（Claude 自己的交互色）」列为 AI 生成界面最常见的默认样子。所以只对齐明暗与底色，不用陶土橙；学它「只在一处大胆、动效只回应动作」的理念。
- astryx 是 React 组件库，侧栏是纯 TS + CSS，不接入；它的代理状态规范仍是草稿，只借「优先沿用已有状态表达」。

用户在效果图（`out/design-mockups/20260925/A-ink-blue.png`、`B-cinnabar.png`，未入库）里选了墨蓝，并要求紫色光球和 M 原样保留、M 加开关。

## 完成标准

- [x] 1. 浅色侧栏底色、表面、边框、文字换成近中性色：底 `#faf9f5`、凸起面 `#ffffff`、文字 `#141413` — 谁检查: 真侧栏截图（人看）
- [x] 2. AI 的专属色统一为墨蓝 `#2d4a86`：侧栏强调色、页面圈画与名牌、页面边缘光 — 谁检查: 圈画用例的页面截图 + `cast.test.ts`、`overlay.test.ts`
- [x] 3. 紫色光球、M 的颜色和形态不变 — 谁检查: 真侧栏截图
- [x] 4. 「更多 → 显示小伙伴 M」关掉后 M 不占位置，重开侧栏仍关，再点恢复 — 谁检查: `companion-toggle.mts`（读 M 元素的实际渲染面积，不读开关状态）
- [x] 5. 日常请求不受影响 — 谁检查: `everyday-baseline.mts --inproc=stepfun/step-3.7-flash --only=hello,mark,translate`
- [ ] 6. 新配色的观感 — 谁检查: 人（日常 Chrome 重载扩展后）

## 边界与不做

- 深色模式、布局、功能不动；深色模式里的强调色仍是原来的浅棕。
- 其他协作者（名册上的人）的光标颜色不变，只改主助手。
- 深色网页上墨蓝的边缘光较暗，未单独调整。

## 证据

- 颜色测试：`vitest run extension/test/cast.test.ts extension/test/overlay.test.ts` 16/16 通过；两处期望值从 `#2f6fed` 改为 `#2d4a86`，因为它们锁的就是主助手颜色这一设计决定。类型检查通过。
- 开关：`2026-09-25T11-04-47-666Z-companion-toggle` 4/4 通过（默认面积 1296 → 关 0 → 重开 0 → 开 1296）。
- 日常请求：`2026-09-25T11-02-52-427Z-everyday-baseline-inproc` 你好、翻译通过；圈画 1 次失败（只圈了「五小时用量」没带「32%」，模型选目标的波动，与颜色无关），随后单跑 `11-05-09`、`11-05-40` 两次均通过，合计 2/3。截图 `hello-panel.png`、`mark-panel.png`、`mark-page-running-3.png` 显示新底色、墨蓝圈画和名牌、紫色光球与 M 保留。

产物在 `out/acceptance/real-path/`，未入库。
