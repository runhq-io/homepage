import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityBroadcastMessage } from '@runhq/server-protocol';
import {
  communityPublish,
  setCommunityBroadcastSink,
  __resetCommunityBroadcastSinkForTests,
} from './communityBroadcaster';

afterEach(() => {
  __resetCommunityBroadcastSinkForTests();
});

const sampleMessage: CommunityBroadcastMessage = {
  type: 'community_notification',
  projectId: 'proj-1',
  widgetUserId: 'wu-1',
  notificationId: 'notif-1',
};

describe('communityBroadcaster', () => {
  it('forwards published messages to the registered sink', () => {
    const sink = vi.fn();
    setCommunityBroadcastSink(sink);

    communityPublish('community:proj-1', sampleMessage);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('community:proj-1', sampleMessage);
  });

  it('is a no-op (does not throw) when no sink is registered', () => {
    // No sink set — publishing before the WS server is wired must be safe.
    expect(() => communityPublish('community:proj-1', sampleMessage)).not.toThrow();
  });

  it('uses the most recently registered sink', () => {
    const first = vi.fn();
    const second = vi.fn();
    setCommunityBroadcastSink(first);
    setCommunityBroadcastSink(second);

    communityPublish('community:widget_user:wu-1', sampleMessage);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('community:widget_user:wu-1', sampleMessage);
  });
});
