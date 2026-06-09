import { describe, it, expect, vi } from 'vitest';
import { maybeAutoAssign, type AutoAssignDeps } from './WidgetAutoAssign';

const PROJECT = 'proj_1';
const TICKET = 'task_1';
const SERVER = 'ws_1';
const USER = 'wu_1';

function makeDeps(over: Partial<AutoAssignDeps> = {}): AutoAssignDeps {
  return {
    getProject: vi.fn().mockResolvedValue({ serverId: SERVER, agentAssignmentEnabled: true }),
    getTicket: vi.fn().mockResolvedValue({ title: 'Add dark mode', description: 'toggle please' }),
    guard: vi.fn().mockResolvedValue({ safe: true, reasons: [] }),
    clarify: vi.fn().mockResolvedValue({ status: 'ready' }),
    findDuplicate: vi.fn().mockResolvedValue({ duplicateOf: null }),
    suggest: vi.fn().mockResolvedValue({ agentId: 'agent_a', command: 'Implement dark mode' }),
    loadIntakeQa: vi.fn().mockResolvedValue([{ question: 'q', answer: 'a' }]),
    getActor: vi.fn().mockResolvedValue({ externalUserId: 'ext_1', name: 'Jane' }),
    assign: vi.fn().mockResolvedValue({ jobId: 'job_99' }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('maybeAutoAssign', () => {
  it('skips anonymous tickets (no widgetUserId) — Layer 1 identity gate', async () => {
    const deps = makeDeps();
    await maybeAutoAssign(PROJECT, TICKET, undefined, deps);
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.guard).not.toHaveBeenCalled();
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      SERVER,
      TICKET,
      expect.objectContaining({ status: 'skipped_anon' }),
    );
  });

  it('does nothing when the project does not exist', async () => {
    const deps = makeDeps({ getProject: vi.fn().mockResolvedValue(null) });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.recordOutcome).not.toHaveBeenCalled();
  });

  it('does nothing when agent assignment is disabled for the project', async () => {
    const deps = makeDeps({
      getProject: vi.fn().mockResolvedValue({ serverId: SERVER, agentAssignmentEnabled: false }),
    });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.guard).not.toHaveBeenCalled();
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.recordOutcome).not.toHaveBeenCalled();
  });

  it('does not assign when the injection guard flags the ticket (content) — skipped_unsafe', async () => {
    const deps = makeDeps({
      guard: vi.fn().mockResolvedValue({ safe: false, reasons: ['asks for API key'] }),
    });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.suggest).not.toHaveBeenCalled();
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      SERVER,
      TICKET,
      expect.objectContaining({ status: 'skipped_unsafe', reasons: ['asks for API key'] }),
    );
  });

  it('records failed (not skipped_unsafe) when the guard is unavailable', async () => {
    const deps = makeDeps({
      guard: vi.fn().mockResolvedValue({ safe: false, reasons: ['guard_unavailable'], unavailable: true }),
    });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      SERVER,
      TICKET,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('does NOT assign a thin ticket that needs clarification — asks first (needs_clarification)', async () => {
    const deps = makeDeps({
      clarify: vi.fn().mockResolvedValue({ status: 'asking', clarificationId: 'clar_1' }),
    });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.findDuplicate).not.toHaveBeenCalled();
    expect(deps.suggest).not.toHaveBeenCalled();
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      SERVER,
      TICKET,
      expect.objectContaining({ status: 'needs_clarification', clarificationId: 'clar_1' }),
    );
  });

  it('runs the clarify gate AFTER the injection guard (skips clarify on unsafe content)', async () => {
    const clarify = vi.fn().mockResolvedValue({ status: 'ready' });
    const deps = makeDeps({
      guard: vi.fn().mockResolvedValue({ safe: false, reasons: ['asks for secrets'] }),
      clarify,
    });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(clarify).not.toHaveBeenCalled();
    expect(deps.assign).not.toHaveBeenCalled();
  });

  it('proceeds to dedup/suggest/assign when the clarifier says ready', async () => {
    const deps = makeDeps({ clarify: vi.fn().mockResolvedValue({ status: 'ready' }) });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.clarify).toHaveBeenCalledOnce();
    expect(deps.assign).toHaveBeenCalledOnce();
  });

  it('does not assign when a duplicate is found — skipped_duplicate', async () => {
    const deps = makeDeps({
      findDuplicate: vi.fn().mockResolvedValue({ duplicateOf: 'task_other' }),
    });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.suggest).not.toHaveBeenCalled();
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      SERVER,
      TICKET,
      expect.objectContaining({ status: 'skipped_duplicate', duplicateOf: 'task_other' }),
    );
  });

  it('does not assign when no agent is confidently selected — skipped_no_agent', async () => {
    const deps = makeDeps({
      suggest: vi.fn().mockResolvedValue({ agentId: null, command: '' }),
    });
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.assign).not.toHaveBeenCalled();
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      SERVER,
      TICKET,
      expect.objectContaining({ status: 'skipped_no_agent' }),
    );
  });

  it('happy path: guards, dedups, picks an agent, and assigns once with qa + actor', async () => {
    const deps = makeDeps();
    await maybeAutoAssign(PROJECT, TICKET, USER, deps);
    expect(deps.assign).toHaveBeenCalledOnce();
    expect(deps.assign).toHaveBeenCalledWith(
      PROJECT,
      TICKET,
      expect.objectContaining({
        agentId: 'agent_a',
        command: 'Implement dark mode',
        actor: expect.objectContaining({ widgetUserId: USER, externalUserId: 'ext_1', name: 'Jane' }),
        qa: [{ question: 'q', answer: 'a' }],
      }),
    );
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      SERVER,
      TICKET,
      expect.objectContaining({ status: 'assigned', agentId: 'agent_a', jobId: 'job_99' }),
    );
  });

  it('records failed and never throws when assign rejects', async () => {
    const deps = makeDeps({
      assign: vi.fn().mockRejectedValue(new Error('workspace unreachable')),
    });
    await expect(maybeAutoAssign(PROJECT, TICKET, USER, deps)).resolves.toBeUndefined();
    expect(deps.recordOutcome).toHaveBeenCalledWith(
      SERVER,
      TICKET,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('never throws even if a dependency rejects unexpectedly (fire-and-forget contract)', async () => {
    const deps = makeDeps({
      getTicket: vi.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(maybeAutoAssign(PROJECT, TICKET, USER, deps)).resolves.toBeUndefined();
  });
});
