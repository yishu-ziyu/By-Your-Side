# 任务: 补上第一、二档里两个模型都栽的产品缺口——截图给不到你、长名字读不全、时间框不知道范围

[当前状态](../STATUS.md) · [评测复核](../../eval/runs/tiers12-20261002/review-decisions.json)（本地评测产物）

## 起因（10-02 评测 tiers12-20261002，复核结论经用户同意）

训练集第一、二档 62 题 × 2 配置：M3.1 一档 81% / 二档 84%，GLM-5.3-flash 一档 77% / 二档 77%。15 条「不能接受」里 10 条是产品问题，两个模型都失败：

- BYS-049「把这页截个图给我」：截图工具截了，侧栏只显示文字「这是当前页面的截图」，图片没给到用户。
- BYS-060「最后一个笔记本的名字和价格」：页面把长商品名截断显示（完整名在属性里），读页工具只给截断文字，两个模型都答不出完整型号 GL702VM-GC146T。
- BYS-072「配送时间填最早能送的」/ BYS-073「填晚上 9 点半」：读数里没有时间框的 min/max，填了 00:00 与 21:30（页面允许 11:00–21:00），也没提醒（GitHub #27）。

## 完成标准

- [x] 1. 用户要截图时，截图以图片出现在侧栏回答里，可点开看大图、可下载 — 谁检查: 机器，真侧栏 + 脚本模型
- [x] 2. 读页时，被截断显示的文字（省略号、CSS 截断）同时给出完整文字（来自 title、aria-label 等页面自带的完整值）；BYS-060 那类页面能读到完整型号 — 谁检查: 机器，真页面 fixture 与 webscraper 测试站
- [x] 3. 时间/日期/数字输入框的读数带上允许范围（min、max、step）；填入超出范围的值时，工具结果明确说出超范围与允许范围，不悄悄当成功 — 谁检查: 机器
- [ ] 4. 重跑训练集第一、二档（同两个配置）：BYS-049、060、072、073 两个配置都通过；整体一档、二档不低于本轮 — 谁检查: 机器，评测
- [x] 5. 判分标准修正：BYS-140 不要求用户点下载（生成可下载文件即可）；BYS-048 到达站内搜索结果页即可，不论路径；BYS-083 宏碁按系列名计 27 并说明口径也算对 — 谁检查: 人（读 tasks_changes.md）

## 边界与不做

- 不做 PDF 下载（#25）与交付前自检（#28），排在后面。
- 不为单个网站写特例；规则按页面通用属性实现。

## 实测证据

- 标准 1（10-02，真侧栏 + 脚本模型，`npx tsx scripts/acceptance/real-path/screenshot-to-user.mts --headless`）：
  - 做法：`screenshot` 加 `forUser`；为 true 时宿主把 PNG 存进会话文件区（`截图-<时间>.png`），侧栏卡片直接显示图，点图或「打开」看大图，「下载」得 PNG。默认截图只给模型看。规则见 [文件卡片与截图](../artifacts.md#截图哪些给用户看)。
  - 旧代码（HEAD cc48aad 原样导出，同一脚本）：FAIL，侧栏只有「这是当前页面的截图。」，没有图；`imageShown/isThePage/inAnswerArea/enlarge/download/replay` 全 false。产物 `out/acceptance/real-path/2026-10-01T19-49-54-592Z-screenshot-to-user-old-code-HEAD-cc48aad/`。
  - 新代码：PASS，8 项全过：图在回答下面、不在执行过程里；尺寸等于截图时工作页视口（894×749），取样点是练习页的绿色；查看页与下载的 PNG 尺寸、颜色一致；模型自己截的图不进侧栏；重载侧栏切回该会话后图仍在；侧栏文字无 base64、无工具名。产物 `out/acceptance/real-path/2026-10-01T19-52-01-467Z-screenshot-to-user/`（`panel-after-ask.png`、`viewer-screenshot.png`、`panel-after-reopen.png`、下载的 PNG、`summary.json`）。
  - 未验：真模型会不会在用户要截图时带上 `forUser`，留给标准 4 重跑 BYS-049。
- 标准 5（主代理，10-02）：三题规则已改，原规则与原因记在 `eval/tasks/tasks_changes.md`「2026-10-02 复核修正」。

- 标准 2、3（10-02，隔离无头 Chrome + 当前源码构建的扩展执行器，`npx tsx scripts/acceptance/page-readouts.mts --headless --live`，零模型请求）：
  - 做法与规则：见[页面读数](../page-readouts.md)。截断：显示文字以 `…`/`...` 结尾、元素自带的 title / aria-label / aria-description 以截断前缀开头且更长时，快照附 `full="…"`、`read_element` 给 `fullText`；不猜 data-* 与相邻文字。范围：time/date/datetime-local/month/week/number/range 读数带 type 与 min/max/step；`fill` 写入后浏览器 `validity` 报 rangeUnderflow/rangeOverflow/stepMismatch 时回执带 `rangeIssue`，模型文字说明越界与允许范围。
  - 旧代码（HEAD cc48aad 原样导出，同一脚本）：11 项中 10 项 FAIL、合法值对照 1 项 PASS。例：`link "Asus ROG Strix..." url=…/product/147`；`InputTime "Preferred delivery time:"`（无范围）；填 21:30、00:00、11:07 均只回 `{"filled":true}`。产物 `out/acceptance/page-readouts-baseline-cc48aad/`。
  - 新代码：13/13 PASS（本机样例 11 项 + 真站 2 项），产物 `out/acceptance/page-readouts-2026-10-01T19-55-24-424Z/`。webscraper 第 20 页：`link "Asus ROG Strix..." full="Asus ROG Strix GL702VM-GC146T" url=…/product/147`。httpbin：`InputTime "Preferred delivery time:" type=time min="11:00" max="21:00" step="900"`；填 21:30（只填不提交）模型看到「Filled @16, but the value is not accepted by the page. Out of range: "21:30" is above the page's maximum 21:00. Allowed: 11:00–21:00, step 900 s. …」。本机样例另验：00:00 报 rangeUnderflow、11:07 报 stepMismatch、19:00 不报；数字框 11（max 10）报越界；越界后快照行带 `value="21:30" … invalid=rangeOverflow`；不相关的 title（「Read more...」配「Opens in a new window」）不附；CSS 省略号截断与 aria-label 已完整的链接不变。判据取页面自己的 title/min/max 与浏览器的 `validity`。
  - 未做：#27 里「时间框子字段 ref（时/分）不可填」不在本次标准内，仍按原样拒绝；格式不合法被浏览器清空的值（如 `9:30pm`）不报。真模型是否据此答对 BYS-060/072/073 留给标准 4。

（其余实现后填写）
