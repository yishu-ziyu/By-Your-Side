# 开发检查

[文档导航](../README.md) · [文档维护](documentation.md) · [真实路径验收](../testing/acceptance.md)

## 两道检查

- `npm run check`：文档结构、模块边界、类型、构建。几分钟内跑完，只拦写坏的代码。
- `npm test`：核心真实路径用例。只装扩展，用脚本模型，不要凭据。它是唯一检查产品行为的地方。

两者都过才合并。纯文档修改只跑 `npm run check:docs`。

`check` 会重建日常加载的 `extension/dist`。只想核对打包时，用 `SIDEAGENT_BUILD_DIST` 指向临时目录。

真实模型、真实供应商和真人体验分开留证。缺凭据或预算时如实写「没跑」。

## 依赖

- 依赖审计用 `npm audit --registry=https://registry.npmjs.org`，不改全局源。Pi 自带 npm-shrinkwrap，项目级 override 盖不住它，要在干净 `npm ci` 后用 `npm ls` 核对（[升级验收](../evals/20261003-issue-42-dependencies.md)）。
- 在 worktree 里不要把整个 `node_modules` 指回主树：`@sideagent` 的链接会解析回主树源码。

## 前提小实验

验收脚本预计超过 200 行时，先在 `scripts/probes/` 写不超过 50 行的小实验，只证明一句技术前提，结果写进验收文件「技术前提」。成立才写验收脚本；不成立就改方案，不先搭验收。小实验用独立观测（如服务器计数），退出码 0 为成立、1 为不成立；`npx tsx scripts/probes/<名>.mts` 运行。它不是产品验收，不应冒充真实路径通过。

示例 `readonly-return-getter.mts`：开启副作用拒绝后，返回网页已有对象仍会在序列化时发出 POST，2 秒复现 #22 原方案的否定结论。`click-request-gesture.mts` 否定了用 `hasUserGesture` 归因点击请求（点击后的后台请求也为 true），改用时间窗口。

## 调试入口

`npm run reload:ext` 需要 Chrome 的远程调试入口，且应在明确的加载范围内执行；配置和构建存在不证明运行版已经采用。

## 项目看板

`npm run dashboard`（[脚本](../../scripts/maintenance/dashboard.mjs)）生成 `out/dashboard/index.html`：一页给产品负责人看的静态 HTML。它只读仓库，不改远端。看板只是汇总视图，不替代 STATUS 与验收记录。

### 给用户看的进展（Linear）

进展只在 Linear 的 [By Your Side 项目](https://linear.app/yishuyuki/project/by-your-side-9d77250909c0)更新（10-04 用户决定，取代临时本机工作页 `127.0.0.1:8894`，其[验收](../evals/20261003-local-workbench.md)保留为历史）。状态含义：In Progress＝正在做；In Review＝已修好验证、尚未装进日常扩展，或需要用户亲手试；Done＝已装进日常扩展；Todo/Backlog＝排队。

每个任务按「以前 → 现在 → 没验到的」写，用产品语言，不写提交号与测试术语；技术证据只给仓库验收文档路径。用户要求充分展示：有可见变化时附实际截图或录屏（注明来源与场景），需要用户试的写清在哪试、怎样算好。阶段变化时在任务下补一句进展；装进日常扩展后才移到 Done。Linear 只做展示，项目事实仍以 [STATUS](../STATUS.md) 与验收记录为准。

### 分工与排期（Linear）

任务按标签分执行者（10-04 用户确认）：「Claude」主导拆任务、写完成标准、查根因、产品判断与最终验收；「Codex 可领」只给规格清楚、写明文件范围与检查命令的实现任务；「要你来」是需要用户亲手试、拍板或授权的事。Codex 用本机 CLI（已接 Linear），在单独的 git worktree 和分支里完成，交回后由 Claude 验收再合入 main；不与 Claude 同时改同一文件，浏览器验收由 Claude 错开安排。排期按 Linear 每周一个周期。

只存图的远端分支：`design-refs`（#53 引用）、`ux-walkthrough-1007`（#102–#106 引用）。issue 直接引用这些分支上的图片，删了会裂图；不合并，不再往上提交，引用它的 issue 都关闭后再删。10-07 用户确认删掉只被已关闭 issue 引用的 4 个分支（旧 issue 里的图从此裂开）。

## CI 与人工复核

- [Quality](../../.github/workflows/quality.yml)：PR 上跑 `check` 的各项。
- [Documentation](../../.github/workflows/docs.yml)：文档结构检查。
- [E2E](../../.github/workflows/e2e.yml)：手动触发，在 Linux 上跑 `npm test` 的用例。

维护者按 [PR 模板](../../.github/pull_request_template.md)复核。当前进度只在 [STATUS](../STATUS.md) 维护。评测环境分类见[浏览器证据](../testing/eval-environment.md)。
