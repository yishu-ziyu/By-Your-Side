# Cline (cline-hub webview)
- repo: cline/cline @ cd80a20 (2026-10-06)
- files: apps/cline-hub/src/webview/src/components/views/settings/provider-list-view.tsx; add-provider.tsx
- screenshot: none（新界面，文档无图）
1. 列表：大标题下一行计数「N available · M enabled」，右上搜索按钮（点开才出现搜索框）+ 深色「Add provider」。
2. 行：无卡片，border-b 细线分隔，min-h-44；名称 17px 粗 + 右侧「N models」灰字 + 开关 + chevron。
3. 选中行 bg-accent/45；详情页另开（ProviderDetailContent：key、模型搜索、复制模型 id）。
