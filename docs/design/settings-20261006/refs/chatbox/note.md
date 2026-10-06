# Chatbox
- repo: chatboxai/chatbox @ 0ac6385 (2026-09-24)
- files: src/renderer/components/settings/provider/{ProviderList,ProviderSpotlight}.tsx; src/renderer/routes/settings/provider/route.tsx
- screenshot: real-ui.png (docs.chatboxai.app/en/guides/providers, small-screen list)
1. 列表：只列「已激活 + 自定义 + 少量推荐」，不铺全部；行 = 32px 图标 + 名称（小屏：分隔线 + 右侧 chevron）。
2. 状态：已激活 = 行尾 8px 绿色 Indicator；当前打开的 = 品牌色文字 + 品牌浅底。
3. 底部「+ 添加」打开 Spotlight：顶部搜索，分组「常用 / 更多服务商 / 自定义（添加自定义、从剪贴板导入）」，24px 图标 + 名称。
