/**
 * 技能存储：一份技能一个原子文件（与 experience/memory 同一套做法）。
 *
 * 约定：
 *   - 目录 0700、文件 0600；先写临时文件再 rename，避免半截文件；
 *   - 技能按 hostname 作用域查找，不跨站复用；
 *   - 忘记 = 删文件，调用方负责同时停止引用（与记忆一致：删了就不再被检索到）。
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { normalizeSkillHost, validSkillId, type Skill, type SkillRun } from "../../shared/skill.js";

/**
 * 归档文件名的匹配式。用普通字符串拼，不用模板字符串——
 * 模板字符串里的 `\.` 会变成 `.`，`\d` 会变成字面 d，正则于是永远匹配不上（真机上踩过）。
 */
function versionPattern(id: string): RegExp {
  const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + safe + "\\.v(\\d+)\\.json$");
}

export class SkillStore {
  constructor(private readonly directory: string) {}

  /** 运行记录上限：够看趋势，又不让文件无限长。 */
  static readonly MAX_RUNS = 200;

  private path(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  private runsPath(id: string): string {
    return join(this.directory, `${id}.runs.jsonl`);
  }

  async put(skill: Skill): Promise<void> {
    if (!validSkillId(skill.id)) throw new Error("技能 id 非法");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(skill.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(skill), { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async list(): Promise<Skill[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const skills: Skill[] = [];
    for (const name of names.filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n))) {
      const skill = await this.read(join(this.directory, name));
      if (skill) skills.push(skill);
    }
    return skills.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Skill | undefined> {
    if (!validSkillId(id)) return undefined;
    return this.read(this.path(id));
  }

  async forget(id: string): Promise<boolean> {
    if (!validSkillId(id)) return false;
    const existing = await this.get(id);
    if (!existing) return false;
    await rm(this.path(id), { force: true });
    await this.forgetRuns(id);
    await this.forgetVersions(id);
    return true;
  }

  /** 同一站点的技能；未限定站点的技能不下发给别的站点。 */
  async findByHost(hostname: string): Promise<Skill[]> {
    const host = normalizeSkillHost(hostname);
    if (!host) return [];
    return (await this.list()).filter(skill => skill.hostname === host);
  }

  /**
   * 追一次运行记录。append-only，读回来只给最近 MAX_RUNS 条；
   * 单条记录很小，但仍然不让文件无限增长。
   */
  async appendRun(id: string, run: SkillRun): Promise<void> {
    if (!validSkillId(id)) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(this.runsPath(id), `${JSON.stringify(run)}\n`, { mode: 0o600 });
    const runs = await this.listRuns(id);
    if (runs.length > SkillStore.MAX_RUNS) {
      const keep = runs.slice(-SkillStore.MAX_RUNS).map(run => JSON.stringify(run)).join("\n") + "\n";
      await writeFile(this.runsPath(id), keep, { mode: 0o600 });
    }
  }

  async listRuns(id: string): Promise<SkillRun[]> {
    if (!validSkillId(id)) return [];
    try {
      const text = await readFile(this.runsPath(id), "utf8");
      const runs: SkillRun[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as SkillRun;
          if (typeof parsed?.at === "number" && typeof parsed.ok === "boolean") runs.push(parsed);
        } catch { /* 坏行跳过，不拖垮整个技能 */ }
      }
      return runs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async forgetRuns(id: string): Promise<void> {
    if (!validSkillId(id)) return;
    await rm(this.runsPath(id), { force: true });
  }

  private async forgetVersions(id: string): Promise<void> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch { return; }
    await Promise.all(names
      .filter(name => versionPattern(id).test(name))
      .map(name => rm(join(this.directory, name), { force: true })));
  }

  /**
   * 更新内容并抬版本。抬版本前把当前这一版原样归档，
   * 回退时才能真的回到上一版，而不是"重新编译一遍"。
   */
  async update(id: string, patch: Partial<Pick<Skill, "steps" | "inputs" | "check" | "program" | "name" | "intent">>, now = Date.now()): Promise<Skill | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    await this.archive(existing);
    const next: Skill = { ...existing, ...patch, version: existing.version + 1, updatedAt: now };
    await this.put(next);
    return next;
  }

  /** 记一条修订线索：来自用户当场纠正或跑完反馈，不改内容，先攒着。 */
  async addNote(id: string, text: string, now = Date.now()): Promise<Skill | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const trimmed = text.trim().slice(0, 300);
    if (!trimmed) return existing;
    const notes = [...(existing.notes ?? []), { at: now, text: trimmed }].slice(-20);
    const next: Skill = { ...existing, notes, updatedAt: now };
    await this.put(next); // 线索不算新版本：改的是"待办"，不是做法
    return next;
  }

  /** 回退到上一版：内容取归档里的最近一份，版本继续往前抬，历史不乱。 */
  async rollback(id: string, now = Date.now()): Promise<Skill | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const archived = await this.latestArchived(id);
    if (!archived) return undefined;
    await this.archive(current);
    const restored: Skill = {
      ...archived,
      version: current.version + 1,
      updatedAt: now,
      runCount: current.runCount,
      ...(current.lastRunAt === undefined ? {} : { lastRunAt: current.lastRunAt }),
      ...(current.notes ? { notes: current.notes } : {}),
    };
    await this.put(restored);
    return restored;
  }

  /** 有没有可回退的版本（面板据此决定按钮要不要出现）。 */
  async hasPreviousVersion(id: string): Promise<boolean> {
    return Boolean(await this.latestArchived(id));
  }

  private versionsPath(id: string, version: number): string {
    return join(this.directory, `${id}.v${version}.json`);
  }

  private async archive(skill: Skill): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.versionsPath(skill.id, skill.version);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(skill), { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** 最近归档的一份（版本号最大）；够回退用，不做 git。 */
  private async latestArchived(id: string): Promise<Skill | undefined> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch { return undefined; }
    const versions = names
      .map(name => versionPattern(id).exec(name))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map(m => Number(m[1]))
      .filter(n => Number.isInteger(n))
      .sort((a, b) => b - a);
    for (const version of versions) {
      const skill = await this.read(this.versionsPath(id, version));
      if (skill) return skill;
    }
    return undefined;
  }

  private async read(path: string): Promise<Skill | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Skill;
      if (!validSkillId(parsed?.id) || !Array.isArray(parsed.steps) || typeof parsed.program !== "string") return undefined;
      return parsed;
    } catch {
      return undefined; // 坏文件不阻塞其他技能
    }
  }
}
