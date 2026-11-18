import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { TRANSLATION_PROMPT } from '../../../agent/src/page-translation.js';
import type { TranslationCommand, TranslationReceipt, TranslationScope, TranslationSegment } from '../../../shared/page-translation.js';
import { launchRealPath, REPO, requireHeadless, siteAddress, until } from './harness.mts';
import { startScriptedModel } from './scripted-model.mts';

requireHeadless();

type HostCommand = TranslationCommand & { scope?: TranslationScope & { paragraphs?: number[] } };

const first = 'The north station opened in April.';
const second = 'The harbor received a new instrument.';
const third = 'The river rose after midnight.';
const request = '只翻第一段，在原网页显示中文译文。';
const page = `<!doctype html><meta charset="utf-8"><main><nav><p>Weather notes navigation</p></nav><article>
<h1>Weather notes</h1><p hidden>Hidden announcement</p><p id="first">${first}</p>
<p id="report"><a href="#report"><strong>Download the full report</strong></a></p>
<aside><p>Sidebar commentary</p></aside><p id="second">${second}</p><p id="third">${third}</p>
<footer><p>Footer commentary</p></footer></article></main>`;
const site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }).end(page));
const { outputFiles: [commandBundle] } = await build({
  stdin: {
    contents: `import { pageTranslation } from './extension/src/background/exec/page-translation.ts';
      globalThis.paragraphAuthorityCommand = async (command) => {
        try { return await pageTranslation(command, ''); }
        catch (error) { return { error: error.message, executionFact: error.executionFact }; }
      };`,
    resolveDir: REPO,
  },
  bundle: true, write: false,
});

const browser = await launchRealPath({ chromeArgs: [
  '--disable-background-networking', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
] });

try {
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${siteAddress(site).port}/weather`;
  const model = await startScriptedModel([{
    match: request, steps: [{ tool: { name: 'page_translation', args: { action: 'translate', scope: { url, quotes: [third] } } } }],
  }], { delayMs: 0 });

  try {
    const completion = async (messages: Array<{ role: string; content: string }>) => {
      const result = await fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, stream: false }),
      });
      assert.equal(result.status, 200);
      return (await result.json()).choices[0].message;
    };
    const tool = (await completion([{ role: 'user', content: request }])).tool_calls[0].function;
    assert.equal(tool.name, 'page_translation');
    const modelScope = JSON.parse(tool.arguments).scope;
    assert.deepEqual(modelScope, { url, quotes: [third] });

    const work = await browser.attach((await browser.targets()).find(t => t.url === 'about:blank')!.targetId);
    const load = async () => {
      await browser.evaluate(work, 'window.paragraphAuthorityOldDocument = true');
      await browser.cdp.send('Page.navigate', { url }, work);
      await until(async () => await browser.evaluate(work, `location.href === ${JSON.stringify(url)} && !window.paragraphAuthorityOldDocument && document.readyState === 'complete' && !!document.querySelector('#third')`), 10_000, '练习页就绪');
    };
    await load();
    const worker = await browser.attach((await until(() => browser.serviceWorker(), 10_000, '真实扩展后台就绪')).targetId);
    await browser.evaluate(worker, commandBundle!.text);
    const tabId = await browser.evaluate(worker, `chrome.tabs.query({}).then(tabs => tabs.find(t => t.url === ${JSON.stringify(url)}).id)`);
    const command = (value: HostCommand): Promise<TranslationReceipt | { error: string; executionFact: string }> =>
      browser.evaluate(worker, `globalThis.paragraphAuthorityCommand(${JSON.stringify({ ...value, tabId })})`);
    const ok = async (value: HostCommand) => {
      const result = await command(value);
      assert.ok(!('error' in result), JSON.stringify(result));
      return result;
    };
    const batch = async (document: string): Promise<TranslationSegment[]> => {
      const { blocks } = await ok({ action: 'collect', document });
      assert.ok(blocks.length);
      const message = await completion([
        { role: 'system', content: TRANSLATION_PROMPT }, { role: 'user', content: JSON.stringify({ blocks }) },
      ]);
      return JSON.parse(message.content);
    };
    const inspect = () => browser.evaluate(work, `({ html: document.querySelector('main').outerHTML,
      third: document.querySelector('#third').innerHTML, style: !!document.getElementById('sideagent-translation-style'),
      mutations: window.translationMutations || 0 })`);
    await browser.evaluate(work, `window.translationMutations = 0; new MutationObserver(records => window.translationMutations += records.length)
      .observe(document.querySelector('main'), {subtree:true, childList:true, attributes:true, characterData:true})`);
    const before = await inspect();
    const begin = await command({ action: 'begin', scope: { ...modelScope, paragraphs: [1] } });
    if (!('error' in begin)) {
      await ok({ action: 'apply', document: begin.document, translations: await batch(begin.document) });
    }
    const after = await inspect();
    const rejected = 'error' in begin ? begin : null;
    assert.ok(rejected?.executionFact === 'not_executed' && /授权/.test(rejected.error) && JSON.stringify(before) === JSON.stringify(after),
      `${request} 模型选择第三段。预期明确拒绝且页面无写入。实际 ${JSON.stringify({ rejected, before, after })}`);

    for (const paragraphs of [[0], [1.5], [Number.MAX_SAFE_INTEGER], [1, 1], []]) {
      const result = await command({ action: 'begin', scope: { url, quotes: paragraphs.length === 2 ? [first, second] : [first], paragraphs } });
      assert.ok('error' in result && result.executionFact === 'not_executed', JSON.stringify(result));
    }
    assert.deepEqual(await inspect(), before);

    const wrongOrdinal = await command({ action: 'begin', scope: { url, quotes: [second], paragraphs: [3] } });
    const linkOnly = await command({ action: 'begin', scope: { url, quotes: ['Download the full report'], paragraphs: [2] } });
    for (const result of [wrongOrdinal, linkOnly]) assert.ok('error' in result && /授权/.test(result.error), JSON.stringify(result));
    assert.deepEqual(await inspect(), before);

    const correct = await ok({ action: 'begin', scope: { url, quotes: [second, first], paragraphs: [1, 2] } });
    assert.equal((await ok({ action: 'apply', document: correct.document, translations: await batch(correct.document) })).applied, 2);
    assert.equal(await browser.evaluate(work, `Array.from(document.querySelectorAll('[data-bys-translation=true]'), el => el.parentElement.id).join(',')`), 'first,second');
    await ok({ action: 'restore' });
    assert.equal((await inspect()).html, before.html);

    const delayed = await ok({ action: 'begin', scope: { url, quotes: [first], paragraphs: [1] } });
    const output = await batch(delayed.document);
    await browser.evaluate(work, `document.querySelector('#third').before(document.querySelector('#first'))`);
    const moved = await command({ action: 'apply', document: delayed.document, translations: output });
    assert.ok('error' in moved && /段落/.test(moved.error), JSON.stringify(moved));
    assert.equal(await browser.evaluate(work, `!!document.querySelector('[data-bys-translation=true]')`), false);
    await ok({ action: 'restore' });

    await browser.evaluate(work, `document.querySelector('main').insertAdjacentHTML('beforeend', '<article><p>Another visible article.</p></article>')`);
    const ambiguous = await command({ action: 'begin', scope: { url, quotes: [second], paragraphs: [1] } });
    assert.ok('error' in ambiguous && /授权/.test(ambiguous.error), JSON.stringify(ambiguous));

    await browser.evaluate(work, `(() => {
      const canonical = document.createElement('link'); canonical.rel = 'canonical'; canonical.href = location.href;
      const kind = document.createElement('meta'); kind.setAttribute('property','og:type'); kind.content = 'article';
      const title = document.createElement('meta'); title.setAttribute('property','og:title'); title.content = 'Weather notes';
      document.head.append(canonical, kind, title); return true;
    })()`);
    const currentArticle = await command({ action: 'begin', scope: { url, quotes: [second], paragraphs: [1] } });
    assert.ok(!('error' in currentArticle), '有评论文章时仍应能确定当前规范文章的第一段：'+JSON.stringify(currentArticle));
    await ok({action: 'restore'});

    await browser.evaluate(work, `(() => { for (const p of document.querySelectorAll('article:first-of-type p')) { const div=document.createElement('div');div.textContent=p.textContent;p.replaceWith(div); } return true; })()`);
    const commentOnly = await command({ action: 'begin', scope: { url, quotes: ['Another visible article.'], paragraphs: [1] } });
    assert.ok('error' in commentOnly, '正文没有 p 元素时不能把评论当成正文第一段');
    await load();
    const legacy = await ok({ action: 'begin', scope: { url, quotes: [third] } });
    await ok({ action: 'apply', document: legacy.document, translations: await batch(legacy.document) });
    assert.match((await inspect()).third, /中文译文/);
    await load();
    const newDocument = await command({ action: 'apply', document: legacy.document, translations: output });
    assert.ok('error' in newDocument && newDocument.executionFact === 'not_executed', JSON.stringify(newDocument));
    assert.equal((await inspect()).third, before.third);
    console.log('PASS 段落授权拒绝、正文编号、等待期间移动、文档绑定与旧范围兼容');
  } finally {
    await model.close();
  }
} finally {
  await browser.close();
  await browser.remove();
  await new Promise<void>(resolve => site.close(() => resolve()));
}
