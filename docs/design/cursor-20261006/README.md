# 点击光标缩到 20px（2026-10-06 定稿）

用户选定 **20px**。形状、颜色、描边、名牌、点击波纹都不变，只缩小。

- 现在：`CURSOR_SVG_SIZE = 35`，在 `extension/src/shared/cursor-visual.ts`（main `eb4aeed`）。
- 改法：`cursor-size-20.diff`（4 个文件，35px 时数值与现在完全相同）。
- 来源：[#56 定稿评论](https://github.com/yishu-ziyu/By-Your-Side/issues/56#issuecomment-6002987801)。

## 打开原型

`bys-cursor-proto.html` 单文件，用 file:// 打开，不联网，不发送任何东西。

- `?size=20`（默认）、`?size=35` 看现在的样子；也有 18、19。
- `?debug` 显示目标点红十字；`?reduced` 模拟「减少动态效果」；`?clean` 去掉选择器和对照卡。
- 光标用的是仓库真实的 `extension/src/content/cursor.ts`（esbuild 打包，只把尺寸常量换成读网址参数）。演示只调真实接口：beginAction → move → endAction。

## 文件

- `shots/final-35-vs-20.png`：定稿页（现在 35 / 选定 20 / macOS 箭头对照，同一倍率）。
- `shots/hotspot-4x.png`：落点放大，红十字是目标点。
- `shots/label-fill-20.png`、`shots/send-20-reduced-motion.png`：名牌可读、减少动态。
- `videos/compare-2x.mp4`：35 / 18 / 19 / 20 同时播放，2x。`videos/cursor-20.mp4`、`cursor-35.mp4`：单段。

macOS / OpenAI 箭头是重绘示意，不是系统原图。
