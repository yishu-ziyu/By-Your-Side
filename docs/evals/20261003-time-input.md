# 任务: 原生时间子框能填写完整时间，格式错误不清空原值

[当前状态](../STATUS.md) · [范围输入读数](../page-readouts.md)

## 完成标准

- [ ] 1. 真实 Chrome 时间框通过 CSS 与宿主 AX ref 填入 `9:30pm` 时拒绝操作；原值 `19:00`、焦点及 input/change 事件保持不变 — 谁检查: `page-readouts.mts`。
- [ ] 2. 真实原生 Hours/Minutes AX 子框 ref 填入 `18:15` / `19:30` 时，只修改所属时间 input；相邻时间框保持 `12:00` — 谁检查: `page-readouts.mts`。
- [ ] 3. 子框填写 `9:30pm` 时拒绝操作，所属时间 input 原值保留 — 谁检查: `page-readouts.mts`。
- [ ] 4. 清空时间、普通文字 `9:30pm`、有效时间、越界与 step 警告沿用现有契约 — 谁检查: `page-readouts.mts`。
- [ ] 5. 扩展逐次授权守卫仍有效，未批准操作不发生；不能用隔离执行器检查替代真实侧栏授权路径 — 谁检查: 主代理，安全确认真实路径及相关既有检查。

## 边界与不做

- 不把越界警告改成拒绝写入。`21:30` 仍写入并报告超出 `21:00`。
- 不按标签、坐标或邻近元素猜测子框所属 input。只沿解析节点的 shadow root 精确宿主识别原生时间框。
- 不改快照编号、对象身份核对、字段规则或逐次授权守卫。
- 不处理日期子框、其他输入类型的格式规则或真人主观体验。

## 实现与证据

2026-10-03：先在已有真实 Chrome 执行器验收脚本增加失败用例，再改 `input.ts`。子框沿 `getRootNode().host` 找所属 `input[type=time]`；填写前用脱离页面的原生时间 input 检查浏览器是否接受格式。CSS/DOM 回退路径也在填写前做同一格式检查。空字符串仍可清空。

实现子代理没有运行测试、构建或浏览器。以下真实 Chrome 运行由主代理执行；定点不等于整轮或日常路径验收。

### 定点失败历史与修订

- 第一轮：`out/acceptance/page-readouts-2026-10-03T04-43-37-797Z/`，初始 `open_tab` 因缺进行中的任务上下文失败。旧辅助执行器没有适配新授权规则，不是时间填写失败。脚本改为本地夹具初始化、提供任务上下文，并由真实侧栏逐次批准完整参数；未知卡拒绝。
- 第二轮：`out/acceptance/page-readouts-2026-10-03T04-46-43-328Z/`，9 PASS、2 FAIL。非法格式实际保留 `19:00`、焦点 `custname` 和空事件列表；原判据把对象键序不同误判失败，改为完整深比较。子框在取位置时被判离开文档，填值函数未运行；仅 fill 的位置读取增加精确时间宿主映射。
- 第三轮：`out/acceptance/page-readouts-2026-10-03T04-48-07-330Z/`，10 PASS、1 FAIL。Hours ref 588 已填写 `18:15`；此前快照的 Minutes ref 590 随原生 UA 子树刷新而离开文档。验收改为每次填写前重新 snapshot，仍限定第一时间框及对应 Hours/Minutes 角色，不放宽值、相邻控件或拒绝判据。原失败产物保留。
- 第四轮：`out/acceptance/page-readouts-2026-10-03T04-49-41-949Z/`，11 PASS、0 FAIL。真实原生子框、格式拒绝和现有范围契约的定点检查通过。整轮本地回归与最终截图待主代理运行。

`--live` 原执行链路未适配新的任务上下文，未测，不记通过。本地辅助执行器的真实侧栏批准，不等于真实 offscreen agent 的产品入口验收。

定点命令（过滤轮，不冒充整轮）：

```bash
npx tsx scripts/acceptance/page-readouts.mts --headless --only=range
```

回归命令：

```bash
npx tsx scripts/acceptance/page-readouts.mts --headless
node --import tsx scripts/acceptance/real-path/security-confirmation.mts --headless
```

脚本产物在 `out/acceptance/page-readouts-<时间>/`：`result.json`（含逐次确认 ID、完整参数与决定）、AX 快照和构建日志。子框连续快照保存在 `time-native-subfields*.txt`。本地子框最终为 `19:30` 且非法格式已拒绝后，保存真实夹具页 `time-native-subfields.png` 与真实扩展侧栏 `time-sidebar.png`。主代理统一运行、复核结果并补入实测证据。

## 全本地验收

`out/acceptance/page-readouts-2026-10-03T04-56-23-296Z/result.json`：14 PASS，0 FAIL，2 live题未跑；本地3项截断读数旧行为和11项范围/时间框全部通过。新截图已生成并查看：time-native-subfields.png显示目标19:30、相邻12:00，time-sidebar.png保留真实批准过程。日常dist未改变。

工程回归初次全单元3055 PASS/2 FAIL（旧桩无getRootNode方法）；改可选调用后29定点通过。下一轮3056 PASS/1 FAIL（Node桩没有HTMLInputElement全局）；改为按INPUT tag确认后读取原生类型，86项输入/授权/事件定点通过。没有删除原断言，也未新写单元测试；最终整轮由主代理另记。

最终工程整轮：`out/issue-42/tests-final-second.log` 3057单元+2规模PASS，`typecheck-final-final.log` PASS；没有跳过或移除原失败断言。

日常运行版已加载并核对实际源码及数据保留，见[部署](20261003-issue-fixes-deployment.md)。在线模型的两项未跑边界不因部署改记通过。
