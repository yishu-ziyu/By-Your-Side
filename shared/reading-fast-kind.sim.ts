import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeReadingKindFast } from "./reading-fast-kind.js";

describe("judgeReadingKindFast", () => {
  it("recognizes Chinese and English street addresses immediately", () => {
    assert.deepEqual(judgeReadingKindFast("北京市朝阳区建国门外大街1号国贸大厦"), { decided: true, kind: "address" });
    assert.deepEqual(judgeReadingKindFast("1600 Amphitheatre Parkway, 123 Main St"), { decided: true, kind: "address" });
  });

  it("does not misclassify full sentences containing street words as addresses", () => {
    assert.deepEqual(judgeReadingKindFast("这条路走起来真远啊！"), { decided: false, fallback: "none" });
  });

  it("recognizes factual numeric claims immediately", () => {
    assert.deepEqual(judgeReadingKindFast("2025年新能源汽车渗透率超过 45%"), { decided: true, kind: "claim" });
    assert.deepEqual(judgeReadingKindFast("Revenue grew by 23.5 percent last quarter"), { decided: true, kind: "claim" });
  });

  it("defers ambiguous phrases to async model judgment", () => {
    assert.deepEqual(judgeReadingKindFast("量子纠缠与贝尔不等式"), { decided: false, fallback: "none" });
  });

  it("leaves road-like names, numbered lines and year-titled events to the model", () => {
    for (const text of ["丝绸之路", "电话区号", "车辆号牌", "杭州地铁1号线", "江墅铁路", "钱江国际时代广场", "杭州市行政区划图", "2018年世界短道游泳锦标赛", "1969年9月（57岁）", "¥23,010亿（全省第1位\n内地第8位）"]) {
      assert.deepEqual(judgeReadingKindFast(text), { decided: false, fallback: "none" }, text);
    }
  });

  it("still decides numbered street addresses and quantified statements at once", () => {
    assert.deepEqual(judgeReadingKindFast("解放东路18号"), { decided: true, kind: "address" });
    assert.deepEqual(judgeReadingKindFast("山地丘陵占65.6%，平原占26.4%，各类水体共占8%"), { decided: true, kind: "claim" });
  });

  it("returns decided none for empty or oversized selections", () => {
    assert.deepEqual(judgeReadingKindFast("   "), { decided: true, kind: "none" });
    assert.deepEqual(judgeReadingKindFast("a".repeat(301)), { decided: true, kind: "none" });
  });
});
