# 产品记录

这里保存 By Your Side 为什么改变、改变了什么，以及支持这些判断的证据。供自己回看，也供后续写产品介绍、更新说明和宣发材料。

**先打开 [可视化总览](index.html)。** 当前能力与下一步仍以 [STATUS](../STATUS.md) 为准；这里保留每个时点的理解和实测记录。

| 内容 | 固定位置 |
|---|---|
| 有前后证据的优化 | [optimizations](optimizations/2026-10-31-startup/README.md)：问题、改法、实测、图、适用范围 |
| 你的产品理解 | [perspectives](perspectives/2026-10-31-speed-and-effort.md)：原话、当时的判断、后来如何变化 |
| 未来方向与跟进 | [directions](directions/README.md)：待验证问题、验证结果、决定 |

## 第一条记录

[Optimization 001：重载后，更快回到对话](optimizations/2026-10-31-startup/index.html)。图表由原始五次测量重新计算，不手填百分比。案例内附可直接引用的短文案与测试条件。

## 后续怎样积累

- 优化：在 `optimizations/YYYY-MM-DD-主题/` 保存 `record.json` 和原始证据；写清用户变化、前后负载、统计口径、验证与未验证范围。完成后运行 `npm run product:build`，重算图、案例和总览。
- 产品理解：从 [理解记录模板](templates/perspective.md) 新建一篇。用户原话与整理者理解分开；旧判断保留，新判断链接旧篇，不把现在的认识写成一直如此。
- 未来方向：先记录要验证的问题。验证后链接实际结果，再写继续、调整或放弃；未来想法不当作现有功能宣传。
- 对外引用：带上图中的实验条件。保留全部样本；“中位数缩短”不能改写成“每一次都更快”。技术定位与本机路径不放入宣传图。

## 文件与导出

`record.json` 是案例说明，`evidence/` 是归档原件。`README.md`、`index.html`、`exports/summary.svg`、`exports/samples.svg` 与 PNG 由脚本生成；不要手工改生成的数字。

SVG 随版本保存，PNG 留在案例的 `exports/`，需要时可重新生成。生成器使用 Python 3 与 `requirements.txt` 中的绘图库；本机已可直接运行。新机器可用独立环境安装依赖，再运行构建命令。

这里不自动收集私人会话，不自动发布。截图仍遵循项目素材约定；当前案例的图只使用隔离实验数据。
