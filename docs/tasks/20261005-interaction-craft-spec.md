# RFC: By-Your-Side 交互设计与设计工程落地方案

- **日期**：2026-10-05
- **执行代理**：Codex / Implementer
- **目标原型**：`out/proposals/2026-10-05-scenario-design/index.html`
- **参考规范**：Jakub Krehel (`better-ui`) · Emil Kowalski (`emil-design-eng`) · `preview-redesign.html`
- **状态**：待实现 (Ready for Execution)

---

## 1. 目标与范围 (Objective & Scope)

将 `out/proposals/2026-10-05-scenario-design/index.html` 中验证通过的高保真设计工程与交互规范，实质性合并入 By-Your-Side 扩展核心源码。

### 可见变化 (Observable Changes)
1. **物理按压触感 (Tactile Feedback)**：所有侧栏按钮、Pill 胶囊与操作卡在 `:active` 下具备 `scale(0.96)` 微缩与强力 `ease-out` 回弹，消解漂浮感。
2. **同心圆角精密对齐 (Concentric Radii)**：外部容器与嵌套元素严格满足 $R_{\text{outer}} = R_{\text{inner}} + \text{Padding}$，消除圆角互掐。
3. **入场物理惯性 (No scale(0))**：弹窗、任务小票与浮标进入一律自 `scale(0.95) + opacity: 0` 柔和展开，绝不从虚无中凭空长出。
4. **流式任务卡 (In-Stream `ai-task-card`)**：侧栏执行复杂多步任务（如 flomo 整理、表格抓取）时，以结构化可折叠卡片呈现（站点名牌、完成/待办项、来源依据与「继续原任务」）。
5. **`⌘J` 划词流体送入侧栏**：页面划词小工具条点击「转入侧栏」时，选区平滑填入底栏 `#ask-cite` 引用条，展开追问。

### 显式非目标 (Not This)
- 不破坏现有协议 `shared/protocol.ts` 与后台通信链路。
- 不引入重型外部 CSS 库或 UI 框架（保持轻量原生 DOM + CSS）。
- 不改变当前侧栏宽度（维持 Chrome 原生 380px）与安全沙盒权限。

---

## 2. 影响文件与修改清单 (File Modification Map)

| 文件路径 | 职责范围 | 具体改动项 |
| :--- | :--- | :--- |
| `extension/src/sidepanel/styles.css` | 侧栏全局样式 | 1. 注入 `--e-out: cubic-bezier(0.23, 1, 0.32, 1);`<br>2. 全局添加 `button:active, .pressable:active { transform: scale(0.96) !important; }`<br>3. 同心圆角变量与软层叠阴影 (`--sh-1`, `--sh-2`)<br>4. 整合 `.ai-task-card`、`#ask-cite`、来源芯片样式（移植自 `preview-redesign.html`） |
| `extension/src/sidepanel/main.ts` | 侧栏主逻辑与输入区 | 1. 完善 `#ask-cite` 引用条与输入框同步逻辑<br>2. 任务执行流中渲染 `ai-task-card` 标准 DOM 骨架 |
| `extension/src/sidepanel/task-bar.ts` | 任务状态栏与接续 | 确保多步骤任务进度条支持结构化展开，附带目标站点与继续原任务动作 |
| `extension/src/content/ask-styles.ts` | 页面内 ⌘J 划词悬浮条 | 悬浮条展开动效调整为 `scale(0.95) -> 1`，按压加入 `scale(0.96)` |
| `extension/src/content/ask.ts` | 页面内划词事件中继 | 点击「转入侧栏」时发送 `ASK_SELECTION_TO_PANEL` 消息填充底栏 `#ask-cite` |

---

## 3. 核心设计规范代码参考 (Implementation Details)

### 3.1 全局触感与动效 (Emil & Jakub 准则)
在 `extension/src/sidepanel/styles.css` 中追加或更新：

```css
/* 动效曲线：强力 ease-out 与物理微缩 */
:root {
  --e-out: cubic-bezier(0.23, 1, 0.32, 1);
  --e-spring: cubic-bezier(0.34, 1.4, 0.64, 1);
  --radius-card: 14px;
  --radius-inner: 8px;
  --card-padding: 12px; /* 14px = 8px + 6px (近拟同心) */
}

/* 按钮微按压 */
button:not(:disabled), 
.pressable:not(:disabled),
.source-chip,
.tab-chip {
  transition: transform 140ms var(--e-out), background-color 140ms var(--e-out), border-color 140ms var(--e-out);
}
button:active:not(:disabled),
.pressable:active:not(:disabled) {
  transform: scale(0.96) !important;
}

/* 杜绝 scale(0) */
@keyframes naturalEnter {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
```

### 3.2 官方 AI Elements 流式任务卡 (`.ai-task-card`)
提取自 `preview-redesign.html`，确保具有折叠/展开与接续状态：

```html
<div class="ai-task-card expanded" id="agentTaskCard">
  <div class="ai-task-trigger">
    <div class="trigger-top-row">
      <div class="target-scope"><span class="dot"></span><span>flomo · 浮墨笔记</span></div>
      <div class="trigger-right"><span class="task-status-badge">需接续 (1/3)</span><span class="task-chevron">▼</span></div>
    </div>
    <p class="task-goal-line">任务目标描述文案</p>
  </div>
  <div class="ai-task-content" id="taskContent">
    <div class="task-item done"><span class="task-item-icon">✓</span><span>已完成步骤</span></div>
    <div class="task-item pending"><span class="task-item-icon">○</span><span>待执行步骤</span></div>
  </div>
  <div class="ai-task-footer">
    <div class="task-resume-hint">已保留本轮进度，继续时直接处理剩余项。</div>
    <button class="btn-task-resume" type="button"><span>继续原任务</span> <span>→</span></button>
  </div>
</div>
```

---

## 4. 可证伪验收契约 (Acceptance Contract)

| 检查项 | 验证方式 | 预期客观证据 |
| :--- | :--- | :--- |
| **G1: 按压微缩** | 点击任一侧栏按钮 | 元素呈现 `scale(0.96)`，释放后平滑复原，无残影。 |
| **G2: 划词转入** | 页面划选按 `⌘J` 点转入 | 选区文本出现在侧栏底栏 `#ask-cite`，光标聚焦输入框。 |
| **G3: 任务卡折叠** | 点击任务卡头部 | `.ai-task-content` 抽屉平滑折叠/展开，chevron 旋转 180°。 |
| **G4: 工程类型安全** | 终端运行 `npm run check` | `oxlint` 0 报错，`tsc` 0 类型错误，文档同步检查通过。 |
| **G5: 扩展构建完整** | 终端运行 `npm run build:extension` | 成功输出到 `extension/dist/`，打包耗时正常，文件体积未激增。 |

---

## 5. Codex 执行步骤指导 (Step-by-Step for Codex)

Codex 在拿到本任务后，应严格按以下次序执行，不可跳步：

1. **Step 1 - 注入样式 Tokens**：
   - 修改 `extension/src/sidepanel/styles.css`，补充 `:active { transform: scale(0.96); }`、`--e-out` 曲线及同心圆角变量。
2. **Step 2 - 移植任务卡与引用条样式**：
   - 将 `preview-redesign.html` 中的 `.ai-task-card`、`.source-chip`、`#ask-cite` 高保真样式合并入 `styles.css`，替换老旧无样式的粗糙文本块。
3. **Step 3 - 连通划词转入侧栏动作**：
   - 检查 `extension/src/content/ask.ts` 与 `extension/src/sidepanel/main.ts`，确保选区文字点击「转入侧栏」时能正确唤起并渲染 `#ask-cite` 标签。
4. **Step 4 - 运行完整工程检查**：
   - 执行 `npm run check`，修复可能引入的 CSS/TS lint 问题。
   - 运行 `ego-browser` 检查侧栏与页面交互。
