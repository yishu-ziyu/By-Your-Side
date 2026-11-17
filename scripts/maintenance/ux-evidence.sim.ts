import assert from "node:assert/strict";
import { test } from "node:test";
import { sortFindings, type Seen } from "./ux-evidence.mts";

const seen: Seen = {
  traceLines: ['{"type":"side_call","data":{"outcome":"failed","detail":"Your authentication token has expired."}}', '{"type":"agent_end"}'],
  screen: [
    { box: [0.38, 0.23, 0.5, 0.03], text: "翻译当前页面，只保留译文" },
    { box: [0.08, 0.31, 0.37, 0.02], text: "模型这次没有给出回答" },
    { box: [0.08, 0.34, 0.46, 0.02], text: "可以再试一次，或换个模型。" },
  ],
  timing: { secs: 41, checkSecs: 12, totalSecs: 53 },
};
const real = { experience: "等了 53 秒才看到结果", severity: "slows", evidence: [{ kind: "timing", field: "totalSecs", value: 53 }, { kind: "trace", line: 1, quote: "token has expired" }] };

test("证据都能在记录里找到的问题留下", () => {
  const { kept, dropped } = sortFindings([real, { experience: "没拿到译文，只看到出错", severity: "blocks", evidence: [{ kind: "screen", box: [0, 0.3, 1, 0.06], quote: "没有给出回答 可以再试一次" }] }], seen);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 0);
});

test("编造的证据让整条问题被丢掉", () => {
  const fakes = [
    { ...real, evidence: [{ kind: "trace", line: 99, quote: "token has expired" }] },
    { ...real, evidence: [{ kind: "trace", line: 2, quote: "token has expired" }] },
    { ...real, evidence: [{ kind: "screen", box: [0, 0, 1, 0.5], quote: "页面已翻译完成" }] },
    { ...real, evidence: [{ kind: "screen", box: [0.5, 0, 0.8, 0.5], quote: "为什么长文要留行距" }] },
    { ...real, evidence: [{ kind: "screen", box: [0, 0.8, 1, 0.1], quote: "模型这次没有给出回答" }] },
    { ...real, evidence: [{ kind: "timing", field: "totalSecs", value: 120 }] },
    { ...real, evidence: [real.evidence[0], { kind: "trace", line: 1, quote: "rate limited" }] },
    { ...real, evidence: [] },
    { ...real, severity: "minor" },
  ];
  const { kept, dropped } = sortFindings(fakes, seen);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, fakes.length);
});
