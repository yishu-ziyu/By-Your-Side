import type { TaskReceipt } from '../../../shared/task-actions.js';
import { receiptCopy } from './receipt-copy.js';

/** Receipt identity is kept; only ordinary accepted records are folded away. */
export function renderReceipt(receipt: TaskReceipt, conversationId: string, previous: HTMLElement | undefined, fork: (receipt: TaskReceipt) => Promise<void>): HTMLElement {
  if (previous?.classList.contains('receipt-decision') && receipt.newConversationRequest && receipt.status === 'rejected') return previous;
  const copy = receiptCopy(receipt, conversationId);
  const root = document.createElement('details');
  root.className = `msg receipt${copy.collapsed ? '' : ' notice'}`;
  root.open = previous instanceof HTMLDetailsElement && previous.open;
  root.dataset.requestId = receipt.requestId;
  root.dataset.runId = receipt.runId ?? '';
  const summary = document.createElement('summary');
  summary.textContent = copy.summary;
  const detail = document.createElement('p');
  detail.textContent = copy.detail;
  root.append(summary, detail);
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
