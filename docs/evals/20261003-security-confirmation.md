# 任务：提交先停下，确认只批准刚才那一步

关联问题：[#37](https://github.com/yishu-ziyu/By-Your-Side/issues/37)。候选分支，不代表用户日常扩展已更新。

## 完成标准

- [ ] 已知提交、订票和购买控件在真实扩展里无确认不派发 — 谁检查：无头扩展验收。
- [ ] 用户在侧栏确认后原动作恰好执行一次；无待确认、过期和页面重载均不放行 — 谁检查：真实扩展验收。
- [ ] 页面脚本、回车/空格、低层指针与raw CDP不能绕过本候选策略 — 谁检查：定点测试与真实扩展验收。
- [ ] 任意自定义控件、同文档表单内容变更及其他事件路径有完整业务授权 — 谁检查：后续设计与真实验收；本次未完成。

## 先列失败，再实现

新增activation-policy用例先提交，覆盖任意JS、伪造readonly、mouse_down、drag/html5_drag、Enter/Space，随后实现。已有held ledger用例先改成无pending不能arm；新增booking labels反例后再扩大识别。

## 实现与产品影响

权威边界只在[协议安全边界](../protocol.md#安全)维护。沿用原有held点击UI，不新增模型安全判官；已知文案之外增加原生form submit判定。保留普通有名字的点击与读取；任意JS、拖放和键盘提交暂时拒绝，所以部分数据提取和交互能力收窄。页面名牌确认需转到侧栏。确认重放绑定documentId与60秒期限，读取不到documentId时拒绝。

## 验证证据

2026-10-03：在scratch用Node24内置stripTypeScriptTypes加载本次真实policy/effect/mark/held源码，26项独立断言通过；同时转换input/index TypeScript语法无错误。检查只覆盖策略输出与台账状态，不验证Chrome派发和类型正确性。未运行仓库Vitest、typecheck、check:docs、build或真实浏览器验收，均为未跑，不算通过。

待CI/维护者执行：`npx vitest run extension/test/activation-policy.test.ts extension/test/held-clicks.test.ts extension/test/mark-actions.test.ts extension/test/click-integrity.test.ts`、`npm run typecheck`、`npm run check:docs -- --base origin/main`及扩展构建。需特别评估旧测试中缺失documentId或页面名称的桩，以及JS提取/拖放功能回归。

## 交付边界

本次仅部分加固，不关闭#37。普通自定义按钮、填写事件、快捷键、同文档目标/表单改变、GET和导航副作用仍未全覆盖；真实浏览器验收未通过前保留draft，不合并或发布。
