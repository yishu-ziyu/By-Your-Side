import type { TaskActionRequest } from '../../shared/task-actions.js';
import { projectTaskView } from '../../shared/task-view.js';
import type { TaskProgressSnapshot } from '../../shared/voice.js';

export function normalizeStaleTextSteer(input: {
  request: TaskActionRequest;
  snapshot: TaskProgressSnapshot | null;
  streaming: boolean;
  held: boolean;
  settleChecking: () => boolean;
}): TaskActionRequest {
  const { request, snapshot } = input;

  if (request.action === 'status') return request;

  if (input.settleChecking() && request.action === 'steer') return { ...request, action: 'start' };

  const delegating = !!snapshot?.continuation && !['COMPLETED', 'STOPPED', 'FAILED'].includes(snapshot.continuation.state);

  if (
    request.source === 'text'
    && !request.taskId
    && !request.forkedFrom
    && request.action === 'steer'
    && !input.streaming
    && !input.held
    && snapshot?.state === 'idle'
    && !projectTaskView(snapshot).resumable
    && !delegating
  ) {
    return { ...request, action: 'start' };
  }

  return request;
}
