# LobeChat / LobeHub
- repo: lobehub/lobe-chat @ d0ab946 (2026-10-06)
- files: src/features/Settings/provider/ProviderMenu/{index,List,Item,All,SearchResult}.tsx; (list)/ProviderGrid/{index,Card,EnableSwitch,style}.tsx
- screenshot: real-ui.png (lobehub.com/docs/usage/providers/deepseek, 'Enter DeepSeek API Key in LobeHub')
1. 列表：左栏顶部搜索 + 「+」，第一项「全部」，下面手风琴分段「已启用 / 自定义 / 未启用」（12px 次要色段名，可排序）。
2. 状态：22px 方形图标 + 名称，已启用行尾 Badge success 绿点；选中 = NavItem active 底色。
3. 「全部」页 = 卡片网格（24px 组合 logo、两行描述、分隔线、启用开关）；详情页 = 表单行（左标签+说明，右输入）+ 连通性检查 + 模型列表。
