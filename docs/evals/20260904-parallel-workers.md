# 任务: 通用并行工人底座（Lead + 邮箱 + 绑标签页的子 Agent）

来源：2026-09-04 用户描述。维基百科搜集 + 飞书建文档是**验收场景**，不是产品特判。任何任务只要能拆出「不共享活页面的独立前缀」，都应按同一套底座并行。

对应路线图：`docs/ROADMAP.md`「多任务并行」（光标 `for(id)` 已有，agent 侧多 session 编排待做）。

## 用户必须能看见的变化

一句话任务里，独立站点上的准备工作同时发生：两个彩色光标（或两个工人行）在重叠的时间里分别干活；工人之间传递的是**可搬的工件**（文本 / Markdown / URL / JSON），不是把两个标签页的活状态合并。用户只跟 Lead 说一次话。

不是这个：提示词里写死「维基百科 + 飞书」；也不是同一个 Agent 串行先搜完再开文档。

## 设计（讨论结论，实现按此）

**拓扑：Lead 拥有图，工人走邮箱，不搞自由 P2P 群聊。**

```
用户 ──► Lead（规划会话：spawn / list / stop / post 观察）
              │ 写出 DAG：谁、绑哪类站点、产出什么工件、谁等谁
              ▼
         进程内邮箱（工件：from / to / kind / body）
         ┌────────────┴────────────┐
      Worker B                  Worker C
      自有 Pi session            自有 Pi session
      自有 working tab           自有 working tab
      自有光标颜色               自有光标颜色
      浏览器工具 + post/await    浏览器工具 + post/await
```

- Lead 负责拆解、生成、失败重规划、对用户说话、危险操作升级。它**不**在热路径上当邮差：B 完成搜集后 `post` 给 C，C 的 `await` 直接唤醒，不必再绕一圈 Lead 的 turn。
- 工人**不**自由互聊。通道只有类型化工件。活页面状态不可合并（Scale AI Spine-Branch / Odysseys，2026-08：两台活机器不能 merge，只能沿一条 spine 持有持续状态，branch 交工件后丢弃）。
- 拆解规则写进 Lead prompt，不是分类器：
  - **拆**：独立前缀不共享活页面；交接物是文本/结构化数据。
  - **不拆**：同一页上的连续操作（填完再提交）；短任务；需要用户中途亲手做的步骤。
- 并发上限 v1 = 2 个工人（调色板已有 5 色；速率限制；用户注意力）。工人默认禁止再 spawn。
- 用户只看见一条对话（跟 Lead）。工人活动以彩色执行步骤行出现，光标颜色与之对应。不做三个聊天线程。
- 危险/不可逆动作：工人停下来升级给 Lead/用户，工人之间不得互相放行。

维基+飞书在这套图里：C 是 spine（持有飞书文档这个活状态），B 是 branch（维基搜集，交 Markdown 后结束）。C 可以先把文档建好再 `await`，B 完了直接 `post`。

## 验收标准

- [ ] 1. 硬场景：用户只发一条「打开维基百科搜索人工智能记忆，然后在飞书文档建新文档保存收集到的信息」。墙上钟时间内，维基侧与飞书侧的工作有重叠（飞书文档在维基搜集结束之前已经开始被操作，或反之）；维基搜集到的内容最终出现在飞书文档里。不是先完整串行搜完再开飞书。— evaluator: 人评（真机）+ 面板时间线（两工人的 tool_start 时间戳交叉）
- [ ] 2. 通用性：换一个同构任务（例如「从 GitHub README 摘安装步骤，同时在 Notion/飞书开新页贴进去」）走同一套 spawn/邮箱，代码路径没有站点特判。一条短串行任务（「打开 example.com 告诉我标题」）不 spawn 工人。— evaluator: 人评两条 + 代码审查无 wikipedia/feishu 硬编码
- [x] 3. 协议与执行层：`tool_call` / `agent_event` / `status` 带 `sessionId`；background 按 session 认领 working tab；click/fill/mark 走 `cursor.for(sessionId)`，不再全打到 `"main"`。— evaluator: `protocol.test.ts` 正反例 + 单测
- [x] 4. 邮箱：工人工具 `post` / `await_message`（按 from/kind 匹配，await 阻塞直到工件到达或超时）。工件走邮箱热路径，不经 Lead turn 转发正文；面板上该工人行的 post/await chip 可见。— evaluator: agent 单测（先到/后到/超时/空 to）
- [ ] 5. 面板：用户仍是一条对话；并行时执行区出现按工人着色的步骤行（或 chip 组），abort 能停掉整个图。— evaluator: 无头截图双工人行 + 人评
- [x] 6. 回归：单工人路径（不 spawn）行为与现在一致，光标仍是蓝色 SideAgent。typecheck / build / 全部测试绿。— evaluator: `npm run typecheck && npm run build && npm test`（2026-09-04：143 tests / typecheck / build 全绿）

## 边界与不做（v1）

- 不做自由 P2P 群聊、不做工人递归 spawn、不做三个并列聊天线程
- 不做强制双窗口并排（两标签页即可；用户切过去才看见该页光标）
- 不做跨 origin iframe 的新工作、不做轨迹回放、不做技能录制
- 不把 chrome.debugger 的 `activateTab` 抢焦点问题一次做完美（v1 允许后台标签继续 CDP；截图优先 CDP `Page.captureScreenshot`，避免 `captureVisibleTab` 只能拍前台）
- 不引入 pi-subagents / pi-intercom 插件（`noExtensions: true` 保持；我们只要同等原语：spawn + 1:1 工件，但工人拿的是浏览器工具）
