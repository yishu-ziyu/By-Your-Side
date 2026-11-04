import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const mode of ['text', 'button', 'missing']) {
  console.log(`恢复入口：${mode}`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./restart-resume.mts', import.meta.url)), '--headless', `--from-other-page=${mode}`], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
