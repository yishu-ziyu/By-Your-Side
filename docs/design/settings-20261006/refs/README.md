# 源码级参考（2026-10 抓取）

每个文件夹里的 `note.md` 写了 3 条观察：列表怎么排、状态怎么显示、详情怎么开。

| 参考 | repo @ commit | 关键文件 | 模式 | 截图 |
| --- | --- | --- | --- | --- |
| [Cherry Studio](cherry-studio/note.md) | CherryHQ/cherry-studio @ `50d69b6` | `src/renderer/pages/settings/ProviderSettings/ProviderList/*`、`components/ProviderListItem.tsx`、`primitives/classNames.ts` | 左栏 32px 行 + 绿点，右栏表单；同一家的多个版本合成一组 | [real-ui.png](cherry-studio/real-ui.png) |
| [LobeChat](lobe-chat/note.md) | lobehub/lobe-chat @ `d0ab946` | `src/features/Settings/provider/ProviderMenu/{List,Item}.tsx` | 左菜单分「已启用 / 未启用」，另有全部卡片网格 | [real-ui.png](lobe-chat/real-ui.png) |
| [Zed](zed/note.md) | zed-industries/zed @ `2a4326a` | `crates/settings_ui/src/pages/llm_providers_page.rs`、`crates/ui/src/components/ai/configured_api_card.rs`、`crates/agent_ui/src/language_model_selector.rs` | 一页平铺，已配置折成一行 ✓；模型选择器只列已连接的 | [real-ui.png](zed/real-ui.png) |
| [Raycast](raycast/note.md)（闭源） | manual.raycast.com | — | 按接入方式分组：默认模型 / 账号 / API key / 自定义 | [订阅](raycast/real-ui-subscriptions-crop.png) · [自定义](raycast/real-ui-custom-providers-crop.png) |
| [Chatbox](chatbox/note.md) | chatboxai/chatbox @ `0ac6385` | `src/renderer/components/settings/provider/{ProviderList,ProviderSpotlight}.tsx` | 只列在用的 + Spotlight 添加 | [real-ui.png](chatbox/real-ui.png) |
| [Jan](jan/note.md) | janhq/jan @ `b7f4f64` | `web-app/src/routes/settings/providers/index.tsx` | LOCAL / REMOTE 两段，行 = 名称 + N Models + 开关 | [real-ui.png](jan/real-ui.png) |
| [Cline](cline/note.md) | cline/cline @ `cd80a20` | `apps/cline-hub/src/webview/src/components/views/settings/provider-list-view.tsx` | 细线列表 +「N available · M enabled」 | 无 |
| [Open WebUI](open-webui/note.md) | open-webui/open-webui @ `8bd8b4f` | `src/lib/components/admin/Settings/Connections.svelte`、`src/lib/components/chat/ModelSelector/Selector.svelte` | 按协议列连接地址；一个搜索框搜模型 | 无 |

拼页：[参考 1](page-refs-1.png) · [参考 2](page-refs-2.png) · [D/E/F 默认](page-variants.png) · [G 与交互](page-variants-2.png) · [保存后](page-variants-3.png)
