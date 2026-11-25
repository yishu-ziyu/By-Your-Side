import { TabCollectorController, type CollectedRow, type CollectorSession } from "../../../shared/tab-collector.js";

export interface CollectorCardHandle {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  startCollecting: (fields?: string[]) => void;
  captureTab: (tabId: number, url: string) => Promise<boolean>;
}

interface CollectorCardOptions {
  composerEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
}

function defaultFields(raw: string): string[] {
  const list = raw.split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list.slice(0, 6) : ["标题", "价格", "亮点"];
}

async function readTabSnapshot(tabId: number, fields: string[]): Promise<CollectedRow | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:\/\//i.test(tab.url)) return null;

    const extracted = await chrome.tabs.sendMessage(tabId, {
      type: "bys_selector_extract",
      fields: [
        { name: "__h1", selector: "h1" },
        { name: "__price", selector: "[class*='price'], [id*='price'], .prod-price" },
        { name: "__note", selector: ".prod-note, main p:not([class*='price']), article p:not([class*='price']), p:not([class*='price'])" },
      ],
    }).catch(() => null) as { ok?: boolean; data?: Record<string, string> } | null;

    const raw = extracted?.data ?? {};
    const tabHead = (tab.title ?? "").split(/\s[-–—|_·]\s/)[0]?.trim() ?? "";
    const heading = raw.__h1 ?? "";
    const title = (tabHead && heading.startsWith(tabHead) && heading.length - tabHead.length <= 6 ? tabHead : heading) || tab.title || tab.url;
    const price = raw.__price || "";
    const note = (raw.__note || "").slice(0, 48);

    const cells: CollectedRow["cells"] = {};
    fields.forEach((field, idx) => {
      if (idx === 0) cells[field] = { value: title, quote: title };
      else if (idx === 1) cells[field] = { value: price || "—", quote: price || title };
      else cells[field] = { value: note || "—", quote: note || title };
    });

    return { tabId, url: tab.url, title, cells };
  } catch {
    return null;
  }
}

export function mountCollectorCard({ composerEl, inputEl }: CollectorCardOptions): CollectorCardHandle {
  const root = document.createElement("section");
  root.id = "collector-card";
  root.className = "bys-tray-card";
  root.hidden = true;
  composerEl.parentElement!.insertBefore(root, composerEl);

  const header = document.createElement("div");
  header.className = "bys-tray-head";
  const titleEl = document.createElement("span");
  titleEl.className = "bys-tray-title";
  titleEl.textContent = "边逛边吸收集表";
  const actionsEl = document.createElement("div");
  actionsEl.className = "bys-tray-actions";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "bys-tray-btn primary";
  toggleBtn.textContent = "开始收集";

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "bys-tray-btn";
  sendBtn.textContent = "发给助手对比";
  sendBtn.hidden = true;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "bys-tray-btn";
  closeBtn.textContent = "收起";

  actionsEl.append(toggleBtn, sendBtn, closeBtn);
  header.append(titleEl, actionsEl);

  const fieldsInput = document.createElement("input");
  fieldsInput.type = "text";
  fieldsInput.className = "bys-tray-input";
  fieldsInput.value = "名称, 价格, 亮点";
  fieldsInput.placeholder = "输入要收集的列名，用逗号隔开";

  const tableWrap = document.createElement("div");
  tableWrap.className = "bys-tray-table-wrap";

  root.append(header, fieldsInput, tableWrap);

  const render = (session: CollectorSession): void => {
    toggleBtn.textContent = session.active ? "结束收集" : "开始收集";
    fieldsInput.disabled = session.active;
    sendBtn.hidden = session.rows.length < 2;

    if (session.rows.length === 0) {
      const hint = document.createElement("p");
      hint.className = "bys-tray-hint";
      hint.textContent = session.active ? "切到任意网页标签页，这里会自动收进一行。" : "点「开始收集」后，浏览不同标签页会自动汇总成表。";
      tableWrap.replaceChildren(hint);
      return;
    }

    const table = document.createElement("table");
    table.className = "bys-tray-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const field of session.fields) {
      const th = document.createElement("th");
      th.textContent = field;
      headRow.append(th);
    }
    thead.append(headRow);

    const tbody = document.createElement("tbody");
    for (const row of session.rows) {
      const tr = document.createElement("tr");
      tr.className = "bys-tray-row";
      tr.title = "点击跳回原标签页";
      for (const field of session.fields) {
        const td = document.createElement("td");
        td.textContent = row.cells[field]?.value ?? "—";
        td.addEventListener("click", () => {
          void controller.inspectCell(row, field);
        });
        tr.append(td);
      }
      tbody.append(tr);
    }

    table.append(thead, tbody);
    tableWrap.replaceChildren(table);
  };

  const controller = new TabCollectorController(
    (tabId, fields) => readTabSnapshot(tabId, fields),
    async (tabId) => {
      try {
        await chrome.tabs.update(tabId, { active: true });
      } catch {
      }
    },
    render,
  );

  const captureActive = async (tabId: number): Promise<void> => {
    if (!controller.snapshot.active) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) await controller.onTabVisited(tabId, tab.url);
    } catch {
    }
  };

  toggleBtn.addEventListener("click", () => {
    if (controller.snapshot.active) {
      controller.stop();
      return;
    }
    controller.start(defaultFields(fieldsInput.value));
    if (typeof chrome !== "undefined" && chrome.tabs?.query) {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id && tab.url) void controller.onTabVisited(tab.id, tab.url);
      }).catch(() => {});
    }
  });

  sendBtn.addEventListener("click", () => {
    const { fields, rows } = controller.snapshot;
    const lines = rows.map((row) => fields.map((f) => `${f}: ${row.cells[f]?.value ?? "—"}`).join(" | "));
    inputEl.value = `这是我刚跨标签页收集到的 ${rows.length} 条记录，请帮我做对比并给出建议：\n${lines.join("\n")}`;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.focus();
  });

  closeBtn.addEventListener("click", () => {
    controller.stop();
    root.hidden = true;
  });

  if (typeof chrome !== "undefined" && chrome.tabs) {
    chrome.tabs.onActivated?.addListener((info) => {
      void captureActive(info.tabId);
    });
    chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
      if (changeInfo.status === "complete") void captureActive(tabId);
    });
  }

  render(controller.snapshot);

  return {
    open: () => { root.hidden = false; },
    close: () => { controller.stop(); root.hidden = true; },
    isOpen: () => !root.hidden,
    startCollecting: (fields) => {
      root.hidden = false;
      if (fields?.length) fieldsInput.value = fields.join(", ");
      controller.start(defaultFields(fieldsInput.value));
    },
    captureTab: (tabId, url) => controller.onTabVisited(tabId, url),
  };
}
