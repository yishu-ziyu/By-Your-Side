# 任务: 程序打开了页面，模型不再花几轮去「确认」（#257）

## 规则
- R1 `browser_run` 结束时（做完、assert 停下、报错都算），结果末尾写明工作标签页现在停在哪一页：标题前 120 字和 origin+pathname。
  - 例子(正)：程序里点链接到了页 B，结果末尾是「the working tab N shows "Page B" — http://…/b; that is the page now」 — 谁检查：`program-receipt.mts` c
  - 例子(反)：主干构建跑同一用例，结果里没有这一行，c 失败 — 谁检查：同上
- R2 选择器匹配到多个元素时，报错列出前 5 个候选，每个带只指向它的 `loc=css` 路径、标签和文字；模型下一步直接用，不必再读一轮页。
  - 例子(正)：`a.item` 匹配两个链接，报错写「2) loc=css:a:nth-child(2) <a> "Beta"」，用它点击成功 — 谁检查：`program-receipt.mts` a、b
  - 例子(反)：主干构建只说「请 snapshot 确认目标」，a 失败 — 谁检查：同上
- R3 程序里每个 snake_case 方法都认 camelCase 写法（`pressKey`、`readElement`）。
  - 例子(反)：主干构建 `browser.pressKey` 报「not a browser method」，b 失败 — 谁检查：同上
- R4 真实阶跃「搜索并打开」的轮数不比主干多，花 6 轮以上的次数变少 — 谁检查：工程师跑 `trace-run.mts --scenario=action`

## 还没答上的问题
- 无。

## 技术前提
- 前提：`list_tabs` 标出工作标签页，不挂调试器。小实验：读 `pageInfo` 的实现，它就这样取工作页。结果：通过。
- 前提：主干上「搜索并打开」多出来的轮次，来自程序结束后模型不知道停在哪、歧义报错没有候选、方法名猜错。小实验：逐轮看主干 9 次里 3 次长跑（7–8 轮）的程序和结果。结果：通过（见下）。

## 边界与不做
- 不在提示词里加「别确认」之类的句子：信息给到了，模型自己会停。
- 旧编号失效时的报错（CDP 原文「No node with given id found」）、程序里按回车跳转后马上读页报错，这次不改，看真实测量里还出不出现。

## 结果
- R1–R3 通过：`program-receipt.mts` 3 项通过；用主干构建跑同一用例，3 项都失败（歧义报错只说「请 snapshot」；`pressKey` 报不是方法；没有结束页面那一行）。
- R4 通过：真实阶跃 `step-5-preview`，Step Plan，低档，隔离无头 Chrome，「search Studio Ghibli on Wikipedia and open it」。

| | 次数 | 每次轮数 | 6 轮以上 |
| --- | --- | --- | --- |
| 主干（`d4e5a60` 起的两版构建） | 9 | 2、2、2、2、2、2、7、7、8 | 3 次 |
| 改后 | 6 | 2、2、2、2、2、3 | 0 次 |

- 主干 3 次长跑逐轮看：程序打开了条目，但模型只拿到程序自己 return 的东西，又写 2–4 个程序去读标题和首段「确认」；中间还撞上歧义报错（没有候选，只好再读一轮页）、`pressKey` 不是方法、旧编号失效。
- 改后 6 次里 5 次用了 `browser_run`，都在程序结果里看到了「现在停在 Studio Ghibli - Wikipedia」。第 6 次仍多读了一次标题（`read_element`，多 1 轮），没有为它加提示词。
- 改后这 6 次和另一组测量同时跑，耗时互相抢资源，只比轮数，不比秒数。
- 现有用例：script-friction、navigate-wait、click-blocked-reason、target-gone、double-click-new-tab 通过。
