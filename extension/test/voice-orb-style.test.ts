/**
 * docs/evals/20261007-voice-orb-styles.md R1（不认识的值按默认）、R3（视频光球的播放参数）。
 *
 * 先列出会出错的方式：
 * S1 存储里是旧值、空值或任意字符串时，光球报错或空白，而不是按暮色显示。
 * S2 默认样式不是暮色。
 * S3 视频光球在某个状态下低于 1 倍速（30 帧 0.35 倍速时肉眼明显发卡），或快过 1.45 倍。
 * S4 四个状态里有两个看起来一样（播放速度、亮度、起伏都相同），用户分不出在听还是在说。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ORB_STYLE, ORB_STYLES, parseOrbStyle } from "../../shared/voice.js";
import { videoOrbLook } from "../src/shared/orb-style.js";

const STATES = ["idle", "listening", "thinking", "speaking"] as const;

describe("voice orb style setting", () => {
  it("defaults to dusk and falls back to it for unknown stored values (S1, S2)", () => {
    expect(DEFAULT_ORB_STYLE).toBe("dusk");
    expect(ORB_STYLES.map(style => style.id)).toEqual(["dusk", "dawn", "particles"]);

    for (const stored of [undefined, null, "", "sky", 3, { id: "dawn" }]) expect(parseOrbStyle(stored)).toBe("dusk");

    expect(parseOrbStyle("dawn")).toBe("dawn");
    expect(parseOrbStyle("particles")).toBe("particles");
  });
});

describe("video orb look per state", () => {
  it("never plays below 1x or above 1.45x, whatever the voice level (S3)", () => {
    for (const state of STATES) {
      for (const level of [0, 0.5, 1]) {
        for (const t of [0, 0.3, 1.7]) {
          const { rate } = videoOrbLook(state, level, t);
          expect(rate).toBeGreaterThanOrEqual(1);
          expect(rate).toBeLessThanOrEqual(1.45);
        }
      }
    }
  });

  it("keeps the four states apart (S4)", () => {
    const looks = STATES.map(state => videoOrbLook(state, 0.6, 0.5));
    const keys = looks.map(look => `${look.rate.toFixed(2)}/${look.brightness.toFixed(2)}/${look.scale.toFixed(3)}`);
    expect(new Set(keys).size).toBe(4);
    // 待机最安静：不放大、不提亮、原速。
    expect(videoOrbLook("idle", 0, 0)).toEqual({ rate: 1, brightness: 1, scale: 1 });
  });
});
