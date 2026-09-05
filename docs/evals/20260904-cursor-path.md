# 任务: 光标轨迹先抄世界上最好的，再按我们的业务改

来源：2026-09-04。存在感 HTML 之后：轨迹和原理不要自编，先找开源和 X 上谁做得最好。

```
Change:     要点时沿浅弧飞到目标再点；不点就停在角落，不再 3 秒隐掉。
Not this:   直线；随机过冲拖尾；只把箭头放大。
Evaluator:  人评已点浅弧（2026-09-04 截图）。机器：cursor-path 单测 + typecheck / test / build。
Evidence:   本卡 + extension/src/shared/cursor-path.ts + cursor.ts / input.ts
```

## 这一屏要判断的事

1. 直线（GitHub Copilot Browser / tldraw 自主移动）够不够「它去点这个」。
2. 浅弧（ghost-cursor / CursorBuddy 去掉随机）是不是更像手，又不过分。
3. 全套拟人（随机三次贝塞尔 + 过冲 + 拖尾）是不是花了。

## 世界上谁做得最好，以及为什么不全抄

分三摊，问题不一样。

### 1. 给人看的 Agent 光标（我们的问题）

人在自己的页面上看「它在点哪」。终点已知。

| 谁 | 做法 | 和我们 |
| --- | --- | --- |
| GitHub Copilot Browser `virtual-cursor.ts` | 已知终点，`requestAnimationFrame` + cubic easing 飞过去，点击扩圈 24→40px / 300ms | 同一类产品：侧栏 Agent 操作当前页 |
| ChatGPT Agent / Atlas | 移动 + 点击波纹；Agent 事件不走特权层 | 波纹我们已经有 |
| cdpilot | 假光标 + 波纹本是信任信号；后来默认关掉，因为「动画占帧、像外行在开车」。MCP 会话仍开着——人看着才需要 | 我们是人看着的会话，要开；但必须短 |
| atrium | Agent cursor 可关，chrome 调暗 | 待命要淡，印证上一页 |

### 2. 协作光标插值（看起来像，问题不同）

| 谁 | 做法 | 为什么不全抄 |
| --- | --- | --- |
| tldraw `perfect-cursors`（Steve Ruiz） | 远端 80ms 来一个点，样条插值；tween 改终点会「每次重开」，弹簧能保留动量 | 我们不是稀疏网络点。点击坐标一次就有。能用的是：新动作取消旧动画；自主移动用 easeInOut |
| Liveblocks 文 *How to animate multiplayer cursors* | CSS / 弹簧 / 样条三选。CSS 对远程光标用 linear 比 easing 更稳 | 远程才需要 linear。已知 A→B 该用 easing |
| tldraw Animation 文档 | easeOut = 回应用户；easeInOut = 自主移动（镜头） | Agent 去点按钮 = 自主，用 easeInOutCubic |

Steve Ruiz 2021-06-30：tween 中途改终点会像从头播；弹簧保留速度。我们角落→按钮→角落，下一次点击可能打断这一次，取消并重定向即可（tldraw 同款）。

### 3. 「拟人鼠标」生成（问题是躲检测，不是给我们看）

| 谁 | 做法 | 为什么不全抄 |
| --- | --- | --- |
| ghost-cursor（MIT，用得最广） | 三次贝塞尔，控制点在线段一侧随机；Fitts 定律定步数；远距离过冲再修正；落点不在正中 | Fitts 和「一侧弧」有用。随机、过冲、不正中是为了像人躲机器 |
| WindMouse（Ben Land, GPL） | 重力拉向终点 + 随机风力。本为游戏脚本 | 看起来在飘。Apple Motion 禁持续无目的运动 |
| agentcursor | 可见光标 + Fitts + 过冲 + 高斯抖动 + 非中心落点。README 写明是为 DataDome / reCAPTCHA | 可见这层要。抖动和过冲不要：人看着像没点准 |
| AgentBrowser | 贝塞尔 + jitter + 可选过冲 + 14 点拖尾 + 波纹 | 拖尾是注意力劫持（NNGroup）。cdpilot 同类东西后来关了 |
| X @Raedchen_ 2026-08-28 | Bézier + Fitts 输出早被检测文献当签名 | 躲检测这条路对我们无意义，还抄成花活 |

Fitts 定律（1954，HCI，不是 bot 圈发明）：`T = a + b · log2(D/W + 1)`。ghost-cursor 源码：`a=0, b=2` 用来算步数。我们拿来算**时长**，并卡在 220–480ms（Apple：少等人等动画；cdpilot：占帧像外行）。

## 按我们业务改过的版本

SideAgent：人看着自己的页，要信任「它去点了这个」，不要假装是用户的手，不要装饰。

采用：

1. **Fitts 时长**（ghost-cursor / agentcursor / HCI）
2. **easeInOutCubic**（tldraw 给自主移动；Copilot Browser cubic）
3. **二选一几何**：直线，或一侧浅弧（ghost-cursor「只取一侧」+ CursorBuddy 飞弧，去掉随机，spread = clamp(12%·D, 8, 36)）
4. **新动作取消旧动画**（tldraw）
5. **点击波纹**（已有，ChatGPT Agent / Copilot）

不采用：随机控制点、过冲、高斯抖动、拖尾、WindMouse 风、落点乱点。

待命停角落仍是上一页的 Live Activity 规则，这一页不重判左右。

## 完成标准

- [x] 1. 用户指出直线、浅弧、或否掉两者 — evaluator: 人评（2026-09-04：浅弧）
- [x] 2. 三列轨迹肉眼可辨（飞的时候留下淡线） — evaluator: 打开即能看完一个来回
- [ ] 3. 产品：浅弧 + Fitts + 角落待命，无 3 秒隐掉 — evaluator: 机器已绿（196 tests + overlay-check + reload `fnbjglhppbkgmjeehablkfilmmefjolo`）；人评真机待过

## 边界与不做

- 不落地产品
- 不引入 ghost-cursor / windmouse 依赖
- 不把 perfect-cursors 接到点击上（问题不对）
