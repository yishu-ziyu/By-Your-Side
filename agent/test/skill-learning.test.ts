import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillLearningTrace } from "../src/skill-learning.js";
import { autoSkillEligible } from "../src/skill-learning.js";
import { SkillStore } from "../src/skill-store.js";
import { parseClientMessage, parseServerMessage } from "../../shared/protocol.js";
import { learningFixture, searchEvidence, skillPage, target } from "./fixtures/skill-evidence.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function storeFixture() { const root = await mkdtemp(join(tmpdir(), "bys-candidates-")); roots.push(root); return { root, store: new SkillStore(root) }; }

describe("verified run to pending candidate", () => {
  it("extracts three real steps and a verified output, not old refs or input values", () => {
    const candidate = learningFixture().candidate();
    expect(candidate).toBeTruthy();
    expect(candidate.skill.steps).toHaveLength(3);
    expect(candidate.skill.inputs).toEqual({ 客户名: "", 地区: "" });
    expect(candidate.skill.requestTemplate).toBe("搜索「{{客户名}}」，地区「{{地区}}」");
    expect(candidate.skill.check).toMatchObject({ inputKey: "客户名", expect: { property: "textContent", contains: "{{客户名}}" } });
    expect(JSON.stringify(candidate)).not.toMatch(/张三|北京|@1|@2|nth-child/);
    expect(candidate.evidence.toolCallIds).toEqual(["step-1", "step-2", "step-3", "step-4"]);
  });
  it("does not learn a failed task", () => { const { trace } = learningFixture(); expect(trace.finish("run-one", false)).toBeNull(); });
  it("does not attribute a proof to a new run", () => { const { trace } = learningFixture(); expect(trace.finish("replacement", true)).toBeNull(); });
  it("requires browser actions, not just an answer", () => { const trace = new SkillLearningTrace(); trace.begin("r", "你好", skillPage); expect(trace.finish("r", true)).toBeNull(); });
  it("does not equate a button's existence with completion", () => {
    const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
    searchEvidence().slice(0, 3).forEach(event => trace.observe(event));
    trace.observe({ toolCallId: "button", name: "read_element", params: { target: "@3" }, result: target("搜索", "button") });
    expect(trace.finish("r", true)).toBeNull();
  });
  it("a fresh write invalidates the preceding completion proof", () => {
    const { trace } = learningFixture(); trace.observe(searchEvidence()[2]!); expect(trace.finish("run-one", true)).toBeNull();
  });
  it.each(["js", "navigate", "type_text"] as const)("does not omit unsupported %s effects", name => {
    const { trace } = learningFixture(); trace.observe({ toolCallId: "unknown", name, params: {}, result: {} }); expect(trace.finish("run-one", true)).toBeNull();
  });
  it.each(["发送", "支付", "删除", "购买", "Save", "Submit"])("does not learn irreversible control %s", name => {
    const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
    const events = searchEvidence(); events[2]!.target = target(name, "button"); events.forEach(event => trace.observe(event));
    expect(trace.finish("r", true)).toBeNull();
  });
  it("does not learn password fields or a masked credential", () => {
    const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
    const events = searchEvidence(); events[0]!.target = target("密码", "input", "password"); events.forEach(event => trace.observe(event)); expect(trace.finish("r", true)).toBeNull();
  });
  it("does not learn a step with unknown outcome even when a later read succeeds", () => {
    const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
    const events = searchEvidence(); events[1]!.error = "RPC outcome unknown"; events.forEach(event => trace.observe(event)); expect(trace.finish("r", true)).toBeNull();
  });
  it("rejects a document change and does not bind another page's proof", () => {
    const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
    const events = searchEvidence(); (events[3]!.result as { documentId: string }).documentId = "replacement";
    events.forEach(event => trace.observe(event)); expect(trace.finish("r", true)).toBeNull();
  });
  it("cancellation prevents learning", () => { const { trace } = learningFixture(); trace.cancel(); expect(trace.finish("run-one", true)).toBeNull(); });
  it("recovers learning after a failed read only when a fresh proof arrives", () => {
    for (const freshProof of [false, true]) {
      const { trace, events } = learningFixture();
      trace.observe({ toolCallId: "bad-read", name: "read_element", params: {}, error: "invalid expect" });
      if (freshProof) trace.observe(events[3]!);
      expect(!!trace.finish("run-one", true)).toBe(freshProof);
    }
  });
  it("a check of the first field cannot conceal a wrong second field", () => {
    const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
    const events = searchEvidence(); (events[3]!.result as { textContent: string }).textContent = "客户：张三；地区：深圳";
    events.forEach(event => trace.observe(event)); expect(trace.finish("r", true)).toBeNull();
  });
  it("a host-owned read-only poll failure can be followed by a genuine successful readback", () => {
    const { trace, events } = learningFixture();
    trace.observe({ toolCallId: "poll", name: "js", params: {}, error: "invalid CSS reference",
      origin: "readonly-poll" });
    trace.observe(events[3]!);
    expect(trace.finish("run-one", true)).not.toBeNull();
  });
  it("a snapshot only proposes a unique live result read; its text alone cannot create a candidate", () => {
    for (const text of ['[ref=8] status "查询结果"', '[ref=8] status "结果一"\n[ref=9] status "结果二"', '[ref=8] textbox "客户名"']) {
      const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
      searchEvidence().slice(0, 3).forEach(event => trace.observe(event));
      const read = trace.observe({ toolCallId: "snapshot", name: "snapshot", params: { tabId: 7 }, result: { tabId: 7, text } });
      if (text === '[ref=8] status "查询结果"') expect(read).toEqual({ tabId: 7, target: "@8", properties: ["textContent"] });
      else expect(read).toBeUndefined();
      expect(trace.finish("r", true)).toBeNull();
    }
  });
  it("allows initial selection of the task page but not a different page", () => {
    for (const [tabId, valid] of [[7, true], [8, false]] as const) {
      const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
      trace.observe({ toolCallId: "select", name: "switch_tab", params: { tabId }, result: { tabId } });
      searchEvidence().forEach(event => trace.observe(event));
      expect(!!trace.finish("r", true)).toBe(valid);
    }
  });
  it("derives a check only from a real result containing all current materials", () => {
    for (const [textContent, valid] of [["客户：张三；地区：北京", true], ["客户：王五；地区：北京", false], ["客户：张三；地区：上海", false]] as const) {
      const trace = new SkillLearningTrace(); trace.begin("r", "搜索「张三」，地区「北京」", skillPage);
      const events = searchEvidence(); delete events[3]!.params.expect;
      events[3]!.result = { ...target("查询结果", "div"), textContent };
      events.forEach(event => trace.observe(event)); expect(!!trace.finish("r", true)).toBe(valid);
    }
  });

  it("a query-only workflow is never auto-reusable until its deliverable contract is confirmed", () => {
    const narrow = learningFixture().candidate()!;
    // 默认（还没做语义判断）不自动复用；只有学习收尾确认"做法覆盖整条要求"后才置位。
    const unverified = { ...narrow.skill } as typeof narrow.skill;
    delete (unverified as { learnedOutputContractVersion?: unknown }).learnedOutputContractVersion;
    expect(autoSkillEligible(unverified)).toBe(false);
    expect(autoSkillEligible(narrow.skill)).toBe(true);
  });

  it("does not treat a request with an extra deliverable as a complete reusable contract", () => {
    const trace = new SkillLearningTrace();
    trace.begin("run-extra", "搜索「李四」，地区「深圳」，并告诉我会员等级", skillPage);
    searchEvidence("李四", "深圳").forEach(event => trace.observe(event));
    const candidate = trace.finish("run-extra", true)!;
    // 步骤与凭证仍然是可编译的，但整条要求多出"告诉我会员等级"，学习收尾不会给它可自动复用的资格。
    expect(candidate.skill.requestTemplate).toBe("搜索「{{客户名}}」，地区「{{地区}}」，并告诉我会员等级");
    expect(autoSkillEligible(candidate.skill)).toBe(false);
  });
});

describe("same store, explicit promotion and deduplication", () => {
  it("pending proposals are never executable until explicit confirmation", async () => {
    const { store } = await storeFixture(), candidate = learningFixture().candidate();
    expect(await store.propose(candidate)).toBe(true); expect(await store.list()).toEqual([]); expect(await store.findByHost("example.com")).toEqual([]);
    expect(await store.listCandidates("example.com")).toHaveLength(1); expect(await store.listCandidates("other.example")).toEqual([]);
    await expect(store.saveCandidate(candidate.skill.id, "stale-source")).rejects.toThrow(); expect(await store.list()).toEqual([]);
    await store.saveCandidate(candidate.skill.id, candidate.sourceRunId); expect(await store.list()).toHaveLength(1); expect(await store.listCandidates()).toEqual([]);
  });
  it("deduplicates concurrent completed runs and different materials", async () => {
    const { store } = await storeFixture();
    const one = learningFixture().candidate(), two = learningFixture("李四", "深圳", "run-two").candidate();
    expect(two.skill.id).toBe(one.skill.id);
    const accepted = await Promise.all([store.propose(one), store.propose(two)]); expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(await store.listCandidates()).toHaveLength(1);
  });
  it("does not keep suggesting a dismissed recipe", async () => {
    const { store } = await storeFixture(), candidate = learningFixture().candidate();
    await store.propose(candidate); await store.dismissCandidate(candidate.skill.id, candidate.sourceRunId);
    expect(await store.listCandidates()).toEqual([]); expect(await store.propose(learningFixture("李四", "深圳").candidate())).toBe(false);
    await expect(store.saveCandidate(candidate.skill.id, candidate.sourceRunId)).rejects.toThrow(); expect(await store.list()).toEqual([]);
  });
  it("repeated save never overwrites a newer user-edited version", async () => {
    const { store } = await storeFixture(), candidate = learningFixture().candidate();
    await store.propose(candidate); await store.saveCandidate(candidate.skill.id, candidate.sourceRunId);
    const existing = (await store.get(candidate.skill.id))!; await store.put({ ...existing, version: 2, name: "用户修订" });
    expect(await store.saveCandidate(candidate.skill.id, candidate.sourceRunId)).toMatchObject({ version: 2, name: "用户修订" });
  });
  it("run history contains facts, not runtime return values or sensitive errors", async () => {
    const { store, root } = await storeFixture(), candidate = learningFixture().candidate(); await store.put(candidate.skill);
    await store.appendRun(candidate.skill.id, { at: 1, ok: false, elapsedMs: 10, steps: 1, error: "secret-runtime-value", value: "private-value" } as never);
    const files = await import("node:fs/promises").then(fs => fs.readdir(root));
    const history = await readFile(join(root, files.find(name => name.includes("runs"))!), "utf8");
    expect(history).not.toMatch(/secret-runtime-value|private-value/);
  });
});

describe("candidate wire boundaries", () => {
  it("requires a real stored proposal identity, not uploaded program bytes", () => {
    expect(parseClientMessage(JSON.stringify({ type: "skill_candidate_save", requestId: "req", id: "candidate", sourceRunId: "run" }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "skill_candidate_save", requestId: "req", id: "../escape", sourceRunId: "run" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "skill_candidate_save", requestId: "req", id: "candidate" }))).toBeNull();
  });
  it("validates pending candidate payloads and rejects malformed server lists", () => {
    const candidate = learningFixture().candidate();
    const message = { type: "skill_result", requestId: "req", action: "list", ok: true, skills: [], candidates: [candidate] };
    expect(parseServerMessage(JSON.stringify(message))).not.toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...message, candidates: [{}] }))).toBeNull();
  });
});
