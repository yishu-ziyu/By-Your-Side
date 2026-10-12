# 任务: 用户说「切到youtube」、YouTube 已开在后台时，gpt-6-luna 也把那一页切到眼前

来源：[#288](https://github.com/yishu-ziyu/By-Your-Side/issues/288)。10-12 复查（[切到某页](20261011-show-page-to-user.md#10-12-复查gpt-6-luna-上做不到288)）：gpt-6-luna 0/3，助手每次都用 `tabs open` 新开 youtube.com，新页开在后台，用户眼前仍是抖音，助手却说「已打开」。

做法：工具只给事实，由助手判断，不按关键词加特例。`tabs open` 的结果多写两件事：新页开在后台、用户眼前还是哪一页；已开着的同一网站的页有哪些，用 show 能把它切到眼前。工具说明里写明 open 开在后台，用户要去某个网站时先看已开的页、用 show。

## 规则

- R1 用户在抖音页、YouTube 已开在后台，说「切到youtube」，用户眼前变成已开的那一页。
  - 例子(正)：`npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless --suite=compare --model=openai-codex/gpt-6-luna --repeat=3 --only=switch-tab` 3/3。新开一个 youtube.com 并切到眼前算失败 — 谁检查：脚本判活动页是 /yt，人读导出记录核对调用
  - 例子(反)：两处都不改（主干），同一命令失败 — 谁检查：同一命令
  - 修订（10-12）：原来的反例是「只去掉 open 结果里新加的两件事」。实测它照样 3/3 通过，所以不能当反例，见结果。
- R2 「不抢前台」照旧：keep-foreground 的 a–f 全部通过 — 谁检查：`npx tsx scripts/acceptance/real-path/keep-foreground.mts --headless`
- R3 gpt-6.1-sol 上不退步 — 谁检查：`everyday-baseline.mts --headless --suite=compare --deep --model=openai-codex/gpt-6.1-sol --repeat=2 --only=switch-tab` 2/2

## 还没答上的问题

- 无。

## 技术前提

- 前提：open 结果能读到用户眼前的页和全部标签页。做法：复用 `get_active_tab`、`list_tabs`，读失败就不写那一句。不需要小实验。
- 前提：练习站的 /yt 是本机页面，标题是「YouTube」，主机名和 youtube.com 不同。所以 R1 只验证了「主域名出现在标题或网址里」这条匹配，没有验证「主机名相同」这条。

## 边界与不做

- 不改不抢前台、switch 和 show 的行为、目标核对。
- 只给主会话的助手加这两句；帮手（worker）不能用 show，open 结果不变。

## 结果（10-12）

全部用 gpt-6-luna 默认档，「切到youtube」各跑 3 次。每次都读了导出的任务记录。

| 版本 | 结果 | 助手怎么做 |
|---|---|---|
| 两处都改（本次提交） | 3/3，再跑一轮也 3/3 | 6 次都先列标签页，再 show 已开的 /yt。其中 3 次第一下 show 带了编造的核对凭证，被拒后再 show 成功 |
| 只改工具说明 | 3/3 | 3 次都是列标签页，再 show /yt |
| 只改 open 结果 | 2/3 | 2 次列标签页再 show /yt；1 次先 open，结果里列出了 /yt，助手却 show 了新开的 youtube.com，判失败 |
| 两处都不改（主干） | 0/3 | 3 次都 open 新开 youtube.com，用户眼前仍是抖音（10-12 复查那一轮） |

- R1：通过。起作用的主要是工具说明：只改说明就 3/3。open 结果里的两件事只在助手已经 open 时有用：只改结果的两轮里，助手 2 次用了 open，之后 1 次 show 了已开的 /yt（通过），1 次 show 了新页（失败）。两处都保留，因为说明管助手会不会先找已开的页，结果管它已经 open 之后能不能看到用户眼前还是原页。
- 只改 open 结果另有一轮是和别的工作线的无头运行同时跑的，不计入表格：2/3。1 次 open 后照结果 show 了已开的 /yt（通过）；1 次用了 switch 而不是 show，用户眼前没变（失败）。
- R2：keep-foreground 的 a–f 全部通过。
- R3：gpt-6.1-sol 深思考 2/2，两次都是列标签页再 show /yt。
- R3 之后改过一处：判断「同一网站」时，www.bbc.com 原来会被认成 www，改成只去掉 co、com 这类后缀。youtube.com 的判断不变。改后重跑 R1 3/3、R2 a–f 通过、R3 2/2（两次仍是列标签页再 show）。
- 作废的一轮：第一次在 worktree 里跑 R1 是 0/3。原因是 worktree 的 `node_modules` 链到主目录，扩展打包时 `@sideagent/agent` 用的是主目录的 agent 代码，不是这次的改动；导出任务记录为空也是这个原因。把 worktree 的 `@sideagent` 改链到 worktree 自己的目录后重跑，上表都是重跑后的结果。
- 证据：`out/acceptance/real-path/` 下 10-12 04:17 和 04:41（两处都改）、04:36（只改说明）、04:22（只改结果）、04:37 和 04:42（keep-foreground）、04:38 和 04:44（sol）的目录（不入库）。
