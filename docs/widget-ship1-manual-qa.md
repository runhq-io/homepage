# Widget Ship-1 Manual QA Checklist

Covers the Updates tab and commenting features (Ship-1). Run this against a staging or preview deploy of the widget.

## Prerequisites

- A widget-enabled project with:
  - At least 3 tickets in `done` status (with `completedAt` set)
  - At least 2 tickets in `in_progress` or `pending` status
  - At least 1 ticket in `cancelled` status
  - The current user has authored at least 1 ticket (so "My Tickets" has content)
- A signed-in user in the embedding app (widget initialized with a signed JWT)

## Tabs (Phase 2)

- [ ] Open the widget → it lands on the **Updates** tab by default
- [ ] Updates tab shows **only done** tickets, **newest first** by `completedAt`, with "Shipped Xd ago" relative time under each card
- [ ] Cancelled and open tickets do NOT appear in Updates
- [ ] Done tickets with NO `completedAt` do NOT appear in Updates (defensive filter)
- [ ] Empty-state text is "Nothing shipped yet." when no done tickets exist
- [ ] Recent Tickets tab shows open tickets only (not done / not cancelled) — unchanged behavior
- [ ] My Tickets badge shows a count when logged in and user has submitted tickets
- [ ] When logged out: Updates and Recent Tickets still load; My Tickets button is visibly disabled with hover tooltip "Log in to view your tickets"

## Commenting (Phase 3)

- [ ] Open a ticket detail → comment composer appears below the timeline when logged in
- [ ] Posting a text-only comment: appears immediately in the timeline after auto-refresh
- [ ] Posting a comment with 1 image attachment: image shows in timeline
- [ ] Attempting to attach a non-image file (e.g. `.txt`): file is silently rejected at the picker
- [ ] Attempting a 6th image: 6th is silently rejected (max 5 per comment)
- [ ] Each preview thumbnail has a × to remove before submitting
- [ ] When logged out: composer is replaced by "Log in to comment" prompt

## Edit / Delete

- [ ] Own comment shows Edit and Delete buttons
- [ ] Other users' comments do NOT show Edit/Delete
- [ ] Clicking Edit swaps the action row for a textarea pre-filled with comment body + Save/Cancel
- [ ] Clicking Save after editing: comment body updates, "(edited)" appears next to timestamp
- [ ] Hovering "(edited)" shows the edit time via native tooltip
- [ ] Clicking Cancel during edit: restores Edit/Delete row without saving
- [ ] Clicking Delete: shows inline confirm ("Delete this comment? Delete/Cancel")
- [ ] Confirming Delete: comment disappears from timeline after refresh
- [ ] Cancel on delete: confirm box collapses, action row restored

## Author Labeling

- [ ] External-authed commenter (from embedding app, has both name + externalUserId): displays as `"Alice (app-user id:<externalId>)"`
- [ ] External-authed commenter with no name: displays as `"app-user (id:<externalId>)"`
- [ ] RunHQ-member commenter (from RunHQ app-side posting): displays as just the name
- [ ] No commenters render as bare "Anonymous" when externalUserId is available

## Cross-surface Persistence (Critical — addresses T18)

Posting bridges widget ↔ RunHQ app via the shared `workspace_task_comments` table.

- [ ] Post a comment in the widget → open the same task in the RunHQ workspace UI → comment visible with the widget-author's name
- [ ] Post a comment from the RunHQ workspace UI → refresh the widget detail view → comment appears in the widget timeline with `createdByType='member'` (no `(app-user id:…)` suffix)
- [ ] Edit own widget comment → the `updatedAt` change is visible to the RunHQ-app side (if their UI shows "edited" markers)
- [ ] Delete own widget comment → the comment is gone from both widget and RunHQ-app views

## Regression (make sure existing features still work)

- [ ] Submitting a new ticket still works (inline form at the top of Updates/Recent/My Tickets)
- [ ] Upvoting / downvoting a ticket still works
- [ ] Ticket detail timeline still shows activity entries (task_created, status_change, agent_assigned, etc.) mixed with comments, sorted by createdAt
- [ ] Existing "My Tickets" view shows user's submitted tickets with their status badges (not affected by Updates changes)

## Known Follow-ups (not in Ship-1)

- RunHQ-native login flow (Ship-2 — see design spec appendix)
- Comment attachment editing (delete-and-repost is the workaround)
- Threaded comment replies (out of scope)
