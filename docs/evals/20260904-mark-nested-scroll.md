# 任务: 内部滚动时 mark 圈画钉住目标，不再漂移

来源：2026-09-04 人评。flomo「全部笔记」列表里圈住「第一条非置顶笔记」后，鼠标拖动列表，框/箭头/名牌停在视口原处，笔记从框底下溜走。

上一张卡 `20260903-mark-tool.md` 写「absolute 文档坐标天然跟随，不做滚动重算」。那只对 **window 滚动**成立。flomo 笔记列表是内部 `overflow:auto` 容器，`window.scrollY` 一直是 0，文档坐标不会动。resize 重锚已做，scroll 没听。

```
Change:     页面上的 mark（描边框 + 左箭头 + 名牌）钉在被标的元素上。用户拖动/滚动页面——包括内部滚动容器——框跟着目标走，不在视口里原地漂。
Not this:   只修了浏览器窗口滚动；只修了侧栏开关导致的 resize；滚动时把圈藏起来；让 Agent 不要画圈。
Evaluator:  无头 Chrome：内部 overflow 容器 scrollTop 变化后，mark 视口盒与目标包围盒（外扩 pad）四边误差 ≤2px。typecheck / test / build。人评：flomo 笔记列表拖动。
Evidence:   `node extension/test/overlay-check.mjs` PASS + 滚动前后截图；本卡。
```

## 完成标准

- [x] 1. 内部滚动容器（`overflow:auto`，window.scroll 不变）滚动后，mark 仍箍住锚定元素，位移等于内容位移，误差 ≤2px — evaluator: `node extension/test/overlay-check.mjs`（2026-09-04：nested-scroll dy=90，markOff 四边 0）
- [x] 2. window 级滚动不回归：文档坐标在 window.scroll 后保持（absolute 天然跟随，或重算后与 `rect + scroll` 一致）— evaluator: 同上脚本（docY 74 → 74，箍住误差 0）
- [x] 3. 滚动时不收起光标、不拆掉瞬时高亮（那是 resize 的行为）— evaluator: 代码审查（`onScroll` 只调 `relayoutMarks`；`onViewportResize` 才 hide 光标/拆高亮）
- [x] 4. `npm run typecheck` / `npm test` / `npm run build` 全绿 — evaluator: 机器（2026-09-04：178 tests）
- [x] 5. `npm run reload:ext` 后真机：flomo 笔记列表拖动，圈跟着那条笔记走 — evaluator: 人评（2026-09-04：轻拖「基本上 ok」；压力测试：多圈 + 长列表翻找 + 用户从顶拖到底）

## 边界与不做

- 不做虚拟列表回收后的重新识别（元素从 DOM 卸掉后圈先藏起；selector/ref 还能解析到再贴回去）
- 不改 mark 外观
- 不实现就地确认（另一张卡）
- 不用 transform 模拟滚动的自定义滚动条（未见；真遇到再开卡）
