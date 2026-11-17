import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.argv[2] ?? 'verify';
const modes = {
  verify: ['verify', '--max-steps=10'],
  simulate: ['run', '--max-samples=10000', '--max-steps=20', '--seed=20261117'],
  negative: ['run', '--step=unsafeStep', '--max-samples=10000', '--max-steps=20', '--seed=20261117'],
  witness: ['run', '--witnesses', 'progressed', 'successorProgressed', '--max-samples=1000', '--max-steps=20', '--seed=20261117'],
};
if (!(mode in modes)) throw new Error('模式：verify / simulate / negative / witness');
const output = path.join(root, 'out/formal');
mkdirSync(output, { recursive: true });
const [command, ...options] = modes[mode];
const result = spawnSync('npm', ['exec', '--yes', '--package=@informalsystems/quint@0.33.1', '--', 'quint', command, path.join(root, 'scripts/formal/page-control.qnt'), '--main=page_control', '--invariants', 'authorizedDispatch', 'cancelledCannotDispatch', ...options], { cwd: output, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
const log = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`;
writeFileSync(path.join(output, `${mode}.log`), log);
process.stdout.write(log);
const witnessesReached = ['progressed', 'successorProgressed'].every(name => new RegExp(`${name} was witnessed in [1-9][0-9]* trace`).test(log));
process.exitCode = mode === 'witness' && !witnessesReached ? 1 : mode === 'negative' ? (result.status === 1 && log.includes('❌ authorizedDispatch') ? 0 : 1) : result.status ?? 1;
