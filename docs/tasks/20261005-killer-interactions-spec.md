# RFC: By-Your-Side 四大杀手级微交互工程落地方案

- **日期**：2026-10-05
- **执行团队**：Codex / Implementer
- **验收团队**：Antigravity Evaluator
- **目标原型**：[`out/proposals/2026-10-05-scenario-design/index.html`](file:///Users/mahaoxuan/Desktop/AI%20%E4%BA%A7%E5%93%81/By-Your-Side/out/proposals/2026-10-05-scenario-design/index.html)
- **动效母版参考**：Emil Kowalski（`animations.dev`）· Rauno Freiberg（`rauno.me/craft`）· Linear · Better UI
- **状态**：待实现 (Ready for Execution)

---

## 1. 目标与可观察行为 (Objective & Observable Behavior)

将原型中验证通过的 4 个高阶特色微交互实质性并入 By-Your-Side 扩展核心源码，使浏览器伴读体感真正达到顶级物理丝滑度。

### 1.1 场景 06：「按住掀开原文」物理可逆时光机 (Vellum Peel)
- **行为**：在网页原地翻译或重写层上，表层中文以半透明硫酸纸层（Vellum Layer）覆盖。用户鼠标按住（`mousedown`）不放时，表层物理卷起掀开（`transform: translate(36%, -24%) rotate(13deg) scale(0.95)`），露出底层未篡改的原始 DOM；松开（`mouseup`/`mouseleave`）时，通过弹簧物理阻尼（`cubic-bezier(0.34, 1.4, 0.64, 1)`）平滑归位。
- **价值**：零成本消解用户对 AI 乱改网页的信任焦虑。

### 1.2 场景 07：「视差边注」滚到哪批注跟到哪 (Scroll-synced Marginalia)
- **行为**：用户滚动主网页时，内容脚本通过 `IntersectionObserver` 捕捉视口正中央的激活段落（Heading/Section），通知侧栏；侧栏边注卡片顺着垂直导轨无感平滑滑移（`transform: translateY(...)`），并以极细对齐微线锚定视线。
- **价值**：彻底消除左右两眼反复找位置的视觉出戏感。

### 1.3 场景 08：「物理拖拽投喂」所见即所拽 (Direct Drag-to-Feed)
- **行为**：主网页中的表格、卡片或代码块支持直接鼠标拖拽进入侧栏。当拖拽经过侧栏输入框上方时，输入框展开蓝色磁吸虚线槽（Dropzone）；松手释放后，卡片压缩成带有 `✕` 的 Token 引用胶囊（如 `[📊 资产负债表 Q3 ✕]`），提示词输入框自动填入对应结构化提问模板。
- **价值**：跨越“复制-粘贴-手写描述表格”的繁琐输入摩擦力。

### 1.4 场景 09：「声纳波纹定位」数出何处一键反查 (Sonar Pinpoint)
- **行为**：侧栏 AI 输出内容中的关键事实与数字（如 `[✦ 毛利率 62.4% ↗]`）渲染为带微箭头的可点击胶囊。用户点击时，主网页平滑滚动至该数据在源表格或段落中的位置，并触发 1.2 秒的墨蓝声纳脉冲波纹（`@keyframes sonar-wave`），一眼锁死出处。
- **价值**：让 AI 答案的每一个数字 100% 毫秒级溯源，杜绝幻觉怀疑。

---

## 2. 影响文件与修改清单 (File Modification Map)

| 文件路径 | 职责范围 | 具体改动项 |
| :--- | :--- | :--- |
| `shared/protocol.ts` | 扩展内部通信协议 | 增加 `PINPOINT_DOM_TARGET`（反查坐标）、`VIEWPORT_ACTIVE_SECTION`（视口段落同步）、`FEED_DROPPED_ELEMENT`（拖拽投喂）事件定义。 |
| `extension/src/content/page-translation/vellum-layer.ts` | 原地翻译物理覆盖层 | 实现半透明硫酸纸覆盖层 DOM 挂载、`mousedown`/`mouseup` 物理掀开与弹簧复位监听。 |
| `extension/src/content/sonar-pinpoint.ts` | 页面声纳雷达巡航 | 监听 `PINPOINT_DOM_TARGET` 消息，执行 `scrollIntoView({ behavior: 'smooth', block: 'center' })` 并给目标 DOM 添加 `.bys-sonar-active` 脉冲动效。 |
| `extension/src/content/marginalia-tracker.ts` | 视口段落监听器 | 通过 `IntersectionObserver` 节流监测当前屏幕主读段落，发送 `VIEWPORT_ACTIVE_SECTION` 广播。 |
| `extension/src/sidepanel/marginalia.ts` | 侧栏导轨联动 | 监听段落广播，动态计算目标位置，以 `cubic-bezier(0.23, 1, 0.32, 1)` 滑动当前边注卡片。 |
| `extension/src/sidepanel/dropzone.ts` | 侧栏拖拽投喂捕获 | 监听侧栏 `#composer` 的 `dragover`/`dragleave`/`drop` 事件，高亮吸附槽，生成 Token 胶囊并触发提问。 |
| `extension/src/sidepanel/styles.css` | 动效与组件样式 | 补充 `.dropzone-hover`、`.drag-ghost`、`.sonar-pulse`、`@keyframes sonar-wave` 与 `.citation-btn` 样式规则。 |

---

## 3. 核心设计规范代码参考 (Implementation Details)

### 3.1 声纳波纹与引用胶囊 (Rauno 规范)
```css
@keyframes sonar-wave {
  0% { box-shadow: 0 0 0 0 rgba(45, 74, 134, 0.7); }
  60% { box-shadow: 0 0 0 14px rgba(45, 74, 134, 0); }
  100% { box-shadow: 0 0 0 0 rgba(45, 74, 134, 0); }
}

.bys-sonar-active {
  background: #ebf1ff !important;
  border-left: 3px solid #2d4a86 !important;
  animation: sonar-wave 1.2s infinite;
  transition: background 0.3s;
}

.citation-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #f1ede3;
  color: #2d4a86;
  font-weight: 600;
  font-size: 11px;
  cursor: pointer;
  border: 1px solid #dfd9cb;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), background-color 140ms ease;
}
.citation-btn:hover {
  background: #e2dbce;
}
.citation-btn:active {
  transform: scale(0.96) !important;
}
```

### 3.2 硫酸纸掀开层物理弹簧 (Emil 规范)
```css
.vellum-sheet {
  transition: transform 0.32s cubic-bezier(0.34, 1.4, 0.64, 1), box-shadow 0.3s ease;
  transform-origin: top left;
  user-select: none;
  cursor: grab;
}

.vellum-sheet.peeled {
  transform: translate(36%, -24%) rotate(13deg) scale(0.95);
  box-shadow: -12px 18px 30px rgba(0, 0, 0, 0.18);
  cursor: grabbing;
}
```

---

## 4. 可证伪验收契约 (Acceptance Contract)

| 检查项 | 验证方式 | 预期客观证据 |
| :--- | :--- | :--- |
| **G1: 掀开与复位** | 触发翻译后长按译文层 | 表层产生物理旋转偏移，底层露出英文字符；松开后 350ms 内完全弹回复位。 |
| **G2: 导轨跟滚** | 页面向下滚动 300px | 侧栏导轨状态切换为当前段落，边注卡片 `translateY` 顺畅跟随且无跳闪。 |
| **G3: 拖拽吸附** | 将页面表格拖入侧栏输入框 | `#composer` 呈现虚线吸附态，松手后生成带图标的 Token 胶囊，输入框填入提示词。 |
| **G4: 声纳反查** | 点击侧栏任一数字引用胶囊 | 网页平滑滚动至对应表格行，该行亮起墨蓝脉冲波纹（`.bys-sonar-active`）。 |
| **G5: 静态类型与规范** | 终端运行 `npm run check` | `oxlint` 0 报错，`tsc` 0 类型错误，文档同步检查通过。 |

---

## 5. Codex 执行步骤指导 (Step-by-Step for Codex)

1. **Step 1 - 扩展协议事件**：在 `shared/protocol.ts` 声明反查、段落同步与拖拽投喂的数据格式。
2. **Step 2 - 注入动画样式**：在 `extension/src/sidepanel/styles.css` 追加声纳涟漪、投喂吸附槽与引用胶囊样式。
3. **Step 3 - 实现声纳巡航与反查**：在 content script 实现 `sonar-pinpoint.ts` 并与侧栏引用胶囊的点击事件连通。
4. **Step 4 - 实现硫酸纸覆盖层**：在 content 翻译逻辑中挂载 `vellum-layer.ts`，绑定抓取手势。
5. **Step 5 - 实现拖拽投喂与边注**：连通 `dropzone.ts` 与 `marginalia.ts`。
6. **Step 6 - 静态检查与验证**：执行 `npm run check` 确保零错误。
