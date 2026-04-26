/**
 * CommunityLeaderboardService
 *
 * Read-side staff queries for the community points leaderboard.
 *
 * Responsibilities:
 *  - listMembers: paginated leaderboard across all active widget users in a
 *    project, with multiple sort options. LEFT JOIN ensures members with no
 *    balance row still appear (balance=0, rank=null).
 *  - getMember: single-member drill-down with recent point grants.
 *
 * Cursor pagination note (v1 trade-off):
 *   True keyset pagination across multiple composite sort keys (e.g. rank ASC +
 *   name ASC) requires encoding all sort-key values in the cursor and building
 *   a WHERE clause like `(rank, name) > (cursorRank, cursorName)`. That is
 *   correct but complex for v1. Instead this implementation uses OFFSET-based
 *   pagination: the cursor encodes `{ sort, offset }` and the server applies
 *   LIMIT + OFFSET. This is O(n) on large result sets but perfectly fine for
 *   staff UIs querying up to 100 members. A TODO is left for future keyset
 *   migration.
 *
 * TODO(keyset-pagination): replace OFFSET cursor with true keyset encoding once
 *   membership lists grow beyond a few thousand active users.
 */

import { eq, and, asc, desc, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import {
  widgetUsers,
  widgetUserBalances,
  pointGrants,
  type PointGrant,
} from '../../db/schema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SortKey = 'rank' | 'balance' | 'name' | 'recent';

export interface LeaderboardServiceDeps {
  db: NodePgDatabase<typeof schema>;
}

export interface LeaderboardMember {
  widgetUserId: string;
  externalUserId: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  balance: number;
  payoutsCount: number;
  rank: number | null;
  lastPayoutAt: Date | null;
}

export interface LeaderboardMemberDetail extends LeaderboardMember {
  status: 'active' | 'deleted';
}

export interface ListMembersResult {
  members: LeaderboardMember[];
  nextCursor: string | null;
}

export interface GetMemberResult {
  member: LeaderboardMemberDetail;
  recentGrants: PointGrant[];
}

// ---------------------------------------------------------------------------
// Internal cursor encoding
// ---------------------------------------------------------------------------

interface CursorPayload {
  sort: SortKey;
  offset: number;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (typeof parsed.offset === 'number' && typeof parsed.sort === 'string') {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CommunityLeaderboardService
// ---------------------------------------------------------------------------

export class CommunityLeaderboardService {
  private readonly db: NodePgDatabase<typeof schema>;

  constructor(deps: LeaderboardServiceDeps) {
    this.db = deps.db;
  }

  // -------------------------------------------------------------------------
  // listMembers
  // -------------------------------------------------------------------------

  /**
   * Returns a paginated list of active widget users in a project, LEFT JOINed
   * with their balance row so members with no points still appear.
   *
   * Sort options:
   *  - 'rank'    → coalesce(rank, 999999999) ASC, name ASC  (no-rank → bottom)
   *  - 'balance' → coalesce(balance, 0) DESC, name ASC
   *  - 'name'    → name ASC
   *  - 'recent'  → last_seen_at DESC, name ASC
   */
  async listMembers(args: {
    projectId: string;
    sort?: SortKey;
    limit: number;
    cursor?: string;
  }): Promise<ListMembersResult> {
    const sort: SortKey = args.sort ?? 'rank';
    const limit = Math.min(args.limit, 100);

    // Determine OFFSET from cursor (v1 OFFSET-based pagination)
    let offset = 0;
    if (args.cursor) {
      const decoded = decodeCursor(args.cursor);
      if (decoded && decoded.sort === sort) {
        offset = decoded.offset;
      }
    }

    // Build the ORDER BY clauses for the requested sort key
    const orderBy = buildOrderBy(sort);

    // Coalesced balance and payoutsCount expressions (0 when no balance row)
    const balanceExpr = sql<number>`coalesce(${widgetUserBalances.balance}, 0)`;
    const payoutsCountExpr = sql<number>`coalesce(${widgetUserBalances.payoutsCount}, 0)`;

    // Fetch limit+1 rows so we can detect whether a next page exists
    const rows = await this.db
      .select({
        widgetUserId: widgetUsers.id,
        externalUserId: widgetUsers.externalUserId,
        name: widgetUsers.name,
        avatarUrl: widgetUsers.avatarUrl,
        createdAt: widgetUsers.createdAt,
        lastSeenAt: widgetUsers.lastSeenAt,
        balance: balanceExpr,
        payoutsCount: payoutsCountExpr,
        rank: widgetUserBalances.rank,
        lastPayoutAt: widgetUserBalances.lastPayoutAt,
      })
      .from(widgetUsers)
      .leftJoin(
        widgetUserBalances,
        eq(widgetUserBalances.widgetUserId, widgetUsers.id),
      )
      .where(
        and(
          eq(widgetUsers.projectId, args.projectId),
          eq(widgetUsers.status, 'active'),
        ),
      )
      .orderBy(...orderBy)
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const members = hasMore ? rows.slice(0, limit) : rows;

    const nextCursor = hasMore
      ? encodeCursor({ sort, offset: offset + limit })
      : null;

    return { members, nextCursor };
  }

  // -------------------------------------------------------------------------
  // getMember
  // -------------------------------------------------------------------------

  /**
   * Returns a single active or deleted member by widgetUserId + projectId
   * (cross-tenant guard via the combined WHERE), plus their most recent grants.
   *
   * Throws `Error('Member not found')` when no row matches.
   */
  async getMember(args: {
    projectId: string;
    widgetUserId: string;
    recentGrantsLimit?: number;
  }): Promise<GetMemberResult> {
    const grantLimit = args.recentGrantsLimit ?? 25;

    const balanceExpr = sql<number>`coalesce(${widgetUserBalances.balance}, 0)`;
    const payoutsCountExpr = sql<number>`coalesce(${widgetUserBalances.payoutsCount}, 0)`;

    const [row] = await this.db
      .select({
        widgetUserId: widgetUsers.id,
        externalUserId: widgetUsers.externalUserId,
        name: widgetUsers.name,
        avatarUrl: widgetUsers.avatarUrl,
        createdAt: widgetUsers.createdAt,
        lastSeenAt: widgetUsers.lastSeenAt,
        status: widgetUsers.status,
        balance: balanceExpr,
        payoutsCount: payoutsCountExpr,
        rank: widgetUserBalances.rank,
        lastPayoutAt: widgetUserBalances.lastPayoutAt,
      })
      .from(widgetUsers)
      .leftJoin(
        widgetUserBalances,
        eq(widgetUserBalances.widgetUserId, widgetUsers.id),
      )
      .where(
        and(
          eq(widgetUsers.id, args.widgetUserId),
          eq(widgetUsers.projectId, args.projectId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new Error('Member not found');
    }

    const recentGrants = await this.db
      .select()
      .from(pointGrants)
      .where(
        and(
          eq(pointGrants.projectId, args.projectId),
          eq(pointGrants.widgetUserId, args.widgetUserId),
        ),
      )
      .orderBy(desc(pointGrants.createdAt))
      .limit(grantLimit);

    const member: LeaderboardMemberDetail = {
      widgetUserId: row.widgetUserId,
      externalUserId: row.externalUserId,
      name: row.name,
      avatarUrl: row.avatarUrl,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      status: row.status,
      balance: row.balance,
      payoutsCount: row.payoutsCount,
      rank: row.rank,
      lastPayoutAt: row.lastPayoutAt,
    };

    return { member, recentGrants };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the ORDER BY clause array for a given SortKey.
 *
 * All sort options include a `name ASC` tiebreaker for stability.
 */
function buildOrderBy(sort: SortKey): SQL[] {
  switch (sort) {
    case 'rank':
      return [
        asc(sql`coalesce(${widgetUserBalances.rank}, 999999999)`),
        asc(widgetUsers.name),
      ];
    case 'balance':
      return [
        desc(sql`coalesce(${widgetUserBalances.balance}, 0)`),
        asc(widgetUsers.name),
      ];
    case 'name':
      return [asc(widgetUsers.name)];
    case 'recent':
      return [
        desc(widgetUsers.lastSeenAt),
        asc(widgetUsers.name),
      ];
  }
}
