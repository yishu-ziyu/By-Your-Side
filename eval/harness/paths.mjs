/** Paths for the eval harness. Override with env vars; defaults are relative to this repo. */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const EVAL_DIR = resolve(HERE, "..");

/** Repo checkout whose extension source is built and tested, and whose real-path driver runs the jobs (default: this repo). */
export const REPO = resolve(process.env.BYS_REPO || join(EVAL_DIR, ".."));

/** Task file (JSONL, one task per line). */
export const TASKS_FILE = resolve(process.env.BYS_TASKS || join(EVAL_DIR, "tasks/tasks.jsonl"));

/** Where run outputs go: <RUNS_DIR>/<run-id>/... (ignored by git). */
export const RUNS_DIR = resolve(process.env.BYS_RUNS_DIR || join(EVAL_DIR, "runs"));
