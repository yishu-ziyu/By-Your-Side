# 任务：网页副作用默认逐次确认

关联：[#37](https://github.com/yishu-ziyu/By-Your-Side/issues/37)、draft [#38](https://github.com/yishu-ziyu/By-Your-Side/pull/38)。候选版本，不代表日常扩展已更新。

## 完成标准

- [x] 普通/未知点击、导航、填写、JS等潜在副作用默认要求精确参数的一次侧栏批准；明确读取原语豁免。
- [x] 20秒过期、拒绝、重复批准、任务/控制轮次变化及页面指纹变化均不发放有效授权。
- [x] 页面标记、模型伪造fromUserConfirm、原始键鼠/拖放和raw CDP不能发放授权。
- [ ] 真实Chromium扩展路径：副作用服务器计数、侧栏确认、同文档字段变化、reload、JS及键盘/CDP旁路验收全部通过。
- [ ] 独立最终审查与GitHub CI完成，产品频繁确认行为经过维护者验收。

## 先失败，再实现

先提交activation-policy/held ledger反例，再实现；随后先提交activation-consent的一次性、拒绝、超时、页面变化用例，再接入宿主。取消版本回归确保等待页面指纹期间停止任务不会复活请求。原输入测试补真实documentId桩，保留原行为断言。

## 实现与产品影响

权威边界在[协议](../protocol.md#安全)。background持有单次票据，只有本扩展sidepanel.html端口能批准。审批绑定任务、控制轮次、完整参数、documentId及DOM变更轮次及完整markup/表单字段的SHA-256；参数预览先去凭据文本。无法绑定页面或完整展示参数时拒绝。保留CSV所用JS，但每次需批准；普通点击、填写、导航也增加确认。原始键鼠与拖放暂时禁用，输入释放只走持有台账。

网页可在最终检查后异步变化，指纹不是网站事务锁；批准任意JS不能保证其内部副作用可撤回。此版本承诺未经可信批准不进入副作用工具，不能承诺网站动态内容的交易级原子性。

## 实际验证

本地npm ci --ignore-scripts通过。基线lock缺@esbuild/linux-ppc64@0.28.2，本次仅补17行，无升级版本。npm test：290文件/3018单元测试通过，scale 2测试通过；typecheck通过；architecture 291生产文件通过；check:docs --base a55c69d通过，639文档零错误。合并main的会话菜单更新后再交独立审查。

标准npm run build被本环境tsx CLI的Unix socket EPERM阻断；临时改用node --import tsx启动同一导出脚本的构建结果另行记录，提交不包含临时替换。Chromium下载在本环境返回空ZIP，真实浏览器验收未运行，不能算通过。

新增security-confirmation CI在Ubuntu执行原始npm ci、typecheck、完整测试、docs、build及真实扩展脚本。脚本用本地POST计数器独立验证未批准零提交、批准仅一次、字段变化及导航作废、JS批准保留和键盘/CDP拒绝，上传JSON与侧栏截图。CI结果未返回前不宣称完成。

## 交付边界

保持draft及#37打开，不合并/发布。真实浏览器验收、独立最终审查与频繁确认体验尚需通过。
