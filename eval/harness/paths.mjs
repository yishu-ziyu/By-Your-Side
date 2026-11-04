import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const EVAL_DIR = resolve(HERE, "..");

export const REPO = resolve(process.env.BYS_REPO || join(EVAL_DIR, ".."));

export const TASKS_FILE = resolve(process.env.BYS_TASKS || join(EVAL_DIR, "tasks/tasks.jsonl"));

export const RUNS_DIR = resolve(process.env.BYS_RUNS_DIR || join(EVAL_DIR, "runs"));
