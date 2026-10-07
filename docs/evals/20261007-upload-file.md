# 任务: 用户说「新建 hello.txt 传上去」，助手把文件传上页面

背景：扩展里没有本机磁盘，旧的 `upload_file` 按磁盘路径工作，已在 [删减](20261004-cut-unused.md) 时删掉。之后模型只能点开系统选择框，再请用户自己选文件。BYS-145 升级 Pi 1.0 前 1/3，升级后约 1/2；成功的那次靠 `browser_run` 自己拼 DataTransfer。

做法：恢复模型工具 `upload_file`。文件按文件名取自本会话：`artifacts` 或 `browser.saveFile` 存下的文件，和用户在侧栏附上的文件。扩展在页面里用 DataTransfer 构造 File，放进 `<input type=file>`，发 input/change，再读回文件名和大小作回执。不打开系统选择框，不碰本机磁盘。

## 规则

- R1 BYS-145 3/3 通过：页面显示 File Uploaded! 和 hello.txt。
  - 例子(正)：助手存 hello.txt，调 upload_file，点 Upload，页面显示 File Uploaded! — 谁检查：`node eval/harness/ladder.mjs --tag upload-1 --levels L4` 的 judge
  - 例子(反)：助手点开系统选择框后请用户自己选文件 — 谁检查：同上，判失败
- R2 回执只认读回：回执列出从文件框读回的文件名和字节数；找不到文件框、有几个文件框、文件名不存在时报错，页面不动。
  - 例子(正)：hello.txt (5 B) — 谁检查：trace 里的 upload_file 结果
  - 例子(反)：页面有 2 个文件框且没给 target，回执却说成功 — 谁检查：同上
- R3 L4 其余 4 题不退步：143、144、146 各 3/3，147 不低于 2/3。谁检查：`ladder.md`

## 还没答上的问题

- 无。

## 技术前提

- 前提：扩展在页面里设置 `input.files = DataTransfer.files` 后，页面表单能提交该文件。小实验：本次 L4 阶梯的 BYS-145 本身（真实站点、真实提交）。结果：见证据。

## 边界与不做

- 不做本机路径和系统选择框。
- 不改其他工具和它们的说明。
- 用户附件现在只有图片；别的文件类型的附件不在本任务里。
- 跨站 iframe 里的文件框不处理（只找主文档和开放的 shadow root）。

## 证据

- 阶梯 L4（每题 3 次，Chrome 1228，gpt-6-luna），表在 `eval/runs/ladder-upload-*/ladder.md`：
  - upload-1：143 ✗✗✓、144 ✓✓✓、145 ✓✓✓、146 ✓✓✓、147 ✓✓✓。
  - upload-2（加了「多个文件框时列出候选」）：145 ✓✓✗。失败那次模型没调 upload_file，在 browser_run 里自己拼文件。之后把 upload_file 的说明改成「唯一的上传方式」。
  - upload-3（上面的说明，接到含 #82–#85 的 main 后）：143 ✗✗✗、144 ✓✓✓、**145 ✓✓✓**、146 ✓✓✓、147 ✓✓✓。三次都是 artifacts → upload_file → 点 Upload。R1 达成。
- R3 的 143 没达成，与本改动无关：改动前的基准提交上单独跑 6 次也只成 3 次，失败方式相同。弹窗淡入时，点击在按下前被遮挡检查拦下，却被记成「结果不确定」，助手按规则不再重试。修复另开 PR（按下前就被拦下的点击记成没执行）。
- 没测：用户附件的上传；shadow DOM 里的文件框。
