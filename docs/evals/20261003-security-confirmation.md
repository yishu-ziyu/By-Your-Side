# 任务：网页副作用默认逐次确认

关联：[#37](https://github.com/yishu-ziyu/By-Your-Side/issues/37)、draft [#38](https://github.com/yishu-ziyu/By-Your-Side/pull/38)。候选版本，不代表日常扩展已更新。

## 完成标准

- [x] 普通/未知点击、导航、填写、JS等潜在副作用默认要求精确参数的一次侧栏批准；公开JS包括固定探针，snapshot/元素读取/截图均需批准；其原MAIN读取已迁移ISOLATED，原生标签清单等豁免。
- [x] 20秒过期、拒绝、重复批准、任务/控制轮次变化及页面指纹变化均不发放有效授权。
- [x] 页面标记、模型伪造fromUserConfirm、原始键鼠/拖放和raw CDP不能发放授权。
- [x] 真实Chromium扩展路径：副作用服务器计数、侧栏确认、同文档字段变化、reload、JS及键盘/CDP旁路验收全部通过。
- [ ] 独立最终审查与GitHub CI完成，产品频繁确认行为经过维护者验收。

## 先失败，再实现

先提交activation-policy/held ledger反例，再实现；随后先提交activation-consent的一次性、拒绝、超时、页面变化用例，再接入宿主。取消版本回归确保等待页面指纹期间停止任务不会复活请求。原输入测试补真实documentId桩，保留原行为断言。

## 实现与产品影响

权威边界在[协议](../protocol.md#安全)。background持有单次票据，只有本扩展sidepanel.html端口能批准。审批绑定任务、控制轮次、完整参数、documentId、控制generation、DOM变更轮次、原生DOMSnapshot全部覆盖frame的backend节点/字段及markup摘要；参数预览先去凭据文本。无法绑定页面或完整展示参数时拒绝。保留CSV所用JS，但每次需批准；普通点击、填写、导航、snapshot/元素读取/截图也增加确认。公开持有/释放键鼠与拖放暂时禁用，内部停止仍释放输入。未知或未覆盖的子框架拒绝。获准fetch不自动跟随未展示的新URL重定向。所有准备await后、实际native/CDP/script派发前再检查；上传首次设置前核对完整状态，固定对象的后续事件仅沿同文档/控制generation/取消版本/期限阶段批准完成，避免自身字段变更误拒绝。

页面定位滚动、hover或脚本已派发后发生撤销，回执保守为unknown，不把缺少最终mousePressed伪报零副作用。ISOLATED读取避免网站MAIN getter执行。

网页可在最终检查后异步变化，指纹不是网站事务锁；批准任意JS不能保证其内部副作用可撤回。此版本承诺未经可信批准不进入副作用工具，不能承诺网站动态内容的交易级原子性。

## 实际验证

本地npm ci --ignore-scripts通过。基线lock缺@esbuild/linux-ppc64@0.28.2，本次仅补17行，无升级版本。npm test：295文件/3051单元测试通过（最终收紧redirect及派发标记前），随后42项dispatch/键鼠定点通过，scale 2测试通过；typecheck通过；architecture 293生产文件通过；check:docs --base a55c69d通过，639文档零错误。合并main的会话菜单更新后再交独立审查。

标准npm run build被本环境tsx CLI的Unix socket EPERM阻断；临时改用node --import tsx启动同一导出脚本后构建通过，提交不包含临时替换。本机Chromium下载返回空ZIP；此前0d72cd5在Ubuntu CI37040997521实际构建和辅助真实Chrome验收通过。后续69439a工程、辅助Chrome与真实日常入口均通过，证据见下；最新head检查见PR。

新增security-confirmation CI固定官方Actions提交SHA及lock内playwright 1.58.2，在Ubuntu执行原始npm ci、typecheck、完整测试、docs、build及真实扩展脚本。脚本用本地POST计数器独立验证未批准零提交、批准仅一次、字段变化及导航作废、JS批准保留和键盘/CDP拒绝，上传JSON与侧栏截图。还通过真正real-path脚本从设置页配置本地脚本模型，经真实offscreen agent、用户侧栏发送任务与审批验证拒绝/允许/再次审批/停止；不使用sw工具入口hook。这是本地脚本模型验收，不是供应商或真人eval。最终检查与独立审查状态以PR为准。

## 交付边界

真实浏览器验收已通过；独立最终审查通过后才合并并关闭#37，状态见PR。不包含日常扩展发布或供应商/真人验收。

## 2026-10-03 日常入口续验

用户授权继续至北京时间02:50。acd65d7的CI37043875299工程检查与辅助Chrome均通过，但真实日常入口在Chrome启动阶段超时，cases0、POST0，不能视为功能验收。real-path harness缺少隔离验收已有的Linux no-sandbox参数；此轮沿用该参数并将spawn失败/stderr写入启动错误，以真实日常链路重新验证，不延长等待或弱化断言。

69439a在[CI37047373719](https://github.com/yishu-ziyu/By-Your-Side/actions/runs/37047373719)全部工程检查与两个Chrome入口通过。真实日常脚本模型四项PASS：拒绝0POST、允许恰1POST、再次独立审批、Stop撤销；artifact11244648666含截图与JSON，SHA256488d1cd4e7654e96b67144d57c6b3a19041aa3f3adcd3da98aeb153a3a226d8b。后续文档校正不改安全实现，最新CI/独立审查/合并状态见PR38，避免历史报告冒充当前head。

独立复核发现批准的异步页面核对期间再拒绝曾被deciding短路忽略；先写反例1FAIL，修复后6项broker检查PASS。拒绝/超时优先于重复批准闸门；异步结果只完成仍在pending且取消版本未变的原请求。新head将重跑完整工程与两个真实Chrome入口，结果以PR为准。

文件选择器arm_event经capture准备await后也在enabled:true原生派发前复核批准；反例旧5项中1FAIL，补guard后通过。失败只撤销本次已开始的拦截，enabled:false内部清理仍可执行；待完整CI重验。
