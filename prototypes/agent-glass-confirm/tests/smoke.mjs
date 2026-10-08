import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const origin = 'http://127.0.0.1:4183';
const out = resolve(base, 'out');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4183', '--strictPort'], {
  cwd: base,
  stdio: 'ignore'
});

let browser;
async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(origin);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Preview server did not start');
}

try {
  await waitForServer();
  await mkdir(out, { recursive: true });
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, deviceScaleFactor: 1 });
  const unsafeRequests = [];
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) unsafeRequests.push(request.url());
  });
  await page.goto(origin);
  await page.getByRole('button', { name: '模拟需要确认' }).waitFor();
  const capsule = page.getByTestId('agent-pill');
  const closed = await capsule.boundingBox();
  assert.ok(closed && closed.width < 250, 'Initial trigger stays a capsule');
  assert.equal(await capsule.evaluate(node => node.tagName), 'BUTTON', 'Glass trigger is a native keyboard-operable button');
  await page.screenshot({ path: resolve(out, '01-capsule.png') });

  await page.getByRole('button', { name: '模拟需要确认' }).click();
  await page.getByRole('dialog', { name: '发送前确认' }).waitFor();
  const popup = page.getByTestId('glass-popup');
  assert.equal(await popup.count(), 1, 'One native liquid-glass popup is mounted');
  await page.screenshot({ path: resolve(out, '02-morph-in-motion.png') });
  await page.waitForTimeout(800);
  const expanded = await popup.boundingBox();
  assert.ok(expanded && expanded.width > closed.width + 100 && expanded.height > 260, 'Popup grows out of small trigger');
  assert.match(await page.getByRole('dialog').innerText(), /Maya Chen|maya@/);
  await page.screenshot({ path: resolve(out, '02-confirmation.png') });
  await page.getByRole('button', { name: '取消发送' }).click();
  assert.match(await page.getByTestId('result-state').innerText(), /已取消/);
  assert.match(await page.getByTestId('draft-state').innerText(), /待发送/);
  await page.waitForTimeout(850);
  assert.equal(await popup.count(), 0, 'Close removes popup after reverse morph');

  await page.getByRole('button', { name: '模拟需要确认' }).click();
  await popup.waitFor();
  await page.getByRole('button', { name: '确认发送' }).click();
  assert.match(await page.getByTestId('result-state').innerText(), /模拟已发送/);
  assert.match(await page.getByTestId('draft-state').innerText(), /模拟已发送/);
  await page.screenshot({ path: resolve(out, '03-confirmed.png') });

  await page.getByRole('button', { name: '重新开始' }).click();
  await page.getByRole('button', { name: '模拟需要确认' }).click();
  await page.keyboard.press('Escape');
  assert.match(await page.getByTestId('draft-state').innerText(), /待发送/);
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '模拟需要确认' }).click();
  await popup.waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '模拟需要确认' }).click();
  assert.equal(await page.getByRole('dialog', { name: '发送前确认' }).count(), 1, 'Reopening does not duplicate the popup');
  assert.equal(unsafeRequests.length, 0, 'No external send/network mutation');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '模拟需要确认' }).click();
  await page.getByRole('dialog', { name: '发送前确认' }).waitFor();
  assert.equal(await popup.count(), 1, 'Popup works with reduced motion');
  await page.keyboard.press('Escape');
  await capsule.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: '发送前确认' }).waitFor();
  assert.equal(await popup.count(), 1, 'Keyboard Enter opens the popover');
  console.log('PASS: native morph popup, cancel / confirm, reverse close, rapid reopening, Escape, reduced motion, no external send');
  console.log('Screenshots: prototypes/agent-glass-confirm/out/*.png');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
