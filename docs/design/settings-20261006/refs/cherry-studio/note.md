# Cherry Studio
- repo: CherryHQ/cherry-studio @ 50d69b6 (2026-10-04)
- files: src/renderer/pages/settings/ProviderSettings/ProviderList/{ProviderList,ProviderListContent,ProviderListGroup,ProviderListSearchField,ProviderListHeaderFilterMenu,providerGrouping,providerFilterMode}.tsx/.ts; primitives/classNames.ts (providerListClasses); ProviderSetting.tsx
- screenshot: real-ui.png (from CherryHQ/cherry-studio-docs @ 7431ed4 .gitbook/assets/cherry-v2-model-provider-zh-cn.png)
1. 列表：左栏 32px 行（h-8, rounded-10, 26px 头像, gap 10px），顶部 32px 搜索框 + 筛选图标（全部/已启用/已停用），底部「+ 添加服务商」。
2. 状态：已启用 = 行尾 6px 绿点（hover 换成 ⋯）；选中 = bg-muted + 字重 500；同一 preset 的 ≥2 家折成一组（chevron 旋转 90°，组里有启用的显示绿点）。
3. 详情：右栏标题 + 右上开关；API 密钥（眼睛 + 钥匙 + 检测）、API 地址、模型按系列分组折叠。
