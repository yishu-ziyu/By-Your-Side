# 任务: 选中即问 —— 划一段字，带着这段去问 Agent

来源：路线图「选中即问」。2026-09-05 用户指出上一版例子太一般，要求对照 Sider（本人是用户）。Sider 官方《上下文菜单》：划词出阅读菜单；输入框里划自己的字出写作菜单；⌘/Ctrl+J 问 AI；答案生成在选区旁边，追问才「在侧栏继续对话」。

```
Change:     用户在正在读的网页上划一段难句，能就地得到解释或自己提问；要追问才把这段带进侧栏。不是整页空问，也不是词典查词。
Not this:   维基划个词问「这是什么」；做成 Sider 翻译/改写全家桶；本轮改生产代码。
Evaluator:  人评 HTML。机器：本页无控制台报错。
Evidence:   本卡 + docs/evals/20260905-select-and-ask.html
```

## 这一步真正要判断的 3 件事

1. **答案先出现在哪。** 贴在选区旁边（Sider），还是直接跳进侧栏等你打字。
2. **浮层带几件事。** 问 + 解释就够，还是连翻译、改写、语法一起上。
3. **写作菜单做不做。** 输入框里划自己的字，Sider 会改写。SideAgent 第一刀要不要碰。

同一条路径：Nature 方法段划「contamination fraction exceeded 0.18」，点解释，再在侧栏继续。

## 对照过的 Will's S，以及为什么落到这一页

1. **Apple《Context menus》**  
   上下文菜单默认隐藏，只放当前最相关的一两项；同一动作在主界面也要能做。iOS 明确写：同一对象不要同时出上下文菜单和编辑菜单。所以两入口必须是**同一件事**，不能一粒「问」再加一排「解释/翻译」。
2. **Apple《Edit menus》**  
   划词后的条是编辑菜单传统（复制、查找）。自定义命令要少，贴在系统命令旁边，不要另造一套控件做同一件事。
3. **NNGroup《Designing Effective Contextual Menus》**  
   上下文菜单适合次要动作；要贴着被作用的内容；过小过淡会找不到。选中即问对 SideAgent 是新能力，纯藏在右键里发现成本高，所以推荐项保留一粒贴着选区的「问」。
4. **Refactoring UI《Emphasize by de-emphasizing》+《Labels are a last resort》**  
   网页正文是主角。浮层一个字「问」，不要「问 SideAgent 关于这段选中文字」。侧栏里引用胶囊自己就是选区，不必再贴「选中：」标签。
5. **Apple《渐进式揭示》**  
   不要一次摊开解释/翻译/总结。Sider 把这些都放进阅读菜单，因为 Sider 就是阅读/写作产品。SideAgent 不是：第一刀只留「解释」和「问」。
6. **Sider 原件（用户点名）**  
   好用的不是按钮数量，而是：不离开正在读的那段；「问」是输入框不是默发；追问才进侧栏。写作菜单、翻译、改写不抄。

## 完成标准

- [x] 1. HTML 三案 + Sider 原件（人选 A） — evaluator: 人评
- [x] 2. 用例改为论文 / CI / 归档前 / 条款 — evaluator: 人评
- [x] 3. 方案 A 落地：选区旁「问 / 解释」，答案贴在旁边，「在侧栏继续」才进 composer — evaluator: 机器

## 2026-09-05 生产落地（人选 A）

```
Change:     网页划一段正文，选区旁出现「问 / 解释」；解释的答案贴在旁边；问是输入框；「在侧栏继续」把选区带进 composer。
Not this:   翻译改写全家桶；划完立刻跳侧栏空等；解释时去点页面。
Evaluator:  机器：typecheck / test / build。人评：论文段解释、继续进侧栏。
```

- [ ] 真机：Nature 方法句解释、在侧栏继续追问 — evaluator: 人

## 边界与不做（第一刀，写进 HTML 给人选）

做：

- 普通 http(s) 网页里，用户划出来的**可见文本**（2–2000 字，超出截断并标明）
- 两个入口做同一件事：选区旁「问」、系统右键「问 SideAgent」
- 打开侧栏；composer 出现引用胶囊（选区摘要 + 当前页 host）；输入框空着等用户打问题
- 发送时带上已有 `PageContext`（tabId/title/url）**再加上**选区文本
- Agent 正在跑：当作插话（steer），不另开会话

不做：

- 图片 / 视频 / 纯链接（没有划到字）
- 输入框、textarea、contenteditable 里的字（你在写，不是在读）
- `chrome://`、扩展页、PDF 阅读器里的浮层（右键若 Chrome 给得出 `selectionText` 可以走菜单，浮层不做）
- 跨域 iframe 里的浮层（菜单仍可能可用）
- 自动发送「解释这段」；做成翻译插件
- 替换浏览器自带的复制 / 搜索
- 本轮改生产代码

## 实现路径（点头后才写代码）

1. `manifest.json` 加 `contextMenus`。已有 `scripting` / `tabs` / `sidePanel` / `storage` / `<all_urls>`。
2. `chrome.runtime.onInstalled` 里 `contextMenus.create({ contexts: ["selection"], title: "问 SideAgent" })`。
3. 点击菜单：`chrome.storage.session` 写下 `{ text, tabId, title, url }`，再 `sidePanel.open({ tabId })`。侧栏若还没起来，用 session 存储交接，避免消息打到空端口（Chrome 已知坑）。
4. 浮层：很小的 content script，监听 `mouseup` / `selectionchange`，用 `Range.getBoundingClientRect()` 贴在选区上方。点「问」走同一份 session 记录。
5. 协议：`PageContext` 已有 tabId/title/url。加可选 `selection?: { text: string }`，缺省则行为与现在完全一样。
6. 侧栏 composer 多一粒可关掉的引用胶囊，发送时带上；关掉即当普通消息。

## 用例（第一刀必须能走）

1. **读论文**　Nature 方法段划一句门槛条件，点解释。答案贴在旁边。再「在侧栏继续」问跟自己实验的关系。
2. **看 CI 红了**　GitHub Actions 划 error log，问 AI「这是什么错」。SideAgent 可以接着去翻文件。
3. **危险操作前**　ChatGPT 设置划「Archive this chat」，问「点了会怎样」——接到就地确认。
4. **读条款**　结账页划 non-refundable 句，问现在取消能不能退。

不做、留给 Sider：Gmail 草稿改写、整页翻译、PDF 对照翻译。
