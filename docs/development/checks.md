# 开发检查

[文档导航](../README.md) · [文档维护](documentation.md) · [真实路径验收](../testing/acceptance.md)

## 两道检查

- `npm test` 是唯一检查产品行为的地方。

每次合并前跑 `npm run check` 和这次改到的用例。`npm test` 不挡在更新日常扩展之前，只在用户发现问题或要求时跑，因为等它的时间多于它抓到的问题。纯文档修改只跑 `npm run check:docs`。

同一用例、同样参数、同样代码失败 2 次后不再跑第 3 次：再跑只是在测模型的随机性。

`npm run smoke` 用真实模型，不是合并门槛。

`check` 会重建日常加载的 `extension/dist`。只想核对打包时，用 `SIDEAGENT_BUILD_DIST` 指向临时目录的绝对路径；npm 工作区会切换当前目录，相对路径会落进 `extension/`，导致验收找不到构建结果。

真实模型、真实供应商和真人体验分开留证。缺凭据或预算时如实写「没跑」。

## 依赖

- Pi 自带 npm-shrinkwrap，所以项目级 override 盖不住 Pi 的依赖版本。要在干净 `npm ci` 后用 `npm ls` 核对。
- 在 worktree 里不要把整个 `node_modules` 指回主树：`@sideagent` 的链接会解析回主树源码，扩展构建里的代理部分就成了主树的旧代码，而类型检查照样通过。
  要建真实的 `node_modules` 目录：其他包逐个链回主树，`@sideagent/agent` 和 `@sideagent/extension` 链到 worktree 自己（10-11 任务 2 踩过）。`npm run task` 开工作树时会这样建好。
- 在 worktree 里不要直接 `npm install`：它会顺着链接改主树的 `node_modules`，把主树的包改名成隐藏目录后报错退出（10-18 踩过，主树 63 个包要手动改回）。加依赖用 `npm install --package-lock-only --save-exact <包>@<版本> -w <工作区>` 只改 package.json 和锁文件，本地构建要用的包按真实目录复制进 worktree 自己的 `node_modules`。

## 前提小实验

验收脚本预计超过 200 行时，先在 `scripts/probes/` 写不超过 50 行的小实验，只证明一句技术前提。

- 结果写进验收文件的「技术前提」。成立才写验收脚本；不成立就改方案，不先搭验收。
- 小实验用独立观测（如服务器计数）。退出码 0 为成立，1 为不成立。运行：`npx tsx scripts/probes/<名>.mts`。
- 小实验不是产品验收，不能冒充真实路径通过。
- 结论写进验收文件后删掉小实验；`scripts/probes/` 只留仍被入口调用的脚本（`compare-real.mts`）。

例子（实验已删，结论留在这里）：

- `readonly-return-getter.mts`：开启副作用拒绝后，返回网页已有对象仍会在序列化时发出 POST。这个小实验用 2 秒复现了 #22 原方案的否定结论。
- `click-request-gesture.mts`：因为点击后的后台请求也为 true，所以不能用 `hasUserGesture` 归因点击请求。方案改用时间窗口。

## 调试入口

- 配置和构建产物存在，不证明正在运行的扩展已经采用了它们。

维护者按 [PR 模板](../../.github/pull_request_template.md)复核。当前进度只在 [STATUS](../STATUS.md) 维护。评测环境分类见[站点不可用](../testing/acceptance.md#评测中的站点不可用)。
