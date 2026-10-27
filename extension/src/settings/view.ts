import { dictationSettingsView } from "./dictation.js";
import { TRACE_MAX_AGE_DAYS } from '../../../shared/run-trace-core.js';
import { VOICE_CAPTURE_MAX_AGE_DAYS } from '../../../shared/voice-capture-core.js';
import { CUSTOM_PERSONA_MAX_CHARS } from '../../../shared/voice.js';
import { CUSTOM_TRANSLATION_STYLE_MAX_CHARS } from '../../../shared/translation-style.js';

const toggleRow = (id: string, title: string, desc: string) => `
  <label class="row">
    <span class="row-main"><span class="row-title">${title}</span><span class="row-desc">${desc}</span></span>
    <input id="${id}" type="checkbox" class="sw" role="switch" />
  </label>`;


export function renderSettings(): void {
  document.getElementById("settings")!.innerHTML = `
  <aside class="settings-sidebar">
    <div class="settings-brand"><img src="icons/brand-mark.svg" alt="" /><span>设置</span></div>
    <nav id="settings-nav" aria-label="设置页面"></nav>
    <span class="settings-brand-note">By Your Side</span>
  </aside>
  <div class="settings-pane">
    <header class="settings-page-head"><h1 id="settings-page-title">模型</h1><button class="btn btn-quiet" type="button" id="manage-connections">管理连接</button></header>
    <div class="settings-panel" data-settings-panel="models">
  <section class="sx" aria-labelledby="model-title">
    <div class="sx-head">
      <h2 id="model-title">模型</h2>
      <p class="sx-sub"></p>
    </div>
    <div class="surface rows">
      <div class="row">
        <span class="row-main"><span class="row-title">主模型</span><span id="main-desc" class="row-desc"></span></span>
        <span class="row-ctl pick"><span id="main-icon"></span><select id="main-model" class="sel" aria-label="主模型"></select><button id="main-pick" type="button" class="btn" hidden>去选服务商</button></span>
      </div>
      <div class="row">
        <span class="row-main"><span class="row-title">快速模型</span><span class="row-desc">解释与翻译</span></span>
        <span class="row-ctl"><select id="fast-model" class="sel" aria-label="快速模型"></select></span>
      </div>
      <div class="row">
        <span class="row-main"><span class="row-title">备用模型</span><span class="row-desc">主模型出错时接手</span></span>
        <span class="row-ctl"><select id="backup-model" class="sel" aria-label="备用模型"></select></span>
      </div>
    </div>
    <p id="main-status" class="settings-status" role="status" aria-live="polite"></p>
    <p id="fast-status" class="settings-status" role="status" aria-live="polite"></p>
    <p id="backup-status" class="settings-status" role="status" aria-live="polite"></p>
    <p class="settings-note">备用模型接手时，会话会发送给它的服务商。</p>
    <div class="surface rows">
      <div class="row">
        <span class="row-main"><span class="row-title">比较模型速度</span><span class="row-desc">用同一个简单问题问一遍已连接的模型，看几秒开口、答没答对。</span></span>
        <span class="row-ctl"><button id="speed-test" type="button" class="btn">测一下</button></span>
      </div>
      <div id="speed-results" class="speed" hidden></div>
    </div>
  </section>
    </div>
    <div class="settings-panel" data-settings-panel="connections" hidden>
  <section class="sx" aria-labelledby="connections-title">
    <div class="sx-head"><h2 id="connections-title">连接</h2><p class="sx-sub">用已有订阅登录，或添加服务商密钥。添加连接后，再选择使用的模型。</p></div>
    <div class="connection-toolbar"><span id="connection-count"></span><button type="button" class="btn" id="connection-add">添加连接</button></div>
    <div class="surface plist">
      <div class="search">
        <input id="provider-search" type="search" placeholder="搜索服务商或模型，比如 glm、claude" aria-label="搜索服务商或模型" spellcheck="false" autocomplete="off" />
        <kbd>/</kbd>
      </div>
      <div id="provider-connected"></div>
      <div id="provider-custom"></div>
      <details id="provider-more">
        <summary class="more"><span id="provider-more-names"></span><span class="more-btn"><span class="more-open">展开</span><span class="more-close">收起</span></span></summary>
        <div id="provider-others"></div>
      </details>
      <p id="provider-empty" class="empty" hidden></p>
    </div>
  </section>
    </div>
    <div class="settings-panel" data-settings-panel="voice" hidden>
  ${dictationSettingsView}
  <section class="sx" aria-labelledby="voice-title">
    <div class="sx-head">
      <h2 id="voice-title">语音对话</h2>
      <p class="sx-sub">用声音和助手交谈。先选语音模型，下面的密钥和音色跟着它变。<span id="voice-key-note"></span></p>
    </div>
    <div class="surface rows">
      <div class="row stack">
        <span class="row-main"><span id="voice-model-title" class="row-title">语音模型</span><span id="voice-model-state" class="row-desc"></span></span>
        <div id="voice-model-list" class="radio-rows" role="radiogroup" aria-labelledby="voice-model-title"></div>
      </div>
      <div id="voice-key-row" class="row">
        <span class="row-main"><span class="row-title">阶跃星辰密钥（语音用）</span><span id="voice-state" class="row-desc"></span></span>
        <span class="row-ctl inline">
          <input id="voice-key" class="d-input" type="password" autocomplete="off" spellcheck="false" aria-label="阶跃星辰密钥（语音用）" />
          <button id="voice-save" type="button" class="btn">保存</button>
          <button id="voice-clear" type="button" class="btn btn-quiet" hidden>清除</button>
        </span>
      </div>
      <div class="row stack">
        <span class="row-main"><span id="timbre-title" class="row-title">音色</span><span id="timbre-desc" class="row-desc"></span></span>
        <div id="timbre-list" class="radio-rows" role="radiogroup" aria-labelledby="timbre-title"></div>
      </div>
      <div class="row stack">
        <span class="row-main"><span id="persona-title" class="row-title">语音风格</span><span class="row-desc">只改语气和措辞，下次语音对话生效。</span></span>
        <div id="persona-list" class="radio-rows" role="radiogroup" aria-labelledby="persona-title"></div>
        <div id="persona-custom" class="persona-custom" hidden>
          <textarea id="persona-text" class="d-input" rows="3" maxlength="${CUSTOM_PERSONA_MAX_CHARS}" placeholder="用几句话描述你想要的语气和措辞，比如：说话干脆，带点幽默"></textarea>
          <div class="d-actions">
            <span id="persona-count" class="d-hint"></span>
            <span class="grow"></span>
            <button id="persona-save" type="button" class="btn btn-primary">保存</button>
          </div>
        </div>
      </div>
    </div>
    <p id="voice-status" class="settings-status" role="status" aria-live="polite"></p>
    <p id="persona-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="speech-title">
    <div class="sx-head">
      <h2 id="speech-title">朗读结果</h2>
      <p class="sx-sub">按住说话交代的事做完后，念给你听。和上面的语音对话无关。</p>
    </div>
    <div class="surface rows">
      <div class="row">
        <span class="row-main"><span class="row-title">MiniMax 订阅密钥</span><span id="speech-state" class="row-desc"></span></span>
        <span class="row-ctl inline">
          <input id="speech-key" class="d-input" type="password" autocomplete="off" spellcheck="false" aria-label="MiniMax 订阅密钥" />
          <button id="speech-save" type="button" class="btn">保存</button>
          <button id="speech-clear" type="button" class="btn btn-quiet" hidden>清除</button>
        </span>
      </div>
      ${toggleRow("ptt-speak", "念出按住说话的结果", "念回答的第一句和「留给你的」。要用 MiniMax 订阅密钥（sk-cp- 开头）。")}
    </div>
    <p id="speech-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
    </div>
    <div class="settings-panel" data-settings-panel="appearance" hidden>
  <section class="sx" aria-labelledby="appearance-title"><div class="sx-head"><h2 id="appearance-title">外观</h2></div><div class="surface rows">      <div class="row stack">
        <span class="row-main"><span id="tone-title" class="row-title">界面底色</span><span class="row-desc">侧栏、设置页与网页卡片共用同一套底色色阶。点一下立即切换。</span></span>
        <div id="tone-list" class="radio-rows" role="radiogroup" aria-labelledby="tone-title"></div>
      </div>
      <div class="row stack">
        <span class="row-main"><span id="orb-title" class="row-title">光球</span><span class="row-desc">侧栏首屏和语音里的光球。点一下就换。</span></span>
        <div id="orb-list" class="radio-rows" role="radiogroup" aria-labelledby="orb-title"></div>
      </div>
</div></section>
    </div>
    <div class="settings-panel" data-settings-panel="preferences" hidden>
  <section class="sx" aria-labelledby="selection-title">
    <div class="sx-head"><h2 id="selection-title">划词</h2></div>
    <div class="surface rows">
      ${toggleRow("selection-bar", "选中文字后显示「问助手 / 解释」", `<span id="ask-shortcut-note">关掉后右键「问 By Your Side」仍然可用。</span>已打开的页面立即生效。`)}
      ${toggleRow("link-preview", "按住 Shift 停在链接上，预览目标页", "卡片显示目标页面的标题和要点。预览不打开新标签页，也不带你的登录状态。")}
      ${toggleRow("nudge", "主动建议", "可以帮忙时，在页面右下角显示建议。")}
    </div>
    <details class="settings-detail"><summary>主动建议会读取什么？</summary><p>如果助手能帮上忙，就在页面右下角显示一张小卡。点小卡，侧栏就开始做。每次判断会把当前页面和最近页面的摘录发给快速模型，没设快速模型时发给主模型。同一个页面只判断一次。</p></details>
    <p id="selection-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="translation-title">
    <div class="sx-head"><h2 id="translation-title">翻译</h2><p class="sx-sub">在网页上按 ⌥T 整页翻译，再按一次还原。</p></div>
    <div class="surface rows">
      <div class="row stack">
        <span class="row-main"><span id="translation-style-title" class="row-title">翻译风格</span><span class="row-desc">整页翻译用的语气和措辞。换了风格，再翻时按新风格重译。</span></span>
        <div id="translation-style-list" class="radio-rows" role="radiogroup" aria-labelledby="translation-style-title"></div>
        <div id="translation-style-custom" class="persona-custom" hidden>
          <textarea id="translation-style-text" class="d-input" rows="3" maxlength="${CUSTOM_TRANSLATION_STYLE_MAX_CHARS}" placeholder="用一两句话说你想要的译文，比如：术语保留英文，语气口语一点"></textarea>
          <div class="d-actions">
            <span id="translation-style-count" class="d-hint"></span>
            <span class="grow"></span>
            <button id="translation-style-save" type="button" class="btn btn-primary">保存</button>
          </div>
        </div>
      </div>
      ${toggleRow("edge-entry", "网页右边缘的翻译入口", "平时在网页右边露一条窄边，鼠标靠近就展开「翻译 这一页」。关掉后 ⌥T 和侧栏按钮照常可用。")}
    </div>
    <p id="translation-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="open-threads-title">
    <div class="sx-head"><h2 id="open-threads-title">继续上次的事</h2></div>
    <div class="surface rows">
      ${toggleRow("open-threads", "新会话里显示没做完的事", "最多显示 3 张卡：中断的任务、归你的页面、没答完的追问。卡片来自这个浏览器里的记录。点 ×，这张卡 7 天内不再显示。")}
    </div>
    <p id="open-threads-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="cues-title">
    <div class="sx-head"><h2 id="cues-title">声音</h2></div>
    <div class="surface rows">
      ${toggleRow("attention-cues", "提示音", "你没在看开着侧栏的窗口时，任务做完响一声；要你确认或动手时响另一声。")}
    </div>
    <p id="cues-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="labs-title">
    <div class="sx-head"><h2 id="labs-title">实验功能</h2></div>
    <div class="surface rows">
      ${toggleRow("mini-apps", "回答里的小程序", "在回答中调整条件、筛选比较或运行小模拟。")}
    </div>
    <details class="settings-detail"><summary>小程序可以访问什么？</summary><p>要动手试的问题（调几个条件看结果、筛选比较一批东西、小模拟），助手当场写一个小程序放在回答里。小程序在侧栏的沙箱里运行，不能联网，碰不到你的网页和登录；你在里面改过的东西重开侧栏还在。写小程序比写文字慢几秒。</p></details>
    <p id="labs-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
    </div>
    <div class="settings-panel" data-settings-panel="data" hidden>
  <section class="sx" aria-labelledby="habits-title">
    <div class="sx-head"><h2 id="habits-title">习惯</h2></div>
    <div class="surface rows">
      ${toggleRow("browse-habits", "从我的浏览里学习习惯", "发现你反复做的事，再询问是否记住。")}
    </div>
    <details class="settings-detail"><summary>记录哪些内容，怎样删除？</summary><p>记下网页标题、网址、你点的按钮和链接、搜索词和填写的内容，交给快速模型找出你反复做的事。密码栏和卡号栏的值不记，助手替你做事时的操作也不记。同一件事在 2 天里出现过，就问你要不要记住。记录在侧栏「记忆」里能看、能删。</p></details>
    <p id="habits-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="memory-backup-title">
    <div class="sx-head"><h2 id="memory-backup-title">记忆备份</h2></div>
    <div class="surface rows">
      <div class="row">
        <span class="row-main"><span class="row-title">从备份恢复记忆</span><span id="memory-backup-desc" class="row-desc">卸载扩展会删掉记忆，所以记忆每次变化都会自动另存到下载文件夹的 By-Your-Side 里，不上传。重装后在这里选那份文件。</span></span>
        <span class="row-ctl inline">
          <button id="memory-backup-pick" type="button" class="btn">选择文件</button>
          <button id="memory-backup-confirm" type="button" class="btn" hidden>覆盖并恢复</button>
          <input id="memory-backup-file" type="file" accept=".json,application/json" hidden />
        </span>
      </div>
    </div>
    <p id="memory-backup-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
  <section class="sx" aria-labelledby="trace-title">
    <div class="sx-head"><h2 id="trace-title">诊断记录</h2></div>
    <div class="surface rows">
      <div class="row">
        <span class="row-main"><span class="row-title">任务步骤与语音识别记录</span><span class="row-desc">只存在这个浏览器里，不上传。导出前，我们去掉能识别出的密码和密钥。不存录音。任务保留 ${TRACE_MAX_AGE_DAYS} 天，语音保留 ${VOICE_CAPTURE_MAX_AGE_DAYS} 天。排查问题时导出给开发者。</span></span>
        <span class="row-ctl inline">
          <button id="trace-export" type="button" class="btn">导出</button>
          <button id="trace-clear" type="button" class="btn btn-quiet">清空</button>
        </span>
      </div>
    </div>
    <p id="trace-status" class="settings-status" role="status" aria-live="polite"></p>
  </section>
    </div>
  </div>
  <dialog id="connection-dialog" class="connection-dialog" aria-labelledby="connection-heading">
    <header class="connection-dialog-head"><h2 id="connection-heading">连接</h2><button id="connection-close" class="icon-btn" type="button" aria-label="关闭连接详情"></button></header>
    <div id="provider-form" class="detail" hidden>
      <div id="region-row" class="seg" role="radiogroup" aria-label="地区" hidden></div>
      <label id="base-url-row" class="d-field" hidden>
        <span class="d-label">服务地址（OpenAI 兼容）</span><span class="d-hint">这里编辑同一条自定义连接。更新地址后，现有用途会一起使用新地址，模型名称保留。</span>
        <input id="base-url" class="d-input" type="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/v1" />
      </label>
      <div id="oauth-row" class="d-field" hidden>
        <div class="d-cred">
          <span id="oauth-ok" class="ok-ic" hidden></span>
          <span id="oauth-state" class="d-cred-text"></span>
          <span class="d-cred-acts">
            <button id="oauth-login" type="button" class="btn"></button>
            <button id="oauth-cancel" type="button" class="btn btn-quiet" hidden>取消登录</button>
            <button id="oauth-logout" type="button" class="btn btn-quiet" hidden>退出登录</button>
          </span>
        </div>
        <div id="oauth-flow" class="oauth-flow" hidden></div>
      </div>
      <div id="key-saved" class="d-cred" hidden>
        <span class="key-ic"></span>
        <span class="d-cred-text">已存密钥<span id="key-tail" class="d-mono"></span></span>
        <span class="d-cred-acts">
          <button id="key-change" type="button" class="btn btn-quiet">更换</button>
          <button id="key-delete" type="button" class="btn btn-quiet">删除</button>
        </span>
      </div>
      <label id="key-row" class="d-field">
        <span id="key-label" class="d-label">密钥</span>
        <input id="api-key" class="d-input" type="password" autocomplete="off" spellcheck="false" />
      </label>
      <p id="key-reason" class="key-reason" role="status" aria-live="polite" hidden>
        <span class="key-reason-icon" aria-hidden="true">i</span>
        <span class="key-reason-copy">
          <span id="key-reason-text"></span>
          <button id="key-retry" type="button" class="btn btn-quiet key-reason-retry" hidden>重试</button>
        </span>
      </p>
      <div class="d-field">
        <span class="d-label"><span>模型</span><span id="model-meta" class="d-label-meta"></span></span>
        <div class="combo">
          <input id="model-id" class="d-input" role="combobox" aria-label="模型" aria-controls="model-options" aria-expanded="false" autocomplete="off" spellcheck="false" placeholder="选择或输入模型名称" />
          <button id="model-toggle" type="button" class="combo-btn" tabindex="-1" aria-label="展开模型列表"></button>
        </div>
        <div id="model-options" class="combo-list" role="listbox" popover="manual"></div>
      </div>
      <div class="d-actions">
        <button id="model-test" type="button" class="btn btn-quiet">测试连接</button>
        <button id="codex-refresh" type="button" class="btn btn-quiet" hidden>刷新模型列表</button>
        <button id="connection-remove" type="button" class="btn btn-quiet" hidden>移除连接</button>
        <button id="model-fast" type="button" class="btn btn-quiet">选择模型</button>
        <span class="grow"></span>
        <button id="model-save" type="button" class="btn btn-primary">验证并保存</button>
      </div>
      <p id="model-status" class="settings-status" role="status" aria-live="polite"></p>
    </div>
  </dialog>
`;
}
