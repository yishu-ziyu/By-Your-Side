# 任务: 模型选择改到输入区（原件板 1+2+3）

来源：2026-09-04 用户在原件板上选了 1、2、3——输入区短名 chip（Arek/Claude），点开为搜索 + 按厂商分组（Phi/LobeChat）。

## 验收标准
- [x] 1. 顶栏状态只显示连接（绿点 +「已连接/未连接/连接中」），不再拼接 `provider/modelId`，模型名不出现在顶栏 — evaluator: 无头截图断言 DOM（`/tmp/model-picker-shots/light-closed.png`，status=`已连接`）
- [x] 2. 输入区（composer）左下有模型 chip：展示名（`name`，去掉 provider 前缀），不是 raw id；无模型列表时隐藏 — evaluator: 单测 chipLabel + 无头截图（chip=`MiniMax-M3`）
- [x] 3. 点 chip 向上弹出菜单：顶部搜索框、按 provider 分组、每项左侧色点字母标、当前项勾选；搜索过滤 name/id/provider — evaluator: 单测 filterModels + 无头截图（`light-open.png` / `light-search.png`）
- [x] 4. 选择即发 `set_model`，仍等 agent 回 `model_info` 更新 chip；点外部 / Escape 关闭 — evaluator: 代码走查（不改协议）
- [x] 5. 暗色模式与窄栏（约 360px）不溢出；`prefers-reduced-motion` 无新增必动动画 — evaluator: 无头暗色截图 `dark-open.png` + CSS 走查（picker 无新增 animation）
- [x] 6. typecheck / build / 全部测试绿 — evaluator: npm run typecheck && npm run build && npm test（150）

## 边界与不做
- 不做 Instant/High 档位、不做滑杆、不做属性卡网格
- 不做 Auto 路由开关、不做 thinking effort
- 不做厂商官方 logo 资源（用字母色标）
- 不改 set_model 协议与凭据管理
- 教学模式开关仍在顶栏，本期不改
