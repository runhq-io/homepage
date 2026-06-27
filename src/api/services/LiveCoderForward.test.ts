import { describe, it, expect, vi } from 'vitest';
import { forwardLiveMessage, type LiveCoderForwardDeps } from './LiveCoderForward.js';

const deps = (o: Partial<LiveCoderForwardDeps> = {}): LiveCoderForwardDeps => ({
  screen: vi.fn(async () => ({ safe: true, reasons: [] })),
  sendToWorkspace: vi.fn(async () => ({ ok: true })),
  ...o,
});
const base = { conversationId: 'c1', projectId: 'p1', widgetUserId: 'w1', jobChannelId: 'ch1', text: 'tweak header', actor: { externalUserId: 'app:1' } };

describe('forwardLiveMessage', () => {
  it('forwards a safe message', async () => {
    const d = deps();
    expect(await forwardLiveMessage(base, d)).toEqual({ status: 'forwarded' });
    expect(d.sendToWorkspace).toHaveBeenCalledWith(expect.objectContaining({ jobChannelId: 'ch1', text: 'tweak header', conversationId: 'c1' }));
  });
  it('flags unsafe and does not forward', async () => {
    const d = deps({ screen: vi.fn(async () => ({ safe: false, reasons: ['injection'] })) });
    expect(await forwardLiveMessage(base, d)).toEqual({ status: 'flagged' });
    expect(d.sendToWorkspace).not.toHaveBeenCalled();
  });
  it('returns no-job without a job channel', async () => {
    expect(await forwardLiveMessage({ ...base, jobChannelId: '' }, deps())).toEqual({ status: 'no-job' });
  });
});
