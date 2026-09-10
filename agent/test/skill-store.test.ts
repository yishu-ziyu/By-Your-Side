import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../src/skill-store.js";
import { compileSkill } from "../src/skill-compile.js";
import type { Skill } from "../../shared/skill.js";

const dirs: string[] = [];
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "sideagent-skills-"));
  dirs.push(dir);
  return { dir, store: new SkillStore(dir) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

function skill(id: string, hostname: string, now = 1_700_000_000_000): Skill {
  return compileSkill({ id, demoId: `demo-${id}`, intent: `${hostname} 上取数`, hostname, now, steps: [{ at: 0, kind: "click", anchor: { tag: "button", name: "筛选" } }] });
}

describe("技能存储", () => {
  it("写一份读一份，字段原样保留", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "www.example.com"));
    const back = await s.get("skill-a");
    expect(back?.hostname).toBe("example.com");
    expect(back?.steps).toHaveLength(1);
    expect(back?.program).toContain("resolveAnchor");
  });

  it("按站点取技能，不跨站复用", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    await s.put(skill("skill-b", "other.com"));
    expect((await s.findByHost("www.example.com")).map(x => x.id)).toEqual(["skill-a"]);
    expect((await s.findByHost("")).length).toBe(0);
  });

  it("忘记就是删掉，之后查不到", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    expect(await s.forget("skill-a")).toBe(true);
    expect(await s.forget("skill-a")).toBe(false);
    expect(await s.get("skill-a")).toBeUndefined();
  });

  it("更新抬版本，保留 createdAt", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    const next = await s.update("skill-a", { intent: "改过的目标" }, 1_800_000_000_000);
    expect(next?.version).toBe(2);
    expect(next?.createdAt).toBe(1_700_000_000_000);
    expect(next?.updatedAt).toBe(1_800_000_000_000);
  });

  it("坏文件不阻塞其他技能", async () => {
    const { dir, store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    await writeFile(join(dir, "broken.json"), "{ not json");
    expect((await s.list()).map(x => x.id)).toEqual(["skill-a"]);
  });

  it("非法 id 不写不读", async () => {
    const { store: s } = await store();
    await expect(s.put({ ...skill("skill-a", "example.com"), id: "../etc/passwd" })).rejects.toThrow();
    expect(await s.get("../etc/passwd")).toBeUndefined();
  });
});

describe("运行记录", () => {
  const run = (at: number, ok: boolean, extra: Partial<import("../../shared/skill.js").SkillRun> = {}) => ({ at, ok, elapsedMs: 1200, steps: 11, ...extra });

  it("追加、按顺序读回", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    await s.appendRun("skill-a", run(1, true));
    await s.appendRun("skill-a", run(2, false, { failedStep: 3, error: "第 3 步的目标在页面上找不到了" }));
    const runs = await s.listRuns("skill-a");
    expect(runs.map(r => r.at)).toEqual([1, 2]);
    expect(runs[1]).toMatchObject({ ok: false, failedStep: 3 });
  });

  it("超出上限只留最近若干条，文件不无限长", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    for (let i = 0; i < SkillStore.MAX_RUNS + 5; i += 1) await s.appendRun("skill-a", run(i, true));
    const runs = await s.listRuns("skill-a");
    expect(runs).toHaveLength(SkillStore.MAX_RUNS);
    expect(runs[0]!.at).toBe(5);
  });

  it("坏行跳过，不影响其他记录", async () => {
    const { dir, store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    await s.appendRun("skill-a", run(1, true));
    await writeFile(join(dir, "skill-a.runs.jsonl"), `{"at":1,"ok":true,"elapsedMs":1,"steps":1}\nnot json\n`, "utf8");
    expect((await s.listRuns("skill-a")).map(r => r.at)).toEqual([1]);
  });

  it("没有记录的技能返回空数组，不报错", async () => {
    const { store: s } = await store();
    expect(await s.listRuns("skill-never-run")).toEqual([]);
  });

  it("忘记技能时连运行记录一起删", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    await s.appendRun("skill-a", run(1, true));
    await s.forget("skill-a");
    expect(await s.listRuns("skill-a")).toEqual([]);
  });
});

describe("版本、回退与修订线索", () => {
  it("更新前把旧版本归档，回退能真的回到上一版", async () => {
    const { store: s } = await store();
    const first = skill("skill-a", "example.com");
    await s.put(first);
    expect(await s.hasPreviousVersion("skill-a")).toBe(false);

    const second = await s.update("skill-a", { intent: "改过的目标" });
    expect(second?.version).toBe(2);
    expect(await s.hasPreviousVersion("skill-a")).toBe(true);

    const back = await s.rollback("skill-a");
    expect(back?.version).toBe(3);
    expect(back?.intent).toBe(first.intent);
    // 回退之后仍然能再回退（回退本身也被归档）
    expect(await s.hasPreviousVersion("skill-a")).toBe(true);
  });

  it("没有上一版时回退返回空，不造一个假版本出来", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    expect(await s.rollback("skill-a")).toBeUndefined();
  });

  it("回退保留跑过的次数，不把历史抹掉", async () => {
    const { store: s } = await store();
    await s.put({ ...skill("skill-a", "example.com"), runCount: 7 });
    await s.update("skill-a", { intent: "第二版" });
    const back = await s.rollback("skill-a");
    expect(back?.runCount).toBe(7);
  });

  it("修订线索攒着但不抬版本", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    const noted = await s.addNote("skill-a", "  第一条应该点右边那个  ");
    expect(noted?.version).toBe(1);
    expect(noted?.notes?.map(n => n.text)).toEqual(["第一条应该点右边那个"]);
    const again = await s.addNote("skill-a", "金额要含税");
    expect(again?.notes).toHaveLength(2);
  });

  it("空线索不写，忘记技能时连版本一起删", async () => {
    const { store: s } = await store();
    await s.put(skill("skill-a", "example.com"));
    expect((await s.addNote("skill-a", "   "))?.notes).toBeUndefined();
    await s.update("skill-a", { intent: "第二版" });
    await s.forget("skill-a");
    expect(await s.hasPreviousVersion("skill-a")).toBe(false);
  });
});
