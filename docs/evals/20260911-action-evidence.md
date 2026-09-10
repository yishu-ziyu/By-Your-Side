# 任务：动作回执带效果证据（P0-2 回合经济第二步，click 切片）

用户 2026-09-11 批准按架构评审的 P0 顺序推进；本文件是本步实施前冻结的标准。

**目标（用户可观察）**：点完之后不再只得到「已点击」。回执必须回答「页面动没动」，并且只把能归因到这次点击的变化算数；没有反应时明说可能原因，模型不必再花一轮 snapshot 才能发现静默失败。

**范围**：`extension/src/shared/effect.ts`（新，纯函数）、`extension/src/content/effect.ts`（新，页面侧采集）、`extension/src/background/exec/effect.ts`（新，后台接线与早停）、`extension/src/background/exec/input.ts`（click 接入）、`shared/protocol.ts`（click 回执契约）、`agent/src/tools.ts`（回执文案）。fill / type_text / press_key 留到下一轮。

**参照**：huashu-chrome（MIT）的「效果证据」实现（`extension/content.js` 的 `baselineOf` / `doEffect`，2026-09-11 审阅）。取舍与差异见本文末。

## 完成标准

- [x] 1. click 回执带 `effect:{changed,evidence[],weak[],volatile,alerts[]}`；`changed` 只由强证据决定。 — 谁检查: npm test（`extension/test/effect.test.ts` 纯函数）
- [x] 2. 强证据：目标元素移除、目标状态字段变化（value/checked/selected/expanded/disabled/class）、目标区块节点数变化、目标区块渲染文本变化、body 直接子元素增减、新增页面提示。弱证据：全局 DOM 节点数、全局正文长度、焦点变化；弱证据只展示不参与 `changed`。 — 谁检查: npm test（同上）
- [x] 3. 页面自身在动（`volatile`，60ms 内 DOM 节点数变化 ≥3）时，只有强证据算数，且回执说明「页面本身在持续变化」。 — 谁检查: npm test（同上）
- [x] 4. 焦点落到被点击元素自己不算证据（点击的机械后果）；焦点移到别的元素算弱证据。 — 谁检查: npm test（同上）
- [x] 5. 早停：出现强证据立即返回；无证据最多等 600ms（100ms 轮询）。 — 谁检查: npm test（`extension/test/effect-settle.test.ts`，注入时钟）
- [x] 6. 模型可见回执：有变化时给变化清单，无变化时给「操作已发出，但页面没有可归因的反应」并提示不要盲目重试；`held` 点击仍走原路径且不采集效果。 — 谁检查: npm test（`agent/test/click-effect-text.test.ts`）
- [x] 7. 执行事实、控制闸门、坐标守卫、落点复核、光标行为不变；全量测试、typecheck、build 通过。 — 谁检查: `npm run typecheck && npm test && npm run build`（144 文件 1238 项；click-integrity 全绿）
- [x] 8. 真实路径：真实页面上点击返回效果证据（有反应/无反应两类）— 谁检查: 人（隔离 harness，3 次运行；有反应 = `paused false → true`，无反应 = 首版假阴性已修，见结果表）

## 边界与不做

- 不把完整新快照塞进动作回执（快照体积是 P0-3 的事）；本轮只回变化证据。
- 不覆盖 fill / type_text / press_key / hover / scroll（下一轮同机制扩展）。
- 不因效果证据改变执行事实（`executed` / `unknown` / `not_executed`）语义：无反应也可能是副作用在别处，回执只描述页面观测。
- 密码/验证码类字段值不进效果证据（沿用现有 `value: <N 位>` 约定）。

## 与参照实现的差异（保留判断依据）

| 点 | huashu-chrome | 本轮做法 | 理由 |
|---|---|---|---|
| 证据来源 | 页面侧 baseline/doEffect，100ms 轮询 | 同 | 直接可用 |
| 元素身份 | 快照 ref 表（`refMap`） | 点击落点处 `elementFromPoint` + 后台持有的同一点 | 我们的 `@ref` 是 CDP backendNodeId，页面侧不认识；落点才是真实事件接收者 |
| 焦点证据 | 焦点落在目标自己不算 | 同（按落点元素判断） | 这条不加会让「零证据」永不触发 |
| 全局文本 | 弱证据，阈值 4 字 | 同（阈值 4） | 假阴性=多一次幂等重试，假阳性=带着错误前提继续 |
| 敏感字段 | `value: <N 位>` | 沿用我们已有的脱敏约定 | — |
| 提交型动作 | 批处理不代做 | 不在本轮（我们已有 held click 闸门） | 控制权设计不同 |

## 结果

### 机器检查

- `npm test`：144 文件 1238 项通过（新增 `extension/test/effect.test.ts` 19 项、`agent/test/click-effect-text.test.ts` 5 项）。
- typecheck、build 通过（`extension/dist/content-effect.js` 7.5kb）。
- 接入后 `click-integrity` 全 21 项通过：首版 `beginEffect` 在页面侧未确认时也给 token，导致假计时器下空转；改为**必须拿到页面侧 ack 才返回 token**（拿不到就跳过效果证据）。这条也是生产需要的：内容脚本没注入/版本不符时不能把「没采集」当成「没变化」。

### 真实路径（隔离 harness，MiniMax-M3）

| 运行 | 结果 | click 耗时 | 回执 |
|---|---|---:|---|
| 接入前 | PASS | 855ms | 无效果证据 |
| 首版（仅有 DOM/文本/属性证据） | PASS | 1206ms（未早停，等满 600ms） | 「Nothing on the page changed」——**假阴性**：原生 video 控件点击只改 `paused` 属性，DOM、文本、class 都不变 |
| 加媒体状态 + 目标文本后 | PASS | **601ms**（有证据立即返回） | `Page reacted: paused false → true.` |

三个真实运行暴露并修掉的缺陷：

1. **页面侧未确认也给 token**（见上，机器与真实路径都会踩）。
2. **假阳性风险的另一面——假阴性**：只比 DOM 结构和节点数，看不到「JS 状态变了但页面没重绘」。目标是媒体元素时补采 `paused/ended`，目标文本变化也纳入强证据（按钮改名「暂停 → 播放」是最常见的一类真实反应）。
3. 元素身份用**点击落点**解析（`elementFromPoint`）。原生控件、shadow DOM 内部按钮会解析到宿主元素（如 `<video>`），这比按定位串重新查找更接近真实接收者，也正是媒体属性成了关键证据的原因。

### 未跑 / 未决

- 无反应时的最坏代价是等满 600ms（本产品此前没有固定等待，所以这是净增）。真实样本里早停场景反而比改前快（601ms < 855ms），但无反应场景的预算是否该收到 400ms 还没测；留作下一轮样本。
- fill / type_text / press_key / hover / scroll 未接入（同机制扩展）。
- 效果证据的「页面自己也在动」样本（弹幕/行情页）未在真实站点上验过，目前只有合成单测。
- 本轮未提交、未推送、未重载扩展。
