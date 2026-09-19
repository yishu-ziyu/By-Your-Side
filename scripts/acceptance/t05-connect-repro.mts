/**
 * T05 根因诊断：host 重启后扩展上行连接的“第二次断开”。
 *
 * 只做连接层（真实扩展 + 真实 host 重启序列），不调模型、不做页面动作。
 * 观察：host2 连接建立后是否又被自己掐断（旧代码在 ~1s 后拆掉活连接，
 * 导致 manager.disconnect() 中断刚恢复的任务；修复后保持连接）。
 *
 *   npx --no-install tsx scripts/acceptance/t05-connect-repro.mts --headless [--report <dir>]
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {startHost, stopHost, startIsolatedPanel, type HostHandle, type HostHolder} from './product-journeys/runner.mjs';
import {until} from './isolated-extension.mts';
import {loadConfig} from '../../agent/src/config.js';

if (!process.argv.includes('--headless')) throw new Error('需要显式 --headless：本驱动只允许无头隔离运行。');
const argOf = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const outRoot = resolve(argOf('--report', 'out/acceptance/t05-connect-repro')!);
mkdirSync(outRoot, {recursive: true});
const model = loadConfig().model;
const events: HostHolder['current']['events'] = [];
const log: {at: number; kind: string; detail?: string}[] = [];
const push = (kind: string, detail?: string): void => { log.push({at: Date.now(), kind, ...(detail ? {detail} : {})}); };
const instrument = (host: HostHandle, tag: string): void => {
  host.wss.on('connection', (client: {on: (event: string, handler: () => void) => void}) => {
    push(`${tag}:connection`);
    client.on('close', () => push(`${tag}:close`));
  });
};

const holder: HostHolder = {current: await startHost(model, join(outRoot, 'host'), events)};
instrument(holder.current, 'host1');
const {iso, panel} = await startIsolatedPanel(holder.current);
let result = 'incomplete';
try {
  await until(() => holder.current.socket?.readyState === 1 || undefined, 30_000, 'first connect');
  push('first connect ready');
  // 与 product-journeys runner.restartHost 相同序列
  const token = holder.current.token;
  const port = holder.current.port;
  const storeDir = join(outRoot, 'host');
  await stopHost(holder.current);
  push('host1 stopped');
  holder.current = await startHost(model, storeDir, events, token, port);
  instrument(holder.current, 'host2');
  await iso.evalIn(panel, "window.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
  await until(() => holder.current.socket?.readyState === 1 || undefined, 30_000, 'reconnect');
  push('reconnect ready');
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  push('observation window done');
  // 观察窗内 host2 自己断开 = 旧代码的第二次断开复现；此处的 close 不包含 finally 里的主动 stopHost。
  result = log.some((entry) => entry.kind === 'host2:close') ? 'second-disconnect-reproduced' : 'connection-stable';
} finally {
  writeFileSync(join(outRoot, 'connect-log.json'), JSON.stringify({result, log}, null, 2));
  await iso.close().catch(() => {});
  await stopHost(holder.current).catch(() => {});
}
console.log(JSON.stringify({result, log}, null, 2));
process.exit(result === 'connection-stable' ? 0 : 1);
