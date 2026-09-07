# 任务: 将扩展与产品名称对齐 GitHub 仓库名重命名为 By Your Side

来源：2026-09-07 用户提供 `chrome://extensions` 页面截图，明确指示将 "SideAgent" 改名为 "By Your Side"（对齐 GitHub 仓库 `yishu-ziyu/By-Your-Side`）。

```
Change:     1. extension/manifest.json：name 与 action.default_title 改为 "By Your Side"。
            2. extension/sidepanel.html：页面 title 改为 "By Your Side"。
            3. extension/src/sidepanel/main.ts：顶栏 brand 文本与设置标题改为 "By Your Side"。
            4. extension/src/background/index.ts：右键上下文菜单项改为 "问 By Your Side"。
            5. shared/cast.ts & extension/src/content/cursor.ts：默认 Lead 名称与光标名牌改为 "By Your Side"。
            6. agent/src/prompt.ts：系统提示词身份声明对齐 "By Your Side"。
            7. scripts/install-host.mjs：伴随进程描述对齐 "By Your Side 伴随进程"。
            8. 单元测试同步更新并全量跑绿。
Not this:   内部包名及通信内部协议名保留（避免扰动 npm workspace 依赖）。
Evaluator:  机器：npm run typecheck、npm test、npm run build。
            人评：在 chrome://extensions 确认扩展名称显示为 "By Your Side"，侧栏顶栏显示 "By Your Side"。
Evidence:   本卡 + docs/NOTES.md + 单元测试。
```

## 完成标准

- [x] 1. 扩展清单与标题：`extension/manifest.json` 与 `sidepanel.html` 中名称统一更新为 "By Your Side" — 谁检查: `npm run build`
- [x] 2. 界面与上下文菜单：侧栏 topbar 品牌文本、设置标题、右键选单更新为 "By Your Side" — 谁检查: `npm run build`
- [x] 3. 角色名牌与系统提示词：`shared/cast.ts`、`cursor.ts`、`prompt.ts` 对齐 "By Your Side" — 谁检查: `npm test`
- [x] 4. 构建与回归测试：全量单元测试与构建全绿 — 谁检查: `npm test && npm run typecheck && npm run build`
- [x] 5. 真机可观测：Chrome 扩展管理面板名称显示为 "By Your Side" — 谁检查: 人（已通过 CDP 截图确认）

## 边界与不做

- npm workspace package 命名 `@sideagent/extension` / `@sideagent/agent` 与端口名等内部系统 ID 保留，不造成不必要的破坏性重命名。
