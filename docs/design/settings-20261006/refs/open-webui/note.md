# Open WebUI
- repo: open-webui/open-webui @ 8bd8b4f (2026-09-21)
- files: src/lib/components/admin/Settings/Connections.svelte; Connections/OpenAIConnection.svelte; AddConnectionModal.svelte
- screenshot: none（文档里没有设置页图，渲染 Svelte 成本高，未截）
1. 列表：按协议分段（OpenAI API / Ollama API / Direct Connections），段标题右侧开关。
2. 每条连接 = 一行无边框的 URL 文本 + 齿轮按钮，点齿轮弹出 AddConnectionModal 编辑 key/前缀/模型白名单。
3. 不按品牌列服务商，按地址列；适合自建网关，不适合 BYS 的 36 家品牌。
