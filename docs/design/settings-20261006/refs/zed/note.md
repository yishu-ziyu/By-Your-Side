# Zed
- repo: zed-industries/zed @ 2a4326a (2026-10-06)
- files: crates/settings_ui/src/pages/llm_providers_page.rs (render_provider_section / render_provider_header / render_api_key_providers_item / render_subpage_item); crates/ui/src/components/ai/configured_api_card.rs
- screenshot: real-ui.png (PR zed-industries/zed#63248 showcase, LLM Providers page)
1. 列表：没有列表，一页平铺。每家一段：14px 灰图标 + 等宽小号灰名称 + 淡分隔线（首段 pt-4，其后 pt-8）。
2. 状态：没填 = 左侧「API Key」+ 去控制台链接说明（最多半宽），右侧输入框，回车即保存；已填 = ConfiguredApiCard（✓ 绿勾 + 'API Key Configured' + 右侧 '↺ Reset Key'），登录 = '✓ Signed in as …' + 'Sign Out'。
3. 右上「+ Add Provider」弹出菜单（Compatible APIs: OpenAI / Anthropic）；复杂的家用「Configure ›」进子页。不标当前模型（模型在 Agent 面板里选）。
