# 开发检查

[文档导航](../README.md) · [文档维护](documentation.md) · [真实路径验收](../testing/acceptance.md)

## 两道检查

- `npm run check`：文档结构、界面用词、动效 token、模块边界、类型、构建。几分钟内跑完，只拦写坏的代码。界面用词只拦[术语表](../glossary.md)「不用」一栏里不会误伤的词，词表在[脚本](../../scripts/maintenance/check-copy.mjs)里。侧栏动效只许写在 token 文件里的时长和曲线，检查在[脚本](../../scripts/maintenance/check-motion-tokens.mjs)。
- `npm test`：核心真实路径用例。用例只装扩展、用脚本模型，所以不要凭据。`npm test` 是唯一检查产品行为的地方。

每次合并前跑 `npm run check` 和这次改到的用例。`npm test` 不挡在更新日常扩展之前，只在用户发现问题或要求时跑，因为等它的时间多于它抓到的问题。纯文档修改只跑 `npm run check:docs`。

每次运行真实路径用例都记进主目录的运行流水，`npm run runs` 看今天每个用例跑了几次、过了几次。同一用例、同样参数、同样代码失败 2 次后，第 3 次会被拦下，因为再跑只是在测模型的随机性；先看失败原因，确实要跑时加 `BYS_RERUN=1`。7 天前、没被文档引用的运行目录在下次运行时自动清理。

`npm run smoke` 用真实模型走一遍日常路径，需要凭据，不是合并门槛。

`check` 会重建日常加载的 `extension/dist`。只想核对打包时，用 `SIDEAGENT_BUILD_DIST` 指向临时目录。

真实模型、真实供应商和真人体验分开留证。缺凭据或预算时如实写「没跑」。

## 依赖

- 依赖审计用 `npm audit --registry=https://registry.npmjs.org`，不改全局源。
- Pi 自带 npm-shrinkwrap，所以项目级 override 盖不住 Pi 的依赖版本。要在干净 `npm ci` 后用 `npm ls` 核对。
- 在 worktree 里不要把整个 `node_modules` 指回主树：`@sideagent` 的链接会解析回主树源码，扩展构建里的代理部分就成了主树的旧代码，而类型检查照样通过。
  要建真实的 `node_modules` 目录：其他包逐个链回主树，`@sideagent/agent` 和 `@sideagent/extension` 链到 worktree 自己（10-11 任务 2 踩过）。`npm run task` 开工作树时会这样建好。

## 前提小实验

验收脚本预计超过 200 行时，先在 `scripts/probes/` 写不超过 50 行的小实验，只证明一句技术前提。

- 结果写进验收文件的「技术前提」。成立才写验收脚本；不成立就改方案，不先搭验收。
- 小实验用独立观测（如服务器计数）。退出码 0 为成立，1 为不成立。运行：`npx tsx scripts/probes/<名>.mts`。
- 小实验不是产品验收，不能冒充真实路径通过。

例子：

- `readonly-return-getter.mts`：开启副作用拒绝后，返回网页已有对象仍会在序列化时发出 POST。这个小实验用 2 秒复现了 #22 原方案的否定结论。
- `click-request-gesture.mts`：因为点击后的后台请求也为 true，所以不能用 `hasUserGesture` 归因点击请求。方案改用时间窗口。

## 调试入口

- `npm run reload:ext` 需要 Chrome 的远程调试入口，只在明确的加载范围内执行。
- 配置和构建产物存在，不证明正在运行的扩展已经采用了它们。
- `npm run logs`（[脚本](../../scripts/maintenance/logs.mjs)）直接读日常 Chrome 里 By Your Side 的诊断记录，不用在设置页导出，给代理查问题用。输出保留原文（凭据除外），所以不要提交或外传。第一次运行要从 GitHub 装 Python 解码库，比较慢。

## 项目看板

`npm run dashboard`（[脚本](../../scripts/maintenance/dashboard.mjs)）生成给产品负责人看的一页静态 HTML。看板脚本只读仓库，不改远端。看板只是汇总视图，不替代 STATUS 与验收记录。


## CI 与人工复核

- [Quality](../../.github/workflows/quality.yml)：PR 上跑 `check` 的各项。
- [Documentation](../../.github/workflows/docs.yml)：文档结构检查。
- [E2E](../../.github/workflows/e2e.yml)：手动触发，在 Linux 上跑 `npm test` 的用例。

维护者按 [PR 模板](../../.github/pull_request_template.md)复核。当前进度只在 [STATUS](../STATUS.md) 维护。评测环境分类见[浏览器证据](../testing/eval-environment.md)。
