
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 伴随进程自己写的数据（会话、记忆、日志、回执、配置……）的根目录。
 * 凭据文件不跟着走：StepFun 等密钥始终从 ~/.sideagent 原位只读。
 */
export function dataDir(): string {
  return process.env.SIDEAGENT_DATA_DIR?.trim() || join(homedir(), ".sideagent");
}

