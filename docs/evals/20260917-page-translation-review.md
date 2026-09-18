# 任务：复核并修复翻译执行事实和重复字体恢复

## 完成标准

- [x] 标签页解析失败为 not_executed，注入异常/无回执仍不宣称未执行。— 谁检查：定点单测、隔离生产扩展
- [x] 原字体恢复后网站增删空 style，再次宋体/原字体恢复匹配本轮之前 DOM；覆盖同时调整字号。— 谁检查：隔离无头 Chrome
- [x] 原有双语、链接、完整恢复保持，状态日期和发布范围准确。— 谁检查：浏览器脚本、主代理

## 边界与不做

主代理直接执行；保留已有工作树改动，不重载日常扩展、不提交发布。不重跑模型翻译或声学验收。

## 复现与修复

- P1 属实：新增单测两种标签页解析失败均缺少 executionFact；旧生产构建中关闭 tab 后调用 begin 得到 unknown。将参数检查和 resolveWorkingTab 一并纳入注入前 catch，executeScript 仍在 catch 外，保留注入异常和缺失回执的未知语义。
- P2 属实：旧生产构建在“无 style → 宋体 → 原字体 → 网站新增空 style → 宋体 → 原字体”中误删网站新增属性。restoreFamily 在字号和字体都恢复后释放 hadStyles，下一轮重新采样；同轮字号/字体共享基线保持。
- 最初新增浏览器用例漏做 collect，实际没有译文；补上 collect 和宋体 computedStyle 断言后才得到上述有效失败。另一个测试草稿传 null 字号被接口拒绝，已改为公开支持的模式切换恢复路径；没有修改生产接口适配测试。
- STATUS 日期更新为 2026-09-17，并明确区分前一天已推送内容与本地未提交修复。

## 结果与证据

- 相关 27 项单测通过，包含标签页解析失败、注入拒绝、缺失回执、页内事实和既有翻译流程。
- 隔离无头生产扩展通过原有错误/双语/链接/精确恢复，以及四组网站 style 增删与字号组合；实际关闭标签页后得到 not_executed，随后有效标签页调用成功。结果见 [浏览器记录](20260917-page-translation-review/browser-results.json)。
- TypeScript、184 个生产文件模块边界检查、构建通过。未重复全仓单测、规模测试、模型在线翻译或发布套件；不引用外部 review 的运行结果冒充本轮验证。
- 生产改动只扩展原有注入前异常边界，并释放已有快照，无新依赖或状态。原因与适用边界已由代码、回归和本文说明，无需额外经验文档。

复跑：`npx vitest run extension/test/page-translation-executor.test.ts agent/test/page-translation.test.ts`；构建后 `npx tsx scripts/acceptance/page-translation-reliability.mts --headless --out=docs/evals/20260917-page-translation-review`。
