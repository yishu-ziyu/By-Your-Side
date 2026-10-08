# Agent 确认胶囊：独立交互预览

本目录是 **By-Your-Side 的临时设计实验**，不接入正在使用的浏览器扩展。

目的：验证已有状态胶囊能否在少数需要用户确认的情境中，连续展开为可操作的玻璃面板。此原型以“发送邮件”为例，仅模拟动作，不访问邮箱，也不发请求。

使用 [Glass-HQ/liquid-glass](https://github.com/Glass-HQ/liquid-glass) 的 `GlassScene`、`GlassContent`、`GlassSurface` 和 Base UI Popover。胶囊作为独立玻璃源；弹层 `morphFrom` 它，`morph="become"` 由库直接驱动弹簧、玻璃轮廓和内容显隐。关闭时沿原路径收回；不使用 CSS 宽高补间与提前出现的卡片。真实折射需要 Chromium WebGPU、localhost 或 HTTPS，以及受控背景；WebGPU 缺失时仍保留半透明降级视觉。

这轮动效修订把触发器换成了可用键盘操作的 `GlassButton`，弹层使用原生 `morphFrom`。开启时库需要先准备多张玻璃材质图：2026-10-08 在本机无头 Chrome 测得冷启动首次明显形变约等了 350ms，重复尝试约 160–300ms，仍可能被感知为迟滞。这个测试不构成真人手感通过结论。当前方案不进入正式扩展。

```bash
cd prototypes/agent-glass-confirm
npm install
npm run dev
# 浏览器打开 http://127.0.0.1:5173
```

操作：点击“模拟需要确认”；点击“取消发送”应保留草稿，点击“确认发送”应只改变模拟状态。点击“重新开始”恢复。Esc 相当于取消。底部滑杆可改变折射强度。形变时序由库的物理弹簧控制，不能假称滑杆可调其时长。

运行 `npm run smoke`，会在无头 Chrome 中检查原生玻璃弹层、两种结果、反向收回、快速重新展开、Escape、减少动画和没有发送请求，并把截图保存至 `out/`。

**边界**：现有扩展已移除网页操作的逐步批准卡，不在此原型里修改该策略。正式迁移应复用已有的 edge pill，不再造第二个悬浮入口；确认触发条件需要单独审查，不能直接拿模拟邮件操作当生产策略。
