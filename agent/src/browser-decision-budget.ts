import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, appendFileSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Durable pre-request reservations for the loop. Not a claim about the planner's total spend. */
export function reserveBrowserDecision(sessionFile: string | undefined, runId: string | null): void {
  reserveBrowserCall(sessionFile, runId, 'decision', 16);
}

export function reserveBrowserMaterial(sessionFile: string | undefined, runId: string | null): void {
  reserveBrowserCall(sessionFile, runId, 'material', 8);
}

function reserveBrowserCall(sessionFile: string | undefined, runId: string | null, resource: 'decision' | 'material', limit: number): void {
  if (!sessionFile || !runId) {
    throw new Error('缺少持久化任务身份，通用决策未调用模型');
  }
  const dir = join(dirname(sessionFile), 'decision-budgets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, createHash('sha256').update(runId).digest('hex') + (resource === 'decision' ? '.reservations' : '.materials'));
  const lockPath = path + '.lock';
  let lock: number;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  }
  catch {
    throw new Error('决策预算记录被占用或不可用，未调用模型');
  }
  try {
    let lines: string[] = [];
    try {
      lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
    if (lines.some(line => {
      try {
        const row = JSON.parse(line);
        return typeof row.id !== 'string' || !Number.isFinite(row.at);
      }
      catch {
        return true;
      }
    })) {
      throw new Error('决策预算记录损坏，未调用模型');
    }
    // jev-1.13.0 official limit <=64Ki input tokens/request, $0.042/M, output free.
    // 16 calls <= $0.045 at the reviewed price, including timed-out requests; no adapter retry.
    if (lines.length >= limit) {
      throw new Error(`本任务的 ${limit} 次${resource === 'decision' ? ' Jev 决策' : '字段文字生成'}预算已用完，交回任务模型`);
    }
    const fd = openSync(path, 'a', 0o600);
    try {
      appendFileSync(fd, JSON.stringify({ id: randomUUID(), at: Date.now() }) + '\n');
      fsyncSync(fd);
    }
    finally {
      closeSync(fd);
    }
  }
  finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
