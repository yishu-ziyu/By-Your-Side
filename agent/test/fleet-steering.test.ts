import { describe, expect, it, vi } from 'vitest';
import { Fleet } from '../src/fleet.js';

function member(options: { held?: boolean; streaming?: boolean; fail?: boolean } = {}) {
  return {
    isHeld: () => options.held ?? false,
    isStreaming: () => options.streaming ?? true,
    queueSteerForResume: vi.fn(),
    steerSharedRequirement: vi.fn(async () => { if (options.fail) throw new Error('delivery failed'); }),
    abort: vi.fn(),
    dispose: vi.fn(),
  };
}

function fleetWith(members: Record<string, ReturnType<typeof member>>) {
  const rpc = { call: vi.fn(async () => ({})) };
  const fleet = new Fleet({ rpc: rpc as never, sink: { emit: vi.fn(), setStatus: vi.fn() } });

  for (const [id, session] of Object.entries(members)) (fleet as any).workers.set(id, session);

  return { fleet, rpc };
}

describe('shared corrections across mixed member states', () => {
  it('saves an update for a paused member while delivering to a running member', async () => {
    const running = member();
    const paused = member({ held: true, streaming: false });
    const idle = member({ streaming: false });
    const { fleet } = fleetWith({ running, paused, idle });
    const context = { tabId: 7, title: 'source', url: 'https://fixture.test' };
    const result = await fleet.reviseSharedRequirement('名字改为李四', context);
    expect(result).toEqual({ notified: ['running'], queued: ['paused'], skipped: ['idle'], failed: [] });
    expect(paused.queueSteerForResume).toHaveBeenCalledWith('名字改为李四', context, undefined);
    expect(paused.steerSharedRequirement).not.toHaveBeenCalled();
    expect(idle.steerSharedRequirement).not.toHaveBeenCalled();
    expect(running.steerSharedRequirement).toHaveBeenCalledWith('名字改为李四', context);
  });

  it('stops a member whose update failed so it cannot carry on with old instructions', async () => {
    const failed = member({ fail: true });
    const healthy = member();
    const { fleet, rpc } = fleetWith({ failed, healthy });
    const result = await fleet.reviseSharedRequirement('预算改为600');
    expect(failed.abort).toHaveBeenCalledOnce();
    expect(fleet.has('failed')).toBe(false);
    expect(rpc.call).toHaveBeenCalledWith('worker_tabs', { action: 'release', workerId: 'failed' });
    expect(result.failed).toEqual([{ id: 'failed', reason: 'delivery failed' }]);
    expect(result.notified).toEqual(['healthy']);
  });
});
