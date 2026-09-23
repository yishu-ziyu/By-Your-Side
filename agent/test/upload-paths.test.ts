import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizeUploadPaths,
  MAX_UPLOAD_FILES,
  TaskUploadLedger,
} from "../src/upload-paths.js";

describe("authorizeUploadPaths（结果：只放行本任务授权账本内的真实普通文件）", () => {
  const root = mkdtempSync(join(tmpdir(), "bys-upload-root-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "bys-upload-outside-"));
  const inside = join(root, "report.txt");
  const inside2 = join(root, "photo.png");
  const historic = join(root, "old-download.bin");
  const outside = join(outsideDir, "secret.txt");
  const dirFile = join(root, "adir");
  writeFileSync(inside, "hello");
  writeFileSync(inside2, "png");
  writeFileSync(historic, "stale artifact from another task");
  writeFileSync(outside, "top secret payload NEVER_LOG_THIS");
  mkdirSync(dirFile);
  symlinkSync(outside, join(root, "escape-link.txt"));

  const roots = [root];
  const ledger = new TaskUploadLedger(roots);
  const granted = ledger.grant({ path: inside, source: "user_provided", fileId: "f-report" });
  ledger.grant({ path: inside2, source: "task_artifact", fileId: "f-photo" });

  it("授权账本内的真实文件通过并返回 realpath", () => {
    expect(authorizeUploadPaths([inside, inside2], { roots, ledger })).toEqual([
      realpathSync(inside),
      realpathSync(inside2),
    ]);
  });

  it("推荐 fileId：同一文件身份不因引用方式改变", () => {
    expect(authorizeUploadPaths(["f-report", "f-photo"], { roots, ledger })).toEqual([
      granted.path,
      realpathSync(inside2),
    ]);
    expect(authorizeUploadPaths(["f-report", inside], { roots, ledger })).toEqual([granted.path]);
  });

  it("去重后保序", () => {
    expect(authorizeUploadPaths([inside, inside2, inside], { roots, ledger })).toEqual([
      realpathSync(inside),
      realpathSync(inside2),
    ]);
  });

  it("空数组表示清空 input，不要求任务文件", () => {
    expect(authorizeUploadPaths([], { roots, ledger })).toEqual([]);
    expect(authorizeUploadPaths([], { roots })).toEqual([]);
    // 有账本但账本为空时，清空仍然允许。
    const empty = new TaskUploadLedger(roots);
    expect(authorizeUploadPaths([], { roots, ledger: empty })).toEqual([]);
  });

  it("授权目录内但未登记为本任务的历史文件被拒绝", () => {
    expect(() => authorizeUploadPaths([historic], { roots, ledger })).toThrow(/不属于本任务授权/);
  });

  it("没有任务账本时，即使路径在目录内也拒绝，且不触碰其它授权语义", () => {
    expect(() => authorizeUploadPaths([inside], { roots })).toThrow(/没有可上传的文件授权记录/);
  });

  it("本任务刚 grant 的制品可通过；同目录未登记文件仍拒", () => {
    const artifactLedger = new TaskUploadLedger(roots);
    const artifact = join(root, "fresh-artifact.json");
    writeFileSync(artifact, '{"n":1}');
    artifactLedger.grant({ path: artifact, source: "task_artifact" });
    expect(authorizeUploadPaths([artifact], { roots, ledger: artifactLedger })).toEqual([
      realpathSync(artifact),
    ]);
    expect(() => authorizeUploadPaths([historic], { roots, ledger: artifactLedger })).toThrow(
      /不属于本任务授权/,
    );
  });

  it("授权目录之外的路径被拒绝", () => {
    expect(() => authorizeUploadPaths([outside], { roots, ledger })).toThrow(/不在授权目录内/);
  });

  it("拒绝信息不得包含未授权文件内容", () => {
    try {
      authorizeUploadPaths([outside], { roots, ledger });
      expect.unreachable("should throw");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      expect(text).not.toContain("NEVER_LOG_THIS");
      expect(text).not.toContain("top secret");
    }
  });

  it("符号链接逃逸到目录外时按 realpath 拒绝", () => {
    expect(() => authorizeUploadPaths([join(root, "escape-link.txt")], { roots, ledger })).toThrow(
      /不在授权目录内/,
    );
  });

  it("不存在的文件被拒绝（不泄露其他位置的存在性）", () => {
    expect(() => authorizeUploadPaths([join(root, "missing.txt")], { roots, ledger })).toThrow(
      /不存在或不可读/,
    );
  });

  it("未知 fileId 被拒绝", () => {
    expect(() => authorizeUploadPaths(["no-such-file"], { roots, ledger })).toThrow(/未知的任务 fileId/);
  });

  it("目录不是普通文件，拒绝", () => {
    expect(() => authorizeUploadPaths([dirFile], { roots, ledger })).toThrow(/不是普通文件/);
  });

  it("相对路径与包含 .. 的路径在触碰文件系统前拒绝", () => {
    expect(() => authorizeUploadPaths(["relative.txt"], { roots, ledger })).toThrow(/未知的任务 fileId|无效/);
    expect(() => authorizeUploadPaths(["/tmp/../etc/passwd"], { roots, ledger })).toThrow(/不能包含 \.\./);
  });

  it("超过数量上限拒绝", () => {
    const many = Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => inside);
    expect(() => authorizeUploadPaths(many, { roots, ledger })).toThrow(new RegExp(`${MAX_UPLOAD_FILES}`));
  });

  it("清理临时目录", () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
