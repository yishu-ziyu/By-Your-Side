# Pattern: 用 WAV 当假麦克风，要先关掉音频服务的沙箱

## 现象

`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>` 下，`getUserMedia` 能拿到音轨（标签是 “Fake Default Audio Input”），但内容是完全的静音（RMS 0）。不带这个文件参数时，默认假设备会发出蜂鸣，所以看上去像是“文件没被用上”，而不是“收音坏了”。

## 原因

音频服务运行在沙箱里，读不到这个文件。Chrome 只在自己的报错输出里说明：`Failed to read <wav> as input to the fake device. Try disabling the sandbox with --no-sandbox.`。WAV 放在桌面下还是系统临时目录里，结果一样，所以不是 macOS 的桌面权限问题。

## 方法

- 加 `--disable-features=AudioServiceSandbox`。只关音频服务的沙箱，不需要 `--no-sandbox`。（原写「或 `--disable-features=AudioServiceOutOfProcess`」；2026-09-23 仓库清理会话实测它仍然全静音，40 个采样全 0，已删。）
- `say -o x.wav --data-format=LEI16@24000` 直接产出的 WAV（带 `JUNK`/`FLLR` 块）可以用，不必重写文件头。
- 用一个已知的信号做判据，不要只看“有没有声音”：比如自己生成 660 Hz、振幅 0.5 的正弦波，检查主频和 RMS。本次测到主频 659 Hz（频率分辨率 2.93 Hz），关掉音频处理时 RMS 为 0.3537，理论值是 0.3536。默认假设备作对照组，它是 398/59 Hz 的间歇蜂鸣，能明确区分。
- 收集 Chrome 的报错输出（启动时把 stderr 接出来），出现静音时先搜 `fake device`。

## 适用条件

Chrome for Testing 149、`--headless=new`、macOS、扩展页用与产品同样的收音参数（回声消除、降噪、自动增益都开着，`sidepanel/voice-client.ts`），实测有效。

## 验证与来源

- [端到端测试基础设施小实验](../../../docs/evals/20260923-e2e-infra-probes.md) 第 4 节。第一次先猜是桌面权限，被“临时目录同样静音”否定了。
- 2026-09-23，本轮主代理。
- 复用：[仓库清理](../../../docs/evals/20260923-repo-cleanup.md) 阶段 6 的 `real-path/voice-page-question.mts`，已写进 `launchRealPath({ microphoneWav })`。那次没先查本页，又从“静音”重新排查了一遍——做语音 E2E 前先搜 index 里的 `audio`。
