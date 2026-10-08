# 经验：验收框架默认挑最新的 Chrome for Testing，新装的一版可能整体不能用

## 现象

2026-10-07 凌晨，真实路径用例和评测接连在 `Page.navigate` 超时，main 原代码也一样。最小探针在只装扩展的无头 Chrome 里打开本机页和 example.com，两个都 30 秒超时。

## 根因

01:40 机器上多了 `chromium-1243`（来源未查清，可能是某次依赖安装带进来的）。
验收框架在 `~/Library/Caches/ms-playwright` 里挑版本号最高的 Chrome for Testing，于是所有用例都换到 1243。同一探针指定 1228 后，本机页 64 毫秒、外部页 0.6 秒打开。

## 方法

- 用例成批在「打开网页」这一步失败，先用最小探针（打开本机页）判断是不是浏览器本身的问题，再查产品。
- 用 `EGO_ACCEPTANCE_CHROME` 指定已知可用的版本；比较前后结果时两边用同一版本。
- 查「新装了什么」：`ls -lt ~/Library/Caches/ms-playwright/`。

## 适用条件

用 `scripts/acceptance/real-path/harness.mts` 启动浏览器的验收和评测（`eval/harness` 也经过它）。

## 验证

指定 1228 后，真实路径用例和阶梯评测恢复，失败用例都能在 main 上对照复现。见[底座升到 Pi 1.0](../../evals/20261007-pi1-rebuild.md)。
