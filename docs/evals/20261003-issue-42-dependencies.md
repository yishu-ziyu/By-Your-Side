# 任务：清除已知依赖告警，保留扩展授权与 Pi 功能

关联：[#42](https://github.com/yishu-ziyu/By-Your-Side/issues/42)。基线 `2f95cbf`。

## 完成标准

- [ ] 官方 npm audit 从干净 npm ci 树返回零告警，两个 Undici 解析路径均为修复版本。— 检查者：npm 与锁文件检查
- [ ] Pi 版本与现有 Session/资源加载 API 不变，Node SDK 请求和资源加载继续工作。— 检查者：实际 SDK 调用与已有测试
- [ ] 真实隔离扩展：拒绝不提交、批准只提交一次、停止撤销；网页与回答可渲染。— 检查者：现有真实浏览器验收
- [ ] 类型、原有测试、隔离构建、文档同步通过。— 检查者：项目命令

## 边界与不做

仅升级 DOMPurify/Undici/brace-expansion 的补丁版；不使用 audit fix --force，不升级 Pi 主版本，不改全局 npm 配置，不重载日常扩展。独立 PR 与发布另计，不以公告匹配证明已复现产品攻击。

## 修改前证据

`out/issue-42/audit-before-official.json`：官方审计4项受影响依赖（low1/moderate1/high2）。镜像审计404，原失败保存在 `out/issue-42/audit-before.json`；审计命令显式指定官方 registry，不写 npm 配置。

可能失败：仅修直接 Undici 遗漏 Pi 内实例；override 范围过宽；缺平台可选包导致干净安装失败；SDK 请求/资源 glob 或 DOM 消毒行为改变；逐次确认拒绝/批准/停止边界失效。保留这些判据，失败不关闭 Issue。

## 本轮结果与用户决定

2026-10-03 用户选择“分开处理，继续产品修复”。本轮只升级直接 DOMPurify 3.4.16、Undici 8.10.2；Pi 0.84.4 与其 SDK API 保留。Pi 内依赖另做可重复补丁方案，#42不关闭。

- 干净 `npm ci --registry=https://registry.npmjs.org --replace-registry-host=always --maxsockets=1` 通过：`out/issue-42/npm-ci-partial-final.log`。仅命令级源与并发参数，全局配置未变。
- 最终官方审计：`out/issue-42/audit-final-partial.json`，low0/moderate1/high2，仍3项。`dependency-tree.txt`同时确认直接补丁与Pi内 Undici8.9.0/brace-expansion5.0.9，不能用根锁文件替代实际安装树。
- 失败实验：Pi自带 npm-shrinkwrap；定点override、删嵌套锁条目、直接改根锁条目都不能使干净npm ci保留替换。纯锁解析曾报0告警，但实际安装重现3项，前者不是通过证据。无效override与手改嵌套记录已移除。已检查0.86.0、0.87.1、1.0.0包内锁，仍有brace-expansion5.0.9；没有升级或引入重打包。
- 新Undici真实本地HTTP请求通过：`undici-smoke.json`。Pi SDK真实Session/工具写入与重新打开通过：`pi-write.json`/`pi-read.json`，仅首次执行一次外部动作，恢复未重放。
- 实际扩展设置→offscreen→侧栏授权路径4项通过：`out/security-confirmation/real-path/result.json`，拒绝零POST、批准恰一次、再次独立批准与停止撤销。只用本地脚本模型，不冒充供应商验收。

## 不可信输入可达性

DOMPurify三处产品入口接模型/网页字符串并调用sanitize；侧栏/文件页的afterSanitizeAttributes只补链接属性，没有IN_PLACE或删除节点hook组合。仍升级直接依赖，不依赖这项静态结论抵消公告。

Pi Node的http-dispatcher使用Client/Pool/EnvHttpProxyAgent；未找到本项目BalancedPool、自定义共享缓存。Pi的模型匹配、包资源加载确有minimatch调用，pattern来自Node配置/包路径，未发现网页文字直接作为pattern的产品路径。浏览器构建仍以shim替换Node循环，不运行其Node资源加载。未执行攻击性利用实验，不将未发现前置条件写成无风险。

官方依据：[DOMPurify公告](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p)、[Undici补丁](https://github.com/nodejs/undici/releases/tag/v8.10.2)、[brace-expansion公告](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr)。

共同候选工程整轮：3057单元+2规模、类型、模块边界通过；构建由真实扩展验收隔离生成。日常dist保持原版本；发布门槛未跑，Pi嵌套依赖目标未完成。
