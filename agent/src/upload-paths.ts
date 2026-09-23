/**
 * upload_file 的宿主侧路径授权：模型不能获得任意磁盘读取能力。
 *
 * 两层防线同时成立才放行：
 * 1. 文件系统：realpath 后落在授权根内的真实普通文件（防 .. 与符号链接逃逸）；
 * 2. 任务归属：文件必须是本任务明确登记的授权记录（用户提供或本任务制品），
 *    不能仅因位于 ~/.sideagent/downloads 就上传历史文件。
 *
 * 推荐模型传任务 fileId；兼容绝对 paths 时也必须解析到同一授权记录。
 * 不提供目录列举；错误只回路径/身份本身，不记录文件内容。
 */
import { basename } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fetchDownloadsDir } from "./fetch-result.js";

export const MAX_UPLOAD_FILES = 8;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type TaskUploadSource = "user_provided" | "task_artifact";

export interface TaskUploadRecord {
  fileId: string;
  /** realpath 后的绝对路径 */
  path: string;
  name: string;
  size: number;
  source: TaskUploadSource;
}

export function defaultUploadRoots(): string[] {
  // downloads 根与 fetch 落盘目录对齐（含 SIDEAGENT_DOWNLOADS_DIR 隔离目录）。
  return [join(homedir(), ".sideagent", "uploads"), fetchDownloadsDir()];
}

function realOrLiteral(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function assertUnderRoots(real: string, roots: string[]): void {
  const realRoots = roots.map(realOrLiteral);
  const allowed = realRoots.some((root) => real === root || real.startsWith(root + sep));
  if (!allowed) {
    throw new Error(
      `路径不在授权目录内，未上传：${real.slice(0, 200)}。只允许 ~/.sideagent/uploads/ 与 ~/.sideagent/downloads/；无法浏览或读取其他磁盘位置。`,
    );
  }
}

function inspectFile(raw: string, roots: string[]): { real: string; size: number; name: string } {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.includes("\0")) {
    throw new Error(`文件路径必须是绝对路径：${String(raw).slice(0, 200)}`);
  }
  if (raw.includes("..")) {
    throw new Error(`文件路径不能包含 ..：${raw.slice(0, 200)}`);
  }
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    throw new Error(
      `文件不存在或不可读，未上传：${raw.slice(0, 200)}（只允许本任务已授权、且位于 ~/.sideagent/uploads/ 或 ~/.sideagent/downloads/ 的文件）`,
    );
  }
  let stat;
  try {
    stat = statSync(real);
  } catch {
    throw new Error(`文件不可读，未上传：${real.slice(0, 200)}`);
  }
  if (!stat.isFile()) {
    throw new Error(`不是普通文件，未上传：${real.slice(0, 200)}`);
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB，未上传：${real.slice(0, 200)}`);
  }
  assertUnderRoots(real, roots);
  return { real, size: stat.size, name: basename(real) };
}

/**
 * 本任务的最薄文件授权账本：登记用户提供或本任务产生的制品。
 * 现有 Attachment 仍只支持图片，不在此假装已有通用附件库。
 */
export class TaskUploadLedger {
  private byId = new Map<string, TaskUploadRecord>();
  private byPath = new Map<string, TaskUploadRecord>();
  private seq = 0;
  readonly roots: string[];

  constructor(roots: string[] = defaultUploadRoots()) {
    this.roots = roots;
  }

  /** 登记一个已存在的普通文件为本任务授权。返回稳定 fileId。 */
  grant(input: { path: string; source: TaskUploadSource; fileId?: string }): TaskUploadRecord {
    const inspected = inspectFile(input.path, this.roots);
    const existing = this.byPath.get(inspected.real);
    if (existing) {
      if (input.fileId && input.fileId !== existing.fileId) {
        throw new Error(`同一文件已登记为 ${existing.fileId}，不能改记为 ${input.fileId.slice(0, 64)}`);
      }
      return existing;
    }
    const fileId = input.fileId?.trim() || `task-file-${++this.seq}`;
    if (this.byId.has(fileId)) {
      throw new Error(`fileId 已占用：${fileId.slice(0, 64)}`);
    }
    const record: TaskUploadRecord = {
      fileId,
      path: inspected.real,
      name: inspected.name,
      size: inspected.size,
      source: input.source,
    };
    this.byId.set(fileId, record);
    this.byPath.set(inspected.real, record);
    return record;
  }

  getById(fileId: string): TaskUploadRecord | undefined {
    return this.byId.get(fileId);
  }

  getByPath(path: string): TaskUploadRecord | undefined {
    try {
      return this.byPath.get(realpathSync(path));
    } catch {
      return this.byPath.get(path);
    }
  }

  records(): TaskUploadRecord[] {
    return [...this.byId.values()];
  }

  clear(): void {
    this.byId.clear();
    this.byPath.clear();
  }
}

export interface AuthorizeUploadOptions {
  /** 文件系统授权根；默认 ~/.sideagent/uploads 与 downloads。 */
  roots?: string[];
  /** 本任务文件授权账本；缺省则任何非空上传都拒绝（目录白名单不够）。 */
  ledger?: TaskUploadLedger;
}

/**
 * 校验并规范化待上传引用（fileId 或绝对路径）。
 * 成功返回 realpath 列表（去重、保序）；空数组表示清空 file input。
 * 失败抛 Error，须在 RPC 之前处理（executionFact = not_executed）。
 */
export function authorizeUploadPaths(
  refs: readonly string[],
  options: AuthorizeUploadOptions | string[] = {},
): string[] {
  // 兼容旧签名 authorizeUploadPaths(paths, roots[])
  const opts: AuthorizeUploadOptions = Array.isArray(options) ? { roots: options } : options;
  const ledger = opts.ledger;
  const roots = opts.roots ?? ledger?.roots ?? defaultUploadRoots();

  if (!Array.isArray(refs)) {
    throw new Error(`upload_file 需要 0–${MAX_UPLOAD_FILES} 个 paths/fileIds，未执行`);
  }
  if (refs.length > MAX_UPLOAD_FILES) {
    throw new Error(`upload_file 需要 0–${MAX_UPLOAD_FILES} 个 paths/fileIds，未执行`);
  }
  // 空数组 = 清空 input；不要求任务文件记录。
  if (refs.length === 0) return [];

  if (!ledger) {
    throw new Error("本任务没有可上传的文件授权记录，未执行。请使用任务已提供或本任务产生的文件（fileId）。");
  }

  const out: string[] = [];
  for (const raw of refs) {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) {
      throw new Error(`无效的文件引用：${String(raw).slice(0, 200)}`);
    }
    let record: TaskUploadRecord | undefined;
    if (raw.startsWith("/")) {
      if (raw.includes("..")) {
        throw new Error(`文件路径不能包含 ..：${raw.slice(0, 200)}`);
      }
      const inspected = inspectFile(raw, roots);
      record = ledger.getByPath(inspected.real);
      if (!record) {
        throw new Error(
          `文件不属于本任务授权，未上传：${inspected.real.slice(0, 200)}。目录内历史文件不等于本任务授权；请使用任务 fileId 或已登记路径。`,
        );
      }
    } else {
      // 任务 fileId（非绝对路径）
      if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
        throw new Error(`无效的 fileId：${raw.slice(0, 200)}`);
      }
      record = ledger.getById(raw);
      if (!record) {
        throw new Error(`未知的任务 fileId，未上传：${raw.slice(0, 200)}`);
      }
      // 再次核对磁盘事实，防止登记后被替换/删掉。
      inspectFile(record.path, roots);
    }
    if (!out.includes(record.path)) out.push(record.path);
  }
  return out;
}
