import { appendFile, chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TRACE_SESSIONS_KEPT, TraceRecorder } from "../../shared/run-trace-core.js";
import { dataDir } from "./config.js";

export { sanitizeTrace } from "../../shared/trace-sanitize.js";

/** 本机伴随进程的诊断记录：每个会话一个 `<数据目录>/traces/<开始毫秒>-<sessionId>.jsonl`。扩展构建换成 IndexedDB 版。 */
export class RunTrace extends TraceRecorder {
  readonly path: string;

  constructor(directory = process.env.SIDEAGENT_TRACE_DIR || join(dataDir(), "traces"), maxBytes = 8 * 1024 * 1024) {
    let path = "";

    super((sessionName) => {
      path = join(directory, `${sessionName}.jsonl`);

      return {
        prepare: async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await chmod(directory, 0o700);
          const files = (await readdir(directory)).filter((name) => /^\d+-[a-f0-9-]+\.jsonl$/.test(name)).sort();
          await Promise.all(files.slice(0, Math.max(0, files.length - (TRACE_SESSIONS_KEPT - 1))).map((name) => unlink(join(directory, name)).catch(() => {})));
        },
        append: (line) => appendFile(path, line, { mode: 0o600 }),
      };
    }, maxBytes);
    this.path = path;
  }
}
