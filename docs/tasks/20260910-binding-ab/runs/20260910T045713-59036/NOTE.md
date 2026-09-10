# 工具链伪批次（非对照样本）

本目录由 `run-ab.mjs` 的 `--preflight-only` 标志解析 bug 误建（应识别为 `--preflight-only`，当时写成 `--preflightOnly`），**0 个对照样本**。
其中 `index.json` 记录的 `aborted.reason="preflight_failed"` 是真实的：本 worker 沙箱连 tsx 的 IPC 都建不起来（`listen EPERM … tsx-501/<pid>.pipe`），预检必然失败。
bug 已修：`--preflight-only` 现在只做预检、不创建批次目录（见 `analysis-live.md` 的离线验证）。本目录不参与选型，也不计入 18 次对照。
