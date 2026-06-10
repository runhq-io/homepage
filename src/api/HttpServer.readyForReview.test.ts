import { describe, expect, it } from 'vitest';
import { prepareServerWorkspaceTaskPatchBody } from './HttpServer';

describe('prepareServerWorkspaceTaskPatchBody', () => {
  it('extracts readyForReview and strips wire-only fields from task updates', () => {
    const result = prepareServerWorkspaceTaskPatchBody({
      status: 'done',
      readyForReview: true,
      actingUserId: 'user_1',
      workspaceJobId: 'job_1',
    });

    expect(result.readyForReview).toBe(true);
    expect(result.body).toEqual({
      status: 'done',
      workspaceJobId: 'job_1',
    });
  });

  it('does not treat status=done alone as ready for PR creation', () => {
    const result = prepareServerWorkspaceTaskPatchBody({ status: 'done' });

    expect(result.readyForReview).toBe(false);
    expect(result.body).toEqual({ status: 'done' });
  });
});
