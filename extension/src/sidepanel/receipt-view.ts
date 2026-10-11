import type { TaskReceipt } from '../../../shared/task-actions.js';
import { receiptCopy } from './receipt-copy.js';

/** Receipt identity is kept; only ordinary accepted records are folded away. */
export function renderReceipt(receipt: TaskReceipt, conversationId: string, previous: HTMLElement | undefined, fork: (receipt: TaskReceipt) => Promise<void>): HTMLElement {
  if (previous?.classList.contains('receipt-decision') && receipt.newConversationRequest && receipt.status === 'rejected') return previous;
  const copy = receiptCopy(receipt, conversationId);
  const root = document.createElement('details');
  root.className = `msg receipt${copy.inProcess ? ' receipt-history' : copy.collapsed ? '' : ' notice'}`;

  if (copy.inProcess && receipt.runId) root.dataset.processRunId = receipt.runId;
  root.open = previous instanceof HTMLDetailsElement && previous.open;
  root.dataset.requestId = receipt.requestId;
  root.dataset.runId = receipt.runId ?? '';
  const summary = document.createElement('summary');
  summary.textContent = copy.summary;
  const detail = document.createElement('p');
  detail.textContent = copy.detail;
  root.append(summary, detail);

  if (receipt.needsModel) return needsModelCard(receipt.text.trim() !== '');

  if (!receipt.newConversationRequest || receipt.status !== 'rejected') return root;
  summary.textContent = '查看原请求';
  root.className = 'msg receipt';
  const decision = document.createElement('section');
  decision.className = 'receipt-decision';
  decision.dataset.requestId = receipt.requestId;
  const title = document.createElement('strong');
  title.textContent = '这个新请求要另开会话吗？';
  const description = document.createElement('p');
  description.textContent = '当前任务会继续运行。';
  const actions = document.createElement('div');
  const create = document.createElement('button');
  create.type = 'button'; create.textContent = '另开会话';
  const dismiss = document.createElement('button');
  dismiss.type = 'button'; dismiss.textContent = '暂不处理';
  const status = document.createElement('p'); status.setAttribute('role','status');
  create.onclick = async () => {
    create.disabled = true; dismiss.disabled = true; status.textContent = '正在转交新会话…';

    try { await fork(receipt); status.textContent = '已转交新会话'; }
    catch (error) { status.textContent = error instanceof Error ? error.message : '未能转交，原任务不变。'; create.disabled = false; dismiss.disabled = false; }
  };

  dismiss.onclick = () => { actions.hidden = true; title.textContent = '新请求暂不处理'; description.textContent = '原请求保留在下方记录中。'; };

  actions.append(create,dismiss); decision.append(title,description,actions,status,root);

  return decision;
}

/**
 * 没连模型时的回复：一个能点的入口，不让用户自己去找「更多 → 模型与语音」。
 * 有原话时，侧栏在连好模型后自动重发它（main.ts 的 resendAfterConnect）；只有图片没有字时不重发。
 */
function needsModelCard(resends: boolean): HTMLElement {
  const card = document.createElement('section');
  card.className = 'msg receipt-decision';
  const title = document.createElement('strong');
  title.textContent = '还没连模型';
  const description = document.createElement('p');
  description.textContent = resends ? '连好以后，这句话会自动发出。' : '连好以后，把刚才的话再发一次。';
  const actions = document.createElement('div');
  const connect = document.createElement('button');
  connect.type = 'button'; connect.textContent = '连一个模型';
  connect.onclick = () => void chrome.runtime.openOptionsPage();
  actions.append(connect); card.append(title, description, actions);

  return card;
}

/** 侧栏不会替用户重发这句（回放的旧卡片、不是这个面板发的话）：改回请用户自己再发。 */
export function noteNeedsModelManual(card: HTMLElement): void {
  const description = card.querySelector('p');

  if (description) description.textContent = '连好以后，把刚才的话再发一次。';
}

/** 连好模型后侧栏已重发原话：卡片只留结果，不再提示去连模型。 */
export function markNeedsModelResent(card: HTMLElement, model: string | null): void {
  const title = card.querySelector('strong');

  if (title) title.textContent = model ? `已用 ${model} 重新发送` : '已重新发送';
  card.querySelector('p')?.remove();
  card.querySelector('div')?.remove();
}
