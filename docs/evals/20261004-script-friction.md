# 任务: 页面刷新后脚本照常执行，browser_run 报错直接说怎么改，js 取到的数据直接存成文件

起因：真实使用与 124 次评测（`eval/runs/tiers12-after-fixes-20261002`）里，模型意图对，但工具拒绝或绊倒它：刷新后 21 次「页面文档已变化」（js 11、browser_run 9、click 1）；browser_run 46% 报错，多为位置参数、未知方法名和程序里写 `window`/`document`/`Blob`；4.3 万字字幕经 `artifacts` 重打用了 234 秒。负责人要求删严格、不加规则。

## 规则

- R1 snapshot 之后页面刷新/跳转，只拒旧快照的 `@N`；CSS/xpath/text/role、坐标、无目标键盘输入、`js`、`cdp` 在当前页执行。
  - 例子(正)：snapshot 后页面刷新，那么 `js` 读到新页、`click #ack` 点到。 — 谁检查：`script-friction.mts`
  - 例子(反)：旧快照的 `@5` 仍回「页面文档已变化」；CSS/xpath/text、无目标输入放行。 — 谁检查：`extension/test/harness-s2-document-evaluator.test.ts`
- R2 browser_run 不传参或传 `null` 按 `{}`；位置参数报「takes one object」；未知方法列出规范方法名。 — 谁检查：`agent/test/script-friction.test.ts`
- R3 程序里写页面全局（document、window、Blob、fetch、setTimeout 等）时，报错指向 `browser.js` / `browser.saveFile` / `browser.sleep`；自己写错的变量名原样报，`typeof window` 仍是 `"undefined"`。 — 谁检查：同上
- R4 `js` 带 `saveAs` 时返回值按 artifacts 同一规则存进会话文件（同一张卡片），模型只拿到 `{filename, chars, lines}`；文件名不合规时脚本不运行。
  - 例子(正)：刷新后的 120 行字幕存成 page-data.txt，侧栏下载的文件与页面逐字相同。 — 谁检查：`script-friction.mts`
  - 例子(反)：超过 256000 字或没有返回值时不存、不出卡片。 — 谁检查：单测 B4-3

## 还没答上的问题

- 无。

## 技术前提

- 前提：QuickJS 里页面全局与未知方法的原始报错可识别。小实验：临时脚本跑 `runBrowserProgram`，得到 `'document' is not defined`、`not a function`、`browser.sleep(1000)` → `Browser parameters must be an object`、`typeof window` → `"undefined"`。结果：通过。
- 证据修正：`browser.snapshot()` 不传参在 09-07 起就按 `{}` 处理；那 7 次「must be an object」来自数字、字符串等位置参数，所以改的是报错文字。

## 边界与不做

- 不改操作途中文档被替换的拒绝（点击、滚轮、截图、snapshot 途中）；不改结果未知锁。
- 不自动把位置参数猜成命名字段；不处理 “value is not iterable”。
- 新场景未加进 `run-all.mts`。

## 结果（10-04）

| 检查 | 结果 |
|---|---|
| 新单测（改前） | 工具边界版 17 失败 2 通过（通过的两条是反向守卫）：`out/acceptance/script-friction/before-tests.txt`；该版 B1 用例靠模块替身，违反 lint 的 no-module-mocking，改为文档守卫一条用例，对改前模块同样失败 |
| 新单测（改后） | 22/22 通过：`after-tests.txt` |
| 真实路径（改前，HEAD 快照构建） | FAIL：刷新后 js 回「页面文档已变化」，随后被记成结果未知、锁住后续写入：`out/acceptance/script-friction/before-real-path/` |
| 真实路径（改后） | PASS：`out/acceptance/real-path/2026-10-04T12-04-01-995Z-script-friction/` |
| `data-to-file.mts --scripted` | PASS |
| typecheck、模块边界、隔离构建 | 通过；构建到 `out/builds/script-friction`，未动 `extension/dist` |
| `npm test` | 2976 通过，5 失败均在 `eval-gates`（HEAD 上同样失败，锁定门槛 sha 未修订）；`test:scale` 2 项耗时断言在 HEAD 快照上同样失败 |
| 真实模型复跑 4 题（M3.1+GLM，未判分） | BYS-045/055/056/060：「页面文档已变化」9→0 次；browser_run 报错 7→7，但类型变了（剩下的是找不到元素、选择器多匹配、`browser.sleep(数字)` 新报错文字等）；耗时单次波动大，不下快慢结论。`eval/runs/script-friction-20261004/` |
