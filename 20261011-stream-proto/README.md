# 回答流式手感 · 现在 vs 按 Claude 实测（原型）

- 用户：在侧栏里读 By Your Side 回答的人
- 场景：问一句「用三段话介绍一下黑洞」，模型输出一阵一阵到，中间卡了约 1 秒
- 需求：文字流出来要像在读书，稳、柔，卡一下也不突兀；长回答不越写越卡
- 问题：现在一次放 1～3 个字、每 32ms 一次，速度随积压忽快忽慢；300ms 快收淡入加 2px 模糊，配一个蓝色闪烁光标，读起来像打字机；每 32ms 把整段回答重新渲染一次；`**` 闭合前会露出星号
- 方案：加一层「节拍器」：每 150～200ms 放一段 14～24 字；每段 400ms 匀速淡入，淡完拆掉 span；只追加或重渲染当前这一块；回答块 1.1s 弹簧上浮入场；复制按钮等 100ms 再淡入 120ms；思考行换字 180ms 上下淡入淡出

## 怎么看

| 东西 | 路径 |
|---|---|
| 可点原型（左右同播，可切「正文衬线」） | `index.html`（file:// 直接开；单侧：`panel.html?v=cur` / `panel.html?v=new&serif=1`） |
| 对比录像，系统无衬线（2x，1648×1808，30fps，16.1 秒） | `compare.mp4` |
| 同上，右边开衬线（宋体档） | `compare-serif.mp4` |
| 静图：流到一半（右边能看到两三段同时在淡入的「波」） | `compare.png`（= `stills/still-mid.png`）；结束态 `stills/still-end.png`；衬线 `stills/still-serif-{mid,end}.png` |
| 重新录 / 截图 / 冒烟 / 长回答测速 | `node tools/record.mjs [serif]` · `node tools/still.mjs [serif]` · `node tools/check.mjs` · `node tools/bench.mjs` |

- 样式：`product-styles.css` 是仓库 `extension/src/sidepanel/styles.css` @ `6a8587b` 原样复制（sha1 一致）。右边新增的规则全在 `panel.css`，只用已有 token。
- 左边：`current.js` 是 `stream-reveal.ts` 逐行照搬（只去类型），时间线按 `main.ts` 的实际调用顺序复刻（`addMsg` 建块 → 每个 delta `revealText` → 流结束 `closeBlocks` 立刻去光标 → 放完才 `attachAnswerActions`）。
- 右边：`new.js` 是节拍器 + 渲染器，写法就是准备搬进 `stream-reveal.ts` 的样子。
- 两边吃同一条到达时间表（`stream.js`，固定种子）：24 阵、每阵 2～28 字，第二段「超大质量黑洞」前卡 1.05 秒，共约 5.5 秒。时间轴（录像下方）三行：模型到达 / 现在放出 / 改后放出。
- 文字用实测报告里的三段黑洞；为了顺带演示「半截 Markdown」，把「事件视界」「霍金辐射」改成了 `**粗体**`。
- 思考行两边都用「想了 N 秒 ›」收尾（借 A+C 的写法，两边一样，不是本次比较对象）。
- 没改产品代码，没推送；`git status` 干净。

## 对比表

| 环节 | Claude 实测 | BYS 现在（main @ 6a8587b） | 差距 | 改法 |
|---|---|---|---|---|
| delta 怎么进来 | — | 宿主把模型每个 `text_delta` 原样转发（`agent/src/session.ts:1995-1997`）；侧栏每个 delta 累加全文后调 `revealText`（`main.ts:4179-4184` → `appendDelta` `main.ts:3759-3764`；另有 `appendLeadAnswer` 3654、`user_delivery_stream` 4307、最终稿 3587/4444/4461） | 入口已经统一在 `revealText`，好改 | 节拍器只放进 `stream-reveal.ts`，调用方不动 |
| 放字节奏 | 每 150～200ms 一段，每段 14～24 字（约 100 字/秒的稳节拍，缓冲模型的不均匀） | 每 32ms 一拍（`stream-reveal.ts:14`），每拍放 `max(45字/秒, 积压/1.2秒)` 换算的字数，实际 1～3 字（`:86-87`）；积压大就快、积压小就慢，积压空了就硬停 | **最大差距。** 颗粒是字不是段；速度跟着模型的阵发走（录像时间轴「现在放出」一整排细竖线，疏密不匀）；卡顿时最后一个字停住、光标在下一行闪 | 节拍器：150～200ms 抖动一拍，一拍 14～24 字，尽量停在标点后、段尾；积压多时把段放大（约 1.5 秒内追平）；手里不足 6 字就再等最多 350ms 凑一段 |
| 每段怎么出现 | 400ms **匀速**透明→不透明，无位移、无模糊；同时有 2～3 段在淡，像一道波 | 300ms `--e-swift`（快起慢停）透明 + 2px 模糊（`styles.css:906-920`，`FADE_MS=300` `stream-reveal.ts:16`） | 快起曲线前 80ms 就基本显形，加上每次只 1～3 字，看不到「波」，只看到一个模糊的笔尖；模糊和 Claude 的做法相反 | `.chunk-fade { animation: 400ms linear }`，只动 opacity |
| 淡完以后 | span 拆掉、并回纯文本 | 每 32ms 用 `innerHTML` 重渲染**整段回答**，过期批次下一帧不再包 span（`stream-reveal.ts:113-124`，`wrapFading` 每帧遍历全部文字节点 `:128-166`）。结果上不留 span，但代价是整段 DOM 每帧换新 | 一次 260 字的回答重渲染约 170～190 次；8000 字时单次整段渲染 4.4ms（本机），每帧都付；流的过程中选不中字 | 只动最后一块：新的一段不含 Markdown 记号就直接在末尾追加 span（本例 20 段里 13 次走这条），否则只重渲染当前块（7 次）；`animationend` 拆壳 + `normalize()` |
| 光标 | 无 | 蓝色 `▍` 1s 闪（`styles.css:893-904`），挂在块末 `::after`，段落后面会单独占一行 | 和「读书」的气质冲突；卡顿时最显眼 | 去掉；「还在写」由正在淡入的末段表达 |
| 半截 Markdown | （网页端未测） | 按已放出前缀整段 `marked` 渲染（`stream-reveal.ts:7`），`**` 没闭合时星号原样露出，闭合时字数变少再丢批次（`:118`）；冒烟里采到 6 帧有星号 | 星号一闪 | 活动块渲染前补齐未闭合的 `**`（同 streamdown `remend`）；切段时不把 `**` 切两半 |
| 整条回答出现 | 上浮 10px + 淡入，1.1s 弹簧（约 16% 过冲） | `.msg` 120ms 从 0.4 透明度起（`styles.css:828-829`），无位移 | 几乎没有入场 | `answerRise` 1.1s `linear()` 弹簧曲线（实测前半段 + 后半段补齐），只在第一段放出时加一次 |
| 思考行：光带 | 光带 3 秒一圈（15%～85% 扫过，两头停顿） | `runShine` 2.4s 连续扫（`styles.css:3002-3009`） | 小：没有停顿，略急 | 3s、两头停 15% |
| 思考行：换字 | 旧字上移 3px 淡出、新字下方 3px 淡入，宽度补间，180ms | `paintAction` 直接 `replaceChildren`（`main.ts:2271-2285`），每句至少停 1.1s（`RUN_TITLE_HOLD_MS` `main.ts:2268`、`setRunTitle` 2288-2301） | 换字是硬切 | 180ms `--e-swift` 交叉淡入 + 宽度补间；保留 1.1s 停留 |
| 思考行：秒数 | 旁边「5s」 | 「N 秒」每 1000ms 更新（`main.ts:3179-3181`），在行尾右对齐（`styles.css:3010`） | 基本一致 | 秒数贴在字后（和 A+C 的 `pa-sec` 一致），宽度补间才有意义 |
| 复制 / 重试按钮 | 等 100ms，再 120ms 淡入 | 放完立刻 `attachAnswerActions`（`main.ts:3587` → `answer-actions.ts:13-64`），直接出现；`.answer-actions` 只有悬停用的 opacity 过渡（`styles.css:3073-3075`） | 和最后一段抢注意力 | `.answer-actions.enter { animation: 120ms 100ms }`（120ms 正好是 `--m-quick`） |
| 滚动遮罩 | 上下边缘渐隐 | 已有：40px 渐隐 + 2px 模糊，只在还能滚的一侧出现（`styles.css:780-807`，`main.ts:264-265, 2428-2442`） | 无（10-05 已采纳的 C） | 不动 |
| 回答字体 | 衬线，15px / 22px，段距约 11px，无气泡 | 系统无衬线 15px / 1.7（25.5px），段距 12px（`styles.css:4-5, 2402-2419`），无气泡；「阅读外观」已有宋体档（`reading-settings.ts:48-52`） | 字族不同；行高比 Claude 松，380px 窄栏里反而合适 | 不强改。原型给了开关（右上「正文衬线」= 宋体档）。看录像：宋体在暖纸上更像书，但笔画细，15px 下比无衬线淡一档（录像机上是 Noto Serif CJK，Mac 上是宋体-简，观感会再细一些）；建议默认仍无衬线，阅读外观里的宋体档沿用 |
| 你的问题 | 无衬线，浅灰圆角框（圆角 12、内边距 12×16） | 右对齐 well 气泡，圆角 20/20/6/20、内边距 8×14、15px/1.6（`styles.css:837-852, 3113`） | 形状不同 | 不动：这是 BYS 自己的壳，不是手感问题 |

**前三大差距**：① 放字颗粒和节奏（逐字、跟着阵发忽快忽慢 vs 稳定节拍分段）；② 淡入形态（300ms 快收 + 模糊 + 闪烁光标 vs 400ms 匀速纯透明的「波」）；③ 渲染方式（每 32ms 整段 innerHTML 重建、星号外露 vs 只追加/只重渲染当前块、淡完拆壳）。入场弹簧和按钮延迟是第二梯队，改起来最便宜。

## 工程方案

### 1. 节拍器放哪
- 只改 `extension/src/sidepanel/stream-reveal.ts`。所有回答路径都已经走 `revealText(el, 累计全文, {live, final, after})`，调用方（`main.ts` 3587/3654/3682/3764/4307/4444/4461）一行不动。
- `Reveal.update()` 照旧接「累计全文」，内部把新增部分推进 `buffer`；`tick` 从「每 32ms 放 N 字」换成「每 150～200ms 放一段」。常量：`BEAT 150–200`、`CHUNK 14–24`、`CATCH_UP_MS 1500`、`STARVE 6 字 / 350ms`、`FADE_MS 400`。原型实现见 `new.js` 的 `take()`/`beat()`。
- `final=true` 后把剩余 buffer 按同样节拍放完，再调 `after()`（挂复制按钮）；按钮自己带 100ms 延迟 + 120ms 淡入。
- 不变的：`live=false`（历史回放）和减弱动态直接 `flush()` 整段显示；`data-revealing` 属性保留（验收脚本靠它等放完，`stream-reveal.ts:66-67`）；改写/换稿时从共同前缀接着放（`:39-45`）。
- 宿主那边不动。不要在 `session.ts` 做缓冲：节拍是显示层的事，宿主越早把字给侧栏越好。

### 2. 和半截 Markdown 怎么配
- 按块切：用 `marked` 的 `Lexer.blockTokens` 把全文切成块（streamdown 就是这么做的：`packages/streamdown/lib/parse-blocks.tsx:1, 110`，`parseMarkdownIntoBlocks` `:308`；稳定块复用同一字符串 `:300-304`）。除最后一块外都已定稿，DOM 不再碰；streamdown 也是靠 `Block = memo(...)`（`index.tsx:481`）让定稿块不重渲染。
- 活动块渲染前补齐未闭合语法：原型只做了 `**`；正式版建议把 streamdown 的 `remend` 规则抄一份（`packages/remend/src/emphasis-handlers.ts:394 handleIncompleteBold`，以及 inline code / 链接 / 代码块那几个 handler）。代码块没闭合时按「代码块进行中」整块显示，不逐段淡入。
- 切段规则避开记号：不把 `**`、`` ` ``、`](` 切成两半；段尾 `\n\n` 让下一拍从新块开始（原型 `take()`）。
- 结构没变（新的一段不含 Markdown 记号）走快路径：直接在最后一个文字节点后插 `<span class="chunk-fade">`；结构变了（`**` 闭合、列表新项、新起一段）只重渲染这一块，正在淡入的段用负 `animation-delay` 接着淡（沿用现有 `wrapFading` 的做法，只是范围从整段缩到一块）。

### 3. 长回答性能
- 现在：每 32ms `marked` + DOMPurify + `innerHTML` 整段一次，再遍历整段文字节点包 span。本机实测单次整段渲染：3000 字 1.9ms、8000 字 4.4ms（`tools/bench.mjs`），而且每帧都付，低配笔记本要乘几倍；流的过程中选字、查找、读屏都会被打断。
- 改后：每 150～200ms 才动一次 DOM（拍数是现在的约 1/5），本例 20 段里 13 次是纯追加、7 次只重渲染当前块（单块约 0.3ms，与总长无关）。同屏最多 2～3 个 span，淡完 `animationend` 拆壳 + `normalize()`，DOM 不膨胀。
- 跟随滚动仍在每次放出后调 `scrollToEnd`，从每 32ms 一次变成每拍一次。若觉得每拍跳一行生硬，再考虑把 `scrollTop` 改成 rAF 里缓动（这次原型两边保持一致，没改）。

### 4. 两个开源库各借了什么
- **vercel/streamdown**（@ 8edc648, 2026-10-07）：块切分 + 定稿块不重渲染（上面）；`remend` 半截语法补齐；`lib/animate.ts:15 MAX_ANIMATION_BACKLOG_MS = 320` 和 `take()` `:90-122` 是「动画排队不许超前墙钟太多、太快就压缩间隔」——和我们的 `CATCH_UP_MS` 是同一个思路；淡完拆壳它也做了（`index.tsx:499-500`、`animate.ts:298-313`，#570）。它的默认是按词错开、150ms 淡入（`styles.css:32-34`），没有固定节拍。
- **Ephibbs/flowtoken**（@ a966002）：`SplitText.tsx:25-63` 的 `diff` 模式「每来一个 delta 包成一个 span」——这正好说明直接按网络 delta 动画会继承模型的阵发；它的 span 是 `inline-block` 且永不拆（`:110-118`），默认 1s ease-in-out 淡入（`AnimatedMarkdown.tsx:25-28`）。只借「按 diff 包 span」这一个点，节拍和拆壳都得自己做。
- 两个库都没有「固定节拍放段」这一层，这正是 Claude 手感的关键，要自己写（约 120 行，见 `new.js`）。

### 5. 动效语言怎么收
- 10-05 定的 Whirl 式三时长三曲线（`--m-quick/move/morph`、`--e-swift/spring/glide`）。新增的东西尽量落到已有 token：按钮 120ms = `--m-quick`；换字 180ms 用 `--e-swift`。
- 新增两个值需要拍板：`--m-read: 400ms` + `linear`（段淡入），`--e-rise`（回答入场 1.1s 弹簧，`linear()` 写法；现有 `--e-spring` 是 `cubic-bezier(0.34,1.4,0.64,1)`，只过冲约 5%、也没有回落那一下，不能直接替）。
- 减弱动态：段淡入、入场、换字全部关掉，直接整段显示（沿用 `revealText` 现有分支）。

### 6. 没做的 / 风险
- Claude 的分段到底按字数还是按 token 没测到；「停在标点后」是我们加的，看录像读起来更顺，但会让段长在 8～28 之间浮动。
- 弹簧曲线 47% 以后是按趋势补的（同实测报告）。
- 没测代码块、表格、列表在节拍下的样子；正式实现前要用 `docs/evals` 里的长回答样本各录一遍。
- 思考行的结构归 A+C 那条线（`/workspace/bys-proto-steps/`），这里只给了换字和光带的参数。
