#!/usr/bin/env node
// Real daily-entry acceptance for the Stagehand compatibility layer.
// Path under test: production panel textarea -> Port -> native host -> real Pi model
// -> browser_run{api:"playwright"} -> official page compatibility -> existing ego RPC
// -> local form fixture. Prompts are guided integration prompts, not natural-language
// or microphone evidence. Run only after the main agent confirms the new code is loaded.
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverChromeMain } from './discover.mjs';
import { connectBrowser, evaluateInWorker, findServiceWorker } from './cdp.mjs';
import { sideagentExtensionId } from './constants.mjs';
import { clickUi, sendTaskUi, until } from './handback-recovery-run.mjs';
import { redactEvidence } from './redact.mjs';
import { normalizeServiceWorkerInspector } from './sw-hook.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>本地 Stagehand 验收表单</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto}label{display:block;margin-top:16px}input{width:100%;padding:8px;font:inherit}button{margin-top:20px;padding:8px 18px}</style>
</head>
<body>
<h1>填写联系信息</h1>
<form id="contact" novalidate>
  <label for="name">姓名</label>
  <input id="name" name="name" autocomplete="off">
  <label for="email">邮箱</label>
  <input id="email" name="email" type="email" autocomplete="off">
  <button type="submit">提交</button>
</form>
<p id="submitted">尚未提交</p>
<script>
globalThis.__stagehandFixture = { submits: 0, writes: [], createdAt: Date.now(), lastWriteAt: null, lastSubmitAt: null };
const fixture = globalThis.__stagehandFixture;
document.querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  fixture.submits += 1;
  fixture.lastSubmitAt = Date.now();
  document.querySelector('#submitted').textContent = '已提交';
});
for (const element of document.querySelectorAll('input')) {
  element.addEventListener('input', () => {
    fixture.writes.push({ field: element.id, value: element.value, at: Date.now() });
    fixture.lastWriteAt = Date.now();
  });
}
</script>
</body>
</html>`;

const GUIDED_NOTICE =
  '本次是 guided 集成验收：消息通过生产侧栏文本输入发送，并明确要求 browser_run 传 api:"playwright" 和使用官方 page 接口；不代表自然语言或真人语音测试。';

const TEST = {
  fillName: '张三',
  fillEmail: 'test@example.com',
  rename: '李明',
  switchProof: '王五',
  forbiddenWrite: 'SHOULD_NOT_WRITE',
};

function promptFill() {
  return `本地 Stagehand 兼容层 guided 验收。只操作当前页面 A（标题含“本地 Stagehand 验收表单”，路径 /form-a），不要提交、不要按回车提交、不要打开新标签。

请只调用一次 browser_run，并且必须显式传 api:"playwright"。程序使用官方 page 接口填写：
await page.getByLabel('姓名',{exact:true}).fill('${TEST.fillName}');
await page.getByRole('textbox',{name:'邮箱',exact:true}).fill('${TEST.fillEmail}');
return {name:await page.locator('#name').inputValue(),email:await page.locator('#email').inputValue()};

不要用旧 browser.* API，不要调用 page.getByRole('button') 点提交。完成后用一句话报告返回值。`;
}

function promptAbort() {
  return `继续在同一页 A 做中止验收。只调用一次 browser_run，并必须显式传 api:"playwright"。

程序必须先等待再写，用来观察真实 tool sleep 事件：
await page.waitForTimeout(8000);
await page.getByLabel('姓名',{exact:true}).fill('${TEST.forbiddenWrite}');
return await page.locator('#name').inputValue();

等待期间我会通过生产停止按钮中止。收到中止或用户控制后立即结束原任务，禁止继续、禁止重试、禁止写任何字段、禁止提交。`;
}

function promptRename() {
  return `继续在同一页 A。只调用一次 browser_run，并必须显式传 api:"playwright"。

用官方 page 接口把姓名改成“${TEST.rename}”，邮箱保持“${TEST.fillEmail}”，其他不动，不提交：
await page.getByLabel('姓名',{exact:true}).fill('${TEST.rename}');
return {name:await page.locator('#name').inputValue(),email:await page.locator('#email').inputValue()};

完成后报告返回值。`;
}

function promptTabSwitch() {
  return `继续在同一页 A。只调用一次 browser_run，并必须显式传 api:"playwright"。

先用官方 page.waitForTimeout 等待，再写 A 页的姓名：
await page.waitForTimeout(6000);
await page.getByLabel('姓名',{exact:true}).fill('${TEST.switchProof}');
return {name:await page.locator('#name').inputValue(),email:await page.locator('#email').inputValue()};

等待期间我会激活另一个本地 fixture 标签；原任务必须继续写开始时的 A 页，不能改看或写另一个标签，不能提交。收到中止或控制信号则立即结束、不要重试。`;
}

function requireConfirmedLoaded() {
  if (process.argv.includes('--confirm-loaded')) return;
  console.error(
    [
      '拒绝运行：脚本会连接 ChromeMain 并通过真实模型执行 guided 任务。',
      '请由主代理先确认新版 Stagehand 兼容层已加载，再运行：',
      '  node scripts/acceptance/stagehand-native.mjs --confirm-loaded',
      '可选：--keep-tabs 保留本轮创建的 fixture/panel 标签供人工查看。',
    ].join('\n'),
  );
  process.exit(2);
}

function isMainSession(message) {
  const sessionId = message?.msg?.sessionId;
  return sessionId == null || sessionId === 'main';
}

function projectServerMessage(message, conversationId) {
  if (message.conversationId && message.conversationId !== conversationId) return null;
  const type = message?.msg?.type;
  if (type === 'hello_ok' || type === 'model_info') {
    return { type, model: message.msg.model ?? null };
  }
  if (type === 'status') {
    if (message.conversationId !== conversationId) return null;
    if (message.msg.sessionId != null && message.msg.sessionId !== 'main') return null;
    return { type, state: message.msg.state ?? null, sessionId: message.msg.sessionId ?? 'main' };
  }
  if (type !== 'agent_event') return null;
  if (message.conversationId !== conversationId) return null;
  if (message.msg.sessionId != null && message.msg.sessionId !== 'main') return null;
  const event = message.msg.event;
  if (!event || typeof event !== 'object') return null;
  const kind = event.kind;
  if (kind === 'agent_start' || kind === 'agent_end' || kind === 'turn_end') {
    return { type, event: { kind, runId: event.runId ?? null } };
  }
  if (kind === 'tool_start') {
    const params = event.params && typeof event.params === 'object' ? event.params : {};
    const projected = { kind, toolCallId: event.toolCallId ?? null, name: event.name, params: {} };
    if (event.name === 'browser_run') {
      projected.params = {
        api: typeof params.api === 'string' ? params.api : null,
        label: typeof params.label === 'string' ? params.label.slice(0, 160) : null,
        code: typeof params.code === 'string' ? params.code.slice(0, 5000) : null,
      };
    } else if (typeof event.toolCallId === 'string' && event.toolCallId.includes('/')) {
      projected.params = {
        ms: Number.isFinite(params.ms) ? params.ms : null,
        selector: typeof params.selector === 'string' ? params.selector.slice(0, 160) : null,
        target: typeof params.target === 'string' ? params.target.slice(0, 160) : null,
        value: typeof params.value === 'string' ? params.value.slice(0, 160) : null,
      };
    } else {
      projected.params = {
        action: typeof params.action === 'string' ? params.action : null,
        tabId: Number.isSafeInteger(params.tabId) ? params.tabId : null,
        url: typeof params.url === 'string' ? params.url.slice(0, 300) : null,
      };
    }
    return { type, event: projected };
  }
  if (kind === 'tool_end') {
    return {
      type,
      event: {
        kind,
        toolCallId: event.toolCallId ?? null,
        name: event.name,
        isError: !!event.isError,
        executionFact: event.executionFact ?? null,
      },
    };
  }
  if (kind === 'error' || kind === 'notice') {
    return { type, event: { kind, message: typeof event.message === 'string' ? event.message.slice(0, 800) : null } };
  }
  return null;
}

async function main() {
  requireConfirmedLoaded();
  const root =
    process.env.ACCEPT_EVIDENCE_DIR ||
    join(process.cwd(), 'out/acceptance', `stagehand-native-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(root, { recursive: true });

  const fixtureHtml = Buffer.from(FIXTURE_HTML);
  const fixtureServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml);
  });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixtureServer.address().port}`;

  let cdp;
  let swSession;
  let panel;
  let tabA;
  let tabB;
  let conversationId = 'default';
  let ownsTask = false;
  let sentAt = null;

  const startedAt = Date.now();
  const result = {
    passed: false,
    scope:
      'production panel textarea -> Port -> native host -> real Pi model -> browser_run{api:"playwright"} -> official page compatibility -> existing ego RPC -> local form fixture',
    guided: true,
    guidedNotice: GUIDED_NOTICE,
    inputEntry: 'production panel #input + #send-btn through CDP Input (existing acceptance helper)',
    realVoiceTested: false,
    startedAt,
    evidenceDir: root,
    fixtureOrigin: origin,
    scenarios: {},
    limitations: [
      '未测试真人语音或麦克风输入；语音设置未被读取或修改。',
      '四条任务都给了明确 browser_run/api/官方 page 接口指令，属于 guided 集成验收，不是自然语言效果评测。',
      '本脚本只使用本地 127.0.0.1 fixture，不向外部服务提交数据。',
    ],
  };
  const writeEvidence = (name, value) => writeFile(join(root, name), JSON.stringify(redactEvidence(value ?? null), null, 2));
  const readEvents = async () => {
    if (!cdp || !panel) return [];
    return evaluateInWorker(cdp, panel.session, 'globalThis.__stagehandNativeEvents || []');
  };
  const eventsSince = async (since) => (await readEvents()).filter((entry) => entry.at >= since);
  const latestStatusEntry = async (since = 0) => {
    const entries = await readEvents();
    return entries
      .filter((entry) => entry.at >= since && entry.msg?.type === 'status' && isMainSession(entry))
      .at(-1) ?? null;
  };
  const latestStatus = async (since = 0) => (await latestStatusEntry(since))?.msg?.state ?? null;
  const readPanelUi = async () =>
    evaluateInWorker(
      cdp,
      panel.session,
      `(() => {
        const send = document.querySelector('#send-btn');
        const abort = document.querySelector('#abort-btn');
        const input = document.querySelector('#input');
        const setup = document.querySelector('#setup');
        const attachments = document.querySelector('#attachments-strip');
        return {
          statusText: document.querySelector('#status-text')?.textContent?.trim() ?? null,
          modelName: document.querySelector('#model-name')?.textContent?.trim() ?? null,
          stopping: !!send && send.classList.contains('stopping'),
          abortVisible: !!abort && !abort.hidden && !abort.disabled,
          sendVisible: !!send && !send.hidden && !send.disabled,
          input: input?.value ?? null,
          setupVisible: !!setup && !setup.hidden,
          hasAttachments: !!attachments && !attachments.hidden && attachments.children.length > 0,
        };
      })()`,
    );
  const assertTaskReady = async (label) => {
    const state = await latestStatus();
    const ui = await readPanelUi();
    const selectedNow = await evaluateInWorker(
      cdp,
      swSession,
      `chrome.storage.session.get('selectedConversationId').then((stored) => typeof stored.selectedConversationId === 'string' ? stored.selectedConversationId : 'default')`,
    );
    if (selectedNow !== conversationId) {
      throw new Error(`${label}: 生产会话选择已从 ${conversationId} 变为 ${selectedNow}，拒绝把消息发给变化后的会话`);
    }
    if (state && state !== 'idle') throw new Error(`${label}: 会话 ${conversationId} 当前状态为 ${state}，拒绝并发运行`);
    if (ui.stopping || ui.abortVisible) throw new Error(`${label}: 生产面板仍有运行中的任务`);
    if (ui.setupVisible) throw new Error(`${label}: 生产面板处于 setup 状态，native host 未就绪`);
    if (ui.statusText !== '已连接') throw new Error(`${label}: 生产面板未连接 native host，状态=${ui.statusText}`);
    if ((ui.input ?? '') !== '') throw new Error(`${label}: 输入框有未发送草稿，拒绝覆盖或拼入用户内容`);
    if (ui.hasAttachments) throw new Error(`${label}: 输入框带有附件，拒绝发送`);
    return ui;
  };
  const readFixture = async (tabId) => {
    const value = await evaluateInWorker(
      cdp,
      swSession,
      `chrome.scripting.executeScript({
        target: { tabId: ${tabId} },
        world: 'MAIN',
        func: () => {
          const fixture = globalThis.__stagehandFixture || {};
          return {
            url: location.href,
            title: document.title,
            name: document.querySelector('#name')?.value ?? null,
            email: document.querySelector('#email')?.value ?? null,
            submits: fixture.submits ?? 0,
            writes: (fixture.writes ?? []).slice(-50).map((item) => ({ field: item.field, value: item.value, at: item.at })),
            lastWriteAt: fixture.lastWriteAt ?? null,
            lastSubmitAt: fixture.lastSubmitAt ?? null,
          };
        },
      }).then((items) => items[0]?.result ?? null)`,
    );
    if (!value) throw new Error(`fixture tab ${tabId} 读取失败`);
    return value;
  };
  const createFixtureTab = async (path) => {
    const tab = await evaluateInWorker(
      cdp,
      swSession,
      `chrome.tabs.create({ url: ${JSON.stringify(origin + path)}, active: false })`,
    );
    await until(
      async () => evaluateInWorker(cdp, swSession, `chrome.tabs.get(${tab.id}).then((tab) => tab.status === 'complete')`),
      `fixture ${path} loaded`,
      30000,
    );
    await until(
      async () => {
        const state = await readFixture(tab.id);
        return state.name === '' && state.email === '' ? state : false;
      },
      `fixture ${path} form ready`,
      30000,
    );
    return tab;
  };
  const activateFixture = async (tabId, label) => {
    if (!(
      await evaluateInWorker(cdp, swSession, `chrome.tabs.get(${tabId}).then((tab) => !!tab)`)
    )) {
      throw new Error(`${label}: fixture tab ${tabId} 不存在`);
    }
    await evaluateInWorker(cdp, swSession, `chrome.tabs.update(${tabId}, { active: true })`);
    await until(
      async () => evaluateInWorker(cdp, swSession, `chrome.tabs.get(${tabId}).then((tab) => tab.active === true)`),
      `${label}: fixture tab active`,
      10000,
    );
  };
  const captureTab = async (tabId, filename) => {
    const tab = await evaluateInWorker(cdp, swSession, `chrome.tabs.get(${tabId})`);
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const target = targets.find((item) => item.type === 'page' && item.url === tab.url);
    if (!target) throw new Error(`screenshot target unavailable: ${tab.url}`);
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    try {
      await cdp.send('Page.enable', {}, attached.sessionId);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, attached.sessionId);
      await writeFile(join(root, filename), Buffer.from(shot.data, 'base64'));
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {});
    }
  };
  const browserRunsSince = async (since) => {
    const entries = await eventsSince(since);
    return entries
      .filter((entry) => entry.msg?.type === 'agent_event' && entry.msg.event?.kind === 'tool_start' && entry.msg.event.name === 'browser_run')
      .map((entry) => ({
        at: entry.at,
        id: entry.msg.event.toolCallId,
        api: entry.msg.event.params?.api ?? null,
        label: entry.msg.event.params?.label ?? null,
        code: entry.msg.event.params?.code ?? '',
      }));
  };
  const nestedStepsSince = async (since, parentIds) => {
    const entries = await eventsSince(since);
    const parents = new Set(parentIds.filter(Boolean));
    return entries
      .filter((entry) => entry.msg?.type === 'agent_event' && entry.msg.event?.kind === 'tool_start')
      .filter((entry) => {
        const id = entry.msg.event.toolCallId;
        return typeof id === 'string' && id.includes('/') && [...parents].some((parent) => id.startsWith(`${parent}/`));
      })
      .map((entry) => ({
        at: entry.at,
        id: entry.msg.event.toolCallId,
        name: entry.msg.event.name,
        params: entry.msg.event.params ?? {},
      }));
  };
  const assertGuidedPlaywright = (label, runs, codeNeedle) => {
    if (!runs.length) throw new Error(`${label}: 模型没有调用 browser_run`);
    const playwright = runs.filter((run) => run.api === 'playwright');
    const legacy = runs.filter((run) => run.api !== 'playwright');
    if (!playwright.length) throw new Error(`${label}: browser_run 未显式传 api:"playwright"`);
    if (legacy.length) throw new Error(`${label}: 出现未显式使用 playwright 的 browser_run`);
    const combined = playwright.map((run) => run.code || '').join('\n');
    if (!/page\.(getByLabel|getByRole|locator|waitForTimeout)/.test(combined)) {
      throw new Error(`${label}: playwright 程序没有使用官方 page 接口`);
    }
    if (codeNeedle && !codeNeedle.test(combined)) throw new Error(`${label}: playwright 程序缺少预期控制点 ${codeNeedle}`);
    return playwright;
  };
  const officialMethods = (runs) => {
    const combined = runs.map((run) => run.code || '').join('\n');
    return ['getByLabel', 'getByRole', 'locator', 'waitForTimeout'].filter((name) => combined.includes(`page.${name}`));
  };
  const waitTaskStarted = async (since, timeout = 180000) => {
    return until(
      async () => {
        const entries = await eventsSince(since);
        const start = entries.find((entry) => entry.msg?.type === 'agent_event' && entry.msg.event?.kind === 'agent_start');
        const running = entries.some((entry) => entry.msg?.type === 'status' && entry.msg.state === 'running');
        return start && running ? { startedAt: start.at, runningAt: Date.now() } : false;
      },
      `task started after ${since}`,
      timeout,
    );
  };
  const waitTaskFinished = async (since, timeout = 240000) => {
    return until(
      async () => {
        const entries = await eventsSince(since);
        const end = entries.filter((entry) => entry.msg?.type === 'agent_event' && entry.msg.event?.kind === 'agent_end').at(-1);
        const idle = entries.filter((entry) => entry.msg?.type === 'status' && entry.msg.state === 'idle').at(-1);
        const ui = await readPanelUi();
        if (!end || !idle || ui.stopping || ui.abortVisible) return false;
        return { endedAt: end.at, idleAt: idle.at, observedAt: Date.now() };
      },
      `task finished after ${since}`,
      timeout,
    );
  };
  const sendGuided = async (text) => {
    await assertTaskReady('send guided task');
    await activateFixture(tabA.id, 'before send');
    const at = Date.now();
    ownsTask = true;
    sentAt = at;
    await sendTaskUi(cdp, panel.session, text);
    await until(
      async () => (evaluateInWorker(cdp, panel.session, `document.querySelector('#input')?.value === ''`)),
      'composer cleared after send',
      5000,
    ).catch(() => {});
    return at;
  };
  const clickNormalStop = async () => {
    const selector = await until(
      async () =>
        evaluateInWorker(
          cdp,
          panel.session,
          `(() => {
            const abort = document.querySelector('#abort-btn');
            const send = document.querySelector('#send-btn');
            const visible=el=>el&&!el.hidden&&!el.disabled&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0&&getComputedStyle(el).visibility!=='hidden';
            if (visible(send) && send.classList.contains('stopping')) return '#send-btn';
            if (visible(abort)) return '#abort-btn';
            return null;
          })()`,
        ),
      'normal stop button visible',
      10000,
    );
    await evaluateInWorker(cdp,panel.session,`(()=>{globalThis.__stagehandStopClick=null;document.querySelector(${JSON.stringify(selector)}).addEventListener('click',e=>{globalThis.__stagehandStopClick={at:Date.now(),trusted:e.isTrusted};},{once:true})})()`);
    await clickUi(cdp, panel.session, selector);
    const click=await evaluateInWorker(cdp,panel.session,'globalThis.__stagehandStopClick');
    if(!click?.trusted)throw new Error('Stop button did not receive a trusted click; stop behavior was not tested');
    result.stopClick=click;
    return selector === '#abort-btn' ? '#abort-btn (生产中止按钮)' : '#send-btn.stopping (生产停止按钮)';
  };
  const abortOwnedTask = async () => {
    if (!ownsTask || sentAt == null) return false;
    const state = (await latestStatusEntry(sentAt).catch(() => null))?.msg?.state ?? null;
    if (state !== 'running') return false;
    const selector = await evaluateInWorker(
      cdp,
      panel.session,
      `(() => {
        const abort = document.querySelector('#abort-btn');
        const send = document.querySelector('#send-btn');
        if (send && send.classList.contains('stopping') && !send.hidden && !send.disabled) return '#send-btn';
        if (abort && !abort.hidden && !abort.disabled && abort.getBoundingClientRect().width>0) return '#abort-btn';
        return null;
      })()`,
    ).catch(() => null);
    if (selector) await clickUi(cdp, panel.session, selector).catch(() => {});
    return !!selector;
  };

  try {
    const connection = discoverChromeMain();
    result.chrome = {
      pid: connection.pid,
      port: connection.port,
      userDataDir: connection.userDataDir,
      discovery: 'discoverChromeMain()',
    };
    ({ cdp } = await connectBrowser(connection.port));
    const extId = sideagentExtensionId();
    result.extensionId = extId;
    const sw = findServiceWorker((await cdp.send('Target.getTargets')).targetInfos, extId);
    if (!sw) throw new Error('Production SideAgent service worker unavailable');
    swSession = await cdp.attachSession(sw.targetId);
    await normalizeServiceWorkerInspector(cdp, swSession);
    // Do not reload the new panel: a second boot can create another conversation
    // after the first boot has already selected one.
    const createdPanel = await evaluateInWorker(cdp, swSession, `chrome.tabs.create({url:'chrome-extension://${extId}/sidepanel.html',active:false})`);
    const panelTarget = await until(async()=> (await cdp.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url===`chrome-extension://${extId}/sidepanel.html`),'native panel target');
    panel={tabId:createdPanel.id,session:await cdp.attachSession(panelTarget.targetId)};
    await cdp.send('Page.enable',{},panel.session);
    await until(()=>evaluateInWorker(cdp,panel.session,`document.querySelector('#status-text')?.textContent==='已连接'&&!!document.querySelector('#input')`),'panel connected',60000);
    result.panelTabId = panel.tabId;

    // Read UI and stored selection together until both name the ready conversation.
    conversationId = await until(async()=>{
      const uiId=await evaluateInWorker(cdp,panel.session,`(() => {
        const button=document.querySelector('#conversation-new');
        if(!button||button.disabled)return false;
        return document.querySelector('[data-conversation-id][aria-checked="true"]')?.dataset.conversationId||false;
      })()`);
      const stored=await evaluateInWorker(cdp,swSession,`chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId)`);
      return uiId&&uiId===stored?uiId:false;
    },'panel conversation ready and selected',60000);
    result.conversationId = conversationId;

    const observerSource = `(() => {
      globalThis.__stagehandNativeEvents = [];
      const conversationId = ${JSON.stringify(conversationId)};
      const project = ${projectServerMessage.toString()};
      const port = chrome.runtime.connect({ name: 'sideagent-panel' });
      globalThis.__stagehandNativePort = port;
      port.onMessage.addListener((message) => {
        if (!message || typeof message !== 'object') return;
        // Live execution events are carried in history envelopes, while status is direct.
        // afterSeq=MAX below omits past history; only newly broadcast rows are consumed.
        const items=message.kind==='history'
          ? message.entries.map(entry=>({...entry.item,conversationId:message.conversationId??entry.item.conversationId}))
          : [message];
        for(const item of items){
          if(item.kind!=='server')continue;
          const projected=project(item,conversationId);
          if(projected)globalThis.__stagehandNativeEvents.push({at:Date.now(),conversationId:item.conversationId??null,msg:projected});
        }
      });
      port.postMessage({ kind: 'sync', afterSeq: Number.MAX_SAFE_INTEGER });
    })()`;
    await evaluateInWorker(cdp, panel.session, observerSource);
    await until(
      async () => (await readEvents()).some((entry) => entry.msg?.type === 'status'),
      'initial production status',
      60000,
    );

    const initialUi = await readPanelUi();
    result.panelStatus = initialUi.statusText;
    if (initialUi.statusText !== '已连接') throw new Error(`production panel not connected: ${initialUi.statusText}`);
    const initialState = await latestStatus();
    result.initialTaskState = initialState;
    if (initialState && initialState !== 'idle') throw new Error(`refusing concurrent run: conversation ${conversationId} is ${initialState}`);

    const protocolModel = (await readEvents())
      .filter((entry) => entry.msg?.type === 'hello_ok' || entry.msg?.type === 'model_info')
      .map((entry) => entry.msg.model)
      .find(Boolean);
    const panelModel = await until(
      async () => {
        const ui = await readPanelUi();
        return ui.modelName || false;
      },
      'real model name from production panel state',
      60000,
    );
    result.model = panelModel;
    result.modelFromProtocol = protocolModel ?? null;
    result.modelSource = 'production panel #model-name / native host state';
    if (/mock|stub|fake|acceptance-model/i.test(panelModel)) {
      throw new Error(`production panel reports non-real model: ${panelModel}`);
    }

    tabA = await createFixtureTab('/form-a');
    tabB = await createFixtureTab('/form-b');
    result.fixtureTabs = { a: tabA.id, b: tabB.id };
    result.initialFixture = { a: await readFixture(tabA.id), b: await readFixture(tabB.id) };

    // Scenario 1: guided real fill through the official compatibility layer.
    const fillText = promptFill();
    const fillSentAt = await sendGuided(fillText);
    const fillStarted = await waitTaskStarted(fillSentAt);
    const fillFinished = await waitTaskFinished(fillSentAt);
    ownsTask = false;
    const fillRuns = await browserRunsSince(fillSentAt);
    const fillPlaywright = assertGuidedPlaywright('scenario 1', fillRuns, /getByLabel/);
    const fillNested = await nestedStepsSince(fillSentAt, fillRuns.map((run) => run.id));
    const fillState = await readFixture(tabA.id);
    await captureTab(tabA.id, '01-scenario1-filled-a.png');
    const fillPassed =
      fillState.name === TEST.fillName &&
      fillState.email === TEST.fillEmail &&
      fillState.submits === 0;
    const fillNestedWrites =
      fillNested.some((step) => step.name === 'fill' && step.params.value === TEST.fillName) &&
      fillNested.some((step) => step.name === 'fill' && step.params.value === TEST.fillEmail);
    result.scenarios.fill = {
      guided: true,
      prompt: fillText,
      sentAt: fillSentAt,
      started: fillStarted,
      finished: fillFinished,
      browserRuns: fillRuns,
      browserRunApiPlaywright: true,
      officialPageMethods: officialMethods(fillPlaywright),
      playwrightRuns: fillPlaywright.map((run) => ({ at: run.at, id: run.id, label: run.label })),
      nestedSteps: fillNested,
      nestedWritesObserved: fillNestedWrites,
      finalState: fillState,
      screenshot: '01-scenario1-filled-a.png',
      passed: fillPassed,
    };
    if (!fillPassed) throw new Error(`scenario 1 failed: ${JSON.stringify(fillState)}`);

    // Scenario 2: stop a real model program after the real sleep tool starts.
    const baselineBeforeAbort = await readFixture(tabA.id);
    const abortText = promptAbort();
    const abortSentAt = await sendGuided(abortText);
    await waitTaskStarted(abortSentAt);
    await until(
      async () => (await browserRunsSince(abortSentAt)).length > 0,
      'browser_run event for abort scenario',
      180000,
    );
    const sleepStep = await until(
      async () => {
        const runs = await browserRunsSince(abortSentAt);
        const steps = await nestedStepsSince(abortSentAt, runs.map((run) => run.id));
        return steps.find((step) => step.name === 'sleep' && Number(step.params.ms ?? 0) >= 1000) ?? false;
      },
      'real sleep tool event for abort scenario',
      180000,
    );
    const stopRequestedAt = Date.now();
    const atStop = await readFixture(tabA.id);
    const stopMethod = await clickNormalStop();
    const abortFinished = await waitTaskFinished(abortSentAt);
    ownsTask = false;
    const abortRuns = await browserRunsSince(abortSentAt);
    const abortPlaywright = assertGuidedPlaywright('scenario 2', abortRuns, /waitForTimeout/);
    const abortRunEnd = (await eventsSince(abortSentAt))
      .filter((entry) => entry.msg?.type === 'agent_event' && entry.msg.event?.kind === 'tool_end' && entry.msg.event.name === 'browser_run')
      .at(-1) ?? null;
    // Raw bridge splits long waits; observe beyond the full guided 8000ms, not its first chunk.
    const requestedSleepMs = 8000;
    const observeUntil = Math.max(
      abortFinished.endedAt + 2500,
      sleepStep.at + requestedSleepMs + 2500,
      Date.now() + 2500,
    );
    while (Date.now() < observeUntil) await pause(500);
    const afterAbort = await readFixture(tabA.id);
    const abortNested = await nestedStepsSince(sleepStep.at, abortRuns.map((run) => run.id));
    const postStopFillSteps = abortNested.filter((step) => step.name === 'fill' && step.at >= stopRequestedAt);
    const abortPassed =
      atStop.name === baselineBeforeAbort.name &&
      atStop.email === baselineBeforeAbort.email &&
      atStop.submits === 0 &&
      afterAbort.name === atStop.name &&
      afterAbort.email === atStop.email &&
      afterAbort.submits === 0 &&
      afterAbort.writes.length === atStop.writes.length &&
      postStopFillSteps.length === 0;
    await captureTab(tabA.id, '02-scenario2-after-abort-a.png');
    result.scenarios.abort = {
      guided: true,
      prompt: abortText,
      sentAt: abortSentAt,
      sleepStartedAt: sleepStep.at,
      requestedSleepMs,
      stopRequestedAt,
      stopMethod,
      executionEndedAt: abortFinished.endedAt,
      idleAt: abortFinished.idleAt,
      browserRuns: abortRuns,
      browserRunApiPlaywright: true,
      officialPageMethods: officialMethods(abortPlaywright),
      playwrightRuns: abortPlaywright.map((run) => ({ at: run.at, id: run.id, label: run.label })),
      browserRunEnd: abortRunEnd,
      stateAtStop: atStop,
      lastWriteBeforeStop: atStop.lastWriteAt,
      stateAfterObservation: afterAbort,
      lastWriteAfterObservation: afterAbort.lastWriteAt,
      postStopFillSteps,
      observedUntil: observeUntil,
      screenshot: '02-scenario2-after-abort-a.png',
      passed: abortPassed,
    };
    if (!abortPassed) throw new Error(`scenario 2 failed: ${JSON.stringify({ atStop, afterAbort, postStopFillSteps })}`);

    // Scenario 3: normal guided rename, with the email intentionally unchanged.
    const renameText = promptRename();
    const renameSentAt = await sendGuided(renameText);
    await waitTaskStarted(renameSentAt);
    const renameFinished = await waitTaskFinished(renameSentAt);
    ownsTask = false;
    const renameRuns = await browserRunsSince(renameSentAt);
    const renamePlaywright = assertGuidedPlaywright('scenario 3', renameRuns, /getByLabel/);
    const renameState = await readFixture(tabA.id);
    const renameBState = await readFixture(tabB.id);
    await captureTab(tabA.id, '03-scenario3-renamed-a.png');
    const renamePassed =
      renameState.name === TEST.rename &&
      renameState.email === TEST.fillEmail &&
      renameState.submits === 0 &&
      renameBState.name === '' &&
      renameBState.email === '' &&
      renameBState.submits === 0;
    result.scenarios.rename = {
      guided: true,
      prompt: renameText,
      sentAt: renameSentAt,
      finished: renameFinished,
      browserRuns: renameRuns,
      browserRunApiPlaywright: true,
      officialPageMethods: officialMethods(renamePlaywright),
      playwrightRuns: renamePlaywright.map((run) => ({ at: run.at, id: run.id, label: run.label })),
      aState: renameState,
      bState: renameBState,
      screenshot: '03-scenario3-renamed-a.png',
      passed: renamePassed,
    };
    if (!renamePassed) throw new Error(`scenario 3 failed: ${JSON.stringify({ renameState, renameBState })}`);

    // Scenario 4: activate the other own fixture during a real wait; the task stays on A.
    const switchText = promptTabSwitch();
    const switchSentAt = await sendGuided(switchText);
    await waitTaskStarted(switchSentAt);
    const switchSleepStep = await until(
      async () => {
        const runs = await browserRunsSince(switchSentAt);
        const steps = await nestedStepsSince(switchSentAt, runs.map((run) => run.id));
        return steps.find((step) => step.name === 'sleep' && Number(step.params.ms ?? 0) >= 1000) ?? false;
      },
      'real sleep tool event for tab-switch scenario',
      180000,
    );
    const bActivatedAt = Date.now();
    await activateFixture(tabB.id, 'during task wait');
    const bActiveDuringWait = await evaluateInWorker(cdp, swSession, `chrome.tabs.get(${tabB.id}).then(t=>t.active)`);
    const switchFinished = await waitTaskFinished(switchSentAt);
    ownsTask = false;
    const switchRuns = await browserRunsSince(switchSentAt);
    const switchPlaywright = assertGuidedPlaywright('scenario 4', switchRuns, /waitForTimeout/);
    const switchNested = await nestedStepsSince(switchSleepStep.at, switchRuns.map((run) => run.id));
    const switchAState = await readFixture(tabA.id);
    const switchBState = await readFixture(tabB.id);
    const bActive = await evaluateInWorker(cdp, swSession, `chrome.tabs.get(${tabB.id}).then((tab) => tab.active === true)`);
    const aWriteAfterActivation = switchAState.writes.find((write) => write.at >= bActivatedAt) ?? null;
    await captureTab(tabA.id, '04-scenario4-target-a.png');
    await captureTab(tabB.id, '05-scenario4-untouched-b.png');
    const switchPassed =
      switchAState.name === TEST.switchProof &&
      switchAState.email === TEST.fillEmail &&
      switchAState.submits === 0 &&
      switchBState.name === '' &&
      switchBState.email === '' &&
      switchBState.submits === 0 &&
      !!aWriteAfterActivation &&
      bActiveDuringWait === true;
    result.scenarios.tabSwitch = {
      guided: true,
      prompt: switchText,
      sentAt: switchSentAt,
      sleepStartedAt: switchSleepStep.at,
      bActivatedAt,
      activationMethod: 'chrome.tabs.update({active:true}); Page.bringToFront was not called',
      finished: switchFinished,
      browserRuns: switchRuns,
      browserRunApiPlaywright: true,
      officialPageMethods: officialMethods(switchPlaywright),
      playwrightRuns: switchPlaywright.map((run) => ({ at: run.at, id: run.id, label: run.label })),
      nestedSteps: switchNested,
      nestedWriteObserved: switchNested.some((step) => step.name === 'fill' && step.params.value === TEST.switchProof),
      aState: switchAState,
      bState: switchBState,
      aWriteAfterActivation,
      bActiveDuringWait,
      bActiveAtEnd: bActive,
      screenshots: ['04-scenario4-target-a.png', '05-scenario4-untouched-b.png'],
      passed: switchPassed,
    };
    if (!switchPassed) {
      throw new Error(`scenario 4 failed: ${JSON.stringify({ switchAState, switchBState, bActive, aWriteAfterActivation })}`);
    }

    result.finalState = { a: await readFixture(tabA.id), b: await readFixture(tabB.id) };
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    result.elapsedMs = Date.now() - startedAt;
    if (cdp && panel) {
      await abortOwnedTask().catch(() => {});
      await sleep(500);
      result.events = await readEvents().catch(() => []);
    }
    await writeEvidence('events.json', result.events ?? []);
    await writeEvidence('result.json', result);
    if (cdp && swSession) {
      try {
        const tabs = await evaluateInWorker(cdp, swSession, 'chrome.tabs.query({})');
        const ownedTabIds = tabs
          .filter((tab) => tab.id != null && (String(tab.url ?? '').startsWith(origin) || tab.id === panel?.tabId))
          .map((tab) => tab.id);
        result.cleanup = {
          keepTabs: process.argv.includes('--keep-tabs'),
          removedTabIds: ownedTabIds,
        };
        if (!process.argv.includes('--keep-tabs') && ownedTabIds.length) {
          await evaluateInWorker(cdp, swSession, `chrome.tabs.remove(${JSON.stringify(ownedTabIds)})`);
        }
      } catch (error) {
        result.cleanup = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (cdp) await cdp.close().catch(() => {});
    fixtureServer.closeAllConnections();
    await new Promise((resolve) => fixtureServer.close(resolve));
    await writeEvidence('result.json', result);
    console.log(JSON.stringify({passed:result.passed,error:result.error,model:result.model,evidenceDir:root,scenarios:Object.fromEntries(Object.entries(result.scenarios).map(([k,v])=>[k,v.passed]))}));
    process.exitCode = result.passed ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
