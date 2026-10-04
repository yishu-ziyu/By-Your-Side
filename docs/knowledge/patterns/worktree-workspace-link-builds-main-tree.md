# Pattern: 在 git 工作树里构建旧版本，打包进去的却是主仓库的新代码

## 现象

为了证明新验收脚本能抓住旧问题，在 `git worktree` 里检出改动前的 `HEAD`，把主仓库的 `node_modules` 链过去再跑真实路径用例。旧代码本该失败，却通过了，读数与新代码几乎一样。

## 原因

npm workspaces 把 `node_modules/@sideagent/agent` 做成指回主仓库 `agent/` 的符号链接。扩展的 offscreen 入口经 `@sideagent/agent/browser-core` 导入任务核心，esbuild 顺着链接打包的是主仓库（新代码），只有扩展自身文件来自工作树。

## 方法

- 工作树里建真目录 `node_modules`，其余条目逐个链到主仓库，`@sideagent/*` 改链到工作树自己的 `agent/`、`extension/`。
- 先在旧代码里加一行日志，用 `watchInproc()` 读到它，确认跑的确实是旧代码，再拿反例结论。

## 适用条件

用 npm workspaces、且构建经包名导入同仓库源码时；单包仓库或相对路径导入不受影响。

## 验证与来源

- [删减验收](../../evals/20261004-cut-unused.md)「技术前提」：修正链接前旧代码误通过，修正后同脚本在旧代码上失败（回答与空闲都在核对放行之后）。
- 2026-10-04，本轮主代理。
