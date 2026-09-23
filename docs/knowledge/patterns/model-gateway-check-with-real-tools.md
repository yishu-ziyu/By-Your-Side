# Pattern: 新接的模型要带真实工具列表验，400 时二分请求体

## 现象

`cliproxy/mimo-v2.6-flash` 接入后，纯对话请求正常；一到浏览器任务，每次请求都是 400 `Invalid request parameters`，重试无效。错误里没有指明是哪个字段。

## 原因

指针工具（hover、click、drag、wheel、mouse_down/up、html5_drag）的坐标参数用了 `Type.Tuple([Type.Number(), Type.Number()])`，它生成的 JSON Schema 里 `items` 是数组（元组写法）。这个网关不接受这种写法，只要工具列表里有一个，就把整条请求拒掉。接入时的检查只发了不带工具的对话，所以没发现。

## 方法

- 接新模型或新网关时，用产品真实的工具列表（本例 48 个工具）至少发一次请求，而不是只发“你好”。
- 遇到笼统的 400：先用本地转发器把真实请求体录下来（去掉鉴权头），再逐步删掉工具或字段二分，定位到最小的那个 schema。
- 坐标这类定长数组，改用 `{type:"array", items:{type:"number"}, minItems:2, maxItems:2}`，TypeScript 端用 `Type.Unsafe<[number, number]>(...)` 保留静态类型；pi-ai 用标准 JSON Schema 校验参数，行为等价。

## 适用条件

2026-09-23 实测 MiMo V2.6 Flash 经本地 CLIProxyAPI 池子。其他网关是否同样拒绝元组 schema 未验证。

## 验证与来源

- [第一条真实路径样板用例](../../../docs/evals/20260923-real-path-first-case.md)「范围追加」：修前两次运行都是 400，修后同样 48 个工具返回 200，样板用例 3 次通过。
- 2026-09-23，本轮主代理。
