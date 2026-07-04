/**
 * communityServices
 *
 * Single, shared instances of the community-points services.
 *
 * Both the canonical awarding path (WorkspaceTaskService.updateTask) and the
 * staff/widget HTTP routes (HttpServer) need these services. Constructing them
 * once here — wired to the real WS broadcaster via `communityPublish` — means
 * every code path emits the same real-time events. server.ts registers the WS
 * sink at startup (see communityBroadcaster).
 */

import { db } from '../../db/index';
import { CommunityPointsService } from './CommunityPointsService';
import { CommunityNotificationService } from './CommunityNotificationService';
import { CommunityLeaderboardService } from './CommunityLeaderboardService';
import { communityPublish } from './communityBroadcaster';

export const communityPointsService = new CommunityPointsService({
  db,
  publish: communityPublish,
});

export const communityNotificationService = new CommunityNotificationService({ db });

export const communityLeaderboardService = new CommunityLeaderboardService({ db });
