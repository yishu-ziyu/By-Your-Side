# RFC: By-Your-Side 极速直连动作舵与空中变轨微指令落地方案

- **日期**：2026-10-05
- **执行团队**：Codex / Implementer
- **验收团队**：Antigravity Evaluator
- **目标原型**：[`out/proposals/2026-10-05-scenario-design/index.html`](file:///Users/mahaoxuan/Desktop/AI%20%E4%BA%A7%E5%93%81/By-Your-Side/out/proposals/2026-10-05-scenario-design/index.html)（S10 与 S11）
- **参考规范**：macOS 系统级 HUD 动效 · Raycast 0 延迟原生扩展 · Cursor 内联变轨
- **状态**：待实现 (Ready for Execution)

---

## 1. 目标与可观察行为 (Objective & Observable Behavior)

将原型验证通过的 **「0ms 幽灵动作舵（Ghost Quick-HUD）」** 与 **「空中变轨微指令（In-flight Steering）」** 正式并入 By-Your-Side 扩展核心，彻底解决“简单指令比人手点还慢”与“长输出走偏只能暴躁按停止”的生产痛点。

### 1.1 场景 10：「0ms 幽灵动作舵」无需推理极速直连 (Ghost Quick-HUD)
- **行为**：
  1. 侧栏顶栏侦测到特定页面类型（YouTube、Bilibili、GitHub、长技术文档）时，浮出轻量快捷动作栏（`⏯ 暂停`、`⏭ 下一首`、`⇲ 折叠代码`）；
  2. 点击该按键时，**完全不经过大模型推理与网络等待**，直接向活动标签页 Content Script 发送直连指令；
  3. Content Script 接收指令后 30ms 内操作对应媒体/DOM 节点，并在网页正中心浮起一道 macOS 质感的毛玻璃 HUD 胶囊（`[ ⏭ 已切至下一首 ]`），800ms 后平滑淡出；
  4. 侧栏顶栏状态即时记录 `28ms · DOM 直连完成 (免大模型)`。
- **价值**：将高频确定性操作耗时从 30 秒暴降至 30 毫秒，避免用重量级 Agent 大炮打蚊子。

### 1.2 场景 11：「空中变轨微指令」长文输出中途随手微调 (In-flight Steering)
- **行为**：
  1. 模型在侧栏进行流式文本生成时，底栏输入框不被置灰禁用，而是变换为微光「空中微调槽（In-flight Steering Ribbon）」，提供快捷变轨微芯片（如 `✦ 改成对比表格`、`✦ 浓缩为3句话`）；
  2. 用户点击芯片或输入一句补充修正并回车时，**任务不抛出红色中断错误，不丢失已有上下文**；
  3. 任务卡片顶端点亮金色变轨徽章（`⚡ 已空中变轨：对比表`），正在流式输出的文本原地重塑（Hot-morphing）为结构清晰的 Markdown 对比表或摘要。
- **价值**：消除多步生成一旦走偏只能强行截断重来的巨大沉没成本。

---

## 2. 影响文件与修改清单 (File Modification Map)

| 文件路径 | 职责范围 | 具体改动项 |
| :--- | :--- | :--- |
| `shared/protocol.ts` | 协议定义 | 增加 `GHOST_QUICK_ACTION`（直连动作派发）与 `STEER_INFLIGHT_TASK`（空中微调指令）事件类型。 |
| `extension/src/content/ghost-hud.ts` | 页面 HUD 呈现与 DOM 直连 | 实现原生视频播放器/代码块控制（`video.play()`, `video.pause()`, 快捷键模拟）与中心毛玻璃 HUD 动画容器。 |
| `extension/src/sidepanel/ghost-bar.ts` | 侧栏直连动作栏 | 监听当前活动标签页 URL 特征，动态渲染顶栏直连按键；点击即刻触发背景派发。 |
| `extension/src/sidepanel/in-flight-steer.ts` | 空中变轨中继 | 在流式输出状态下激活输入框变轨模式，支持点击变轨芯片向运行中 Session 插入微调指令。 |
| `extension/src/sidepanel/styles.css` | 动效与组件样式 | 增加 `@keyframes hud-in-out`、`.hud-bloom`、`.steering-active`、`.steer-tag` 样式规则。 |

---

## 3. 核心设计规范代码参考 (Implementation Details)

### 3.1 页面中央毛玻璃 HUD 动效 (macOS 质感)
```css
@keyframes hud-in-out {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
  20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  75% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
}

.bys-hud-capsule {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  background: rgba(20, 20, 19, 0.88);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #ffffff;
  border-radius: 99px;
  padding: 10px 22px;
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  z-index: 2147483647;
  animation: hud-in-out 1.2s cubic-bezier(0.23, 1, 0.32, 1) forwards;
}
```

### 3.2 变轨微调指令注入逻辑
```typescript
export function steerInFlight(activeSessionId: string, steerPrompt: string): void {
  chrome.runtime.sendMessage({
    type: 'STEER_INFLIGHT_TASK',
    sessionId: activeSessionId,
    steerInstruction: steerPrompt,
  });
}
```

---

## 4. 可证伪验收契约 (Acceptance Contract)

| 检查项 | 验证方式 | 预期客观证据 |
| :--- | :--- | :--- |
| **G1: 直连执行时效** | 媒体页点击侧栏直连按键 | 从点击到 DOM 动作完成耗时 $\le 50\text{ms}$，**且检查后台模型请求日志为 0 次**。 |
| **G2: HUD 浮现与淡出** | 触发直连切歌或暂停 | 页面正中浮现毛玻璃 HUD 胶囊，1.2s 内优雅淡出清理，无残存 DOM。 |
| **G3: 流式变轨接纳** | 文本生成中点击变轨芯片 | 正在生成的文本块原地重塑，卡片点亮金色变轨徽章，不触发中断报错。 |
| **G4: 会话状态连续性** | 变轨完成后检查会话 | 该轮问答保留为单次对话闭环，历史记录中记录变轨痕迹，无分裂会话。 |
| **G5: 静态与文档门禁** | 运行全量工程检查 | `npm run check` 零错误通过，`check:docs` 零警告通过。 |

---

## 5. Codex 执行步骤指导 (Step-by-Step for Codex)

1. **Step 1 - 协议扩充**：在 `shared/protocol.ts` 增加 `GHOST_QUICK_ACTION` 与 `STEER_INFLIGHT_TASK` 数据包类型；
2. **Step 2 - 页面 HUD 与动作执行**：在 `extension/src/content/ghost-hud.ts` 实现媒体节点（`HTMLMediaElement`）的直接控制与 HUD 动画挂载；
3. **Step 3 - 侧栏动作栏与直连派发**：在 `extension/src/sidepanel/ghost-bar.ts` 完成 URL 特征感知与直连按键渲染；
4. **Step 4 - 空中变轨逻辑连通**：在侧栏输入区与任务流接入 `in-flight-steer.ts`，支持生成中微调注入；
5. **Step 5 - 静态检查与验证**：执行 `VITEST_MAX_WORKERS=1 npm run check` 确保 0 报错通过。
