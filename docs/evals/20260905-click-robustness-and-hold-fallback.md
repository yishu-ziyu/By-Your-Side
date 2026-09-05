# 任务: 点击健壮性防御与就地确认拿住兜底

> 来源：2026-09-05 实测 ChatGPT 归档操作中暴露的后台失败链路：
> 1. DOM 回退解析时 `callDom` 吞掉页面内抛错返回 `null`，导致 `click` 裸抛 `Cannot read properties of null (reading 'x')`。
> 2. 危险词表缺失 `归档` / `archive`，导致该类不可逆或重要隐藏操作未纳入就地确认拦截。
> 3. 模型仅调用 `mark` 且未显式带 `actions`，但向用户声称“光标已停在按钮上”；实际页面光标仍停留在角落原位 `(24, 24)`，名牌未出确认双键。
> 4. `liveAnchor` 在 AX ref 场景下无法通过 `dom.resolve` 重新解析，导致滚动或重布局时拿住态光标被误置为 `hidden`。

## 完成标准

- [x] 1. **`click`/`fill` 绝不裸抛 `reading 'x'`** — 谁检查: `npm test`（`click-robustness.test.ts`）
  - 当 `backendNodeId` 失效且 DOM 路径未找到元素或抛出异常时，`callDom` 必须向外抛出真实的明确错误（如 `未找到目标元素` / `ref @N 已失效`），绝不能返回 `null` 导致 `targetRect.x` 访问崩溃。
  - 在 `input.ts` 的 `click` 与 `fill` 中对 `targetRect` 增加保护断言，即使页面返回异常也抛明确业务错误。
- [x] 2. **危险操作词表覆盖 `归档` / `archive`** — 谁检查: `npm test`（`mark-actions.test.ts`）
  - `isDestructiveLabel("归档")` 与 `isDestructiveLabel("Archive")` 均返回 `true`。
  - `confirmLabelForDestructive("Archive")` / `("归档")` 返回 `"归档"`。
- [x] 3. **`mark` 语义兜底拿住** — 谁检查: `npm test`（`mark-actions.test.ts` + `click-robustness.test.ts` + `overlay-check.mjs`）
  - 当调用方调用 `mark` 时若未传 `actions`，但 `label` 命中确认意图（以 `待` 开头如 `待归档`、`待删除`、`待确认`，或 label 本身命中危险词），自动推导对应 actions（如 `[{ id: "confirm", label: "归档" }, { id: "cancel", label: "取消" }]`），光标同步触发 `holdInst` 拿住并展示名牌双键，杜绝“说停了但光标没动”。
- [x] 4. **拿住态锚点容错不丢失** — 谁检查: `node extension/test/overlay-check.mjs`
  - 处于 `holding` 拿住态时，若元素无法解析为 liveAnchor（例如 AX 树 ref 或无连接元素），光标不得直接隐藏（`inst.el.classList.add("hidden")`），必须保持在当前目标中心位置显示拿住手势与双键。
- [x] 5. **提示词同步** — 谁检查: `npm test`（`safety-prompt.test.ts`）
  - `agent/src/prompt.ts` 明确将 `archive` / `归档` 纳入危险操作与直接点击就地确认的范畴。
- [x] 6. **全量回归全绿** — 谁检查: `npm run typecheck` && `npm test` && `npm run build` && `node extension/test/overlay-check.mjs` && `git diff --check`

## 边界与不做

- 不改动现有通信协议帧结构（`shared/protocol.ts` 保持不变）。
- 不破坏普通无确认意图的普通标注展示（例如 `mark({ target, label: "关注这里" })` 不会误触发拿住态）。
