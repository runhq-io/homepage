import { describe, it, expect } from 'vitest';
import {
  isDeployedStatus, deployedEnvId, makeDeployedStatus,
  isTerminalStatus, isOpenStatus, todoStatusRank, todoStatusLabel,
  todoStatusDisplay, TODO_STATUS_DISPLAY,
} from './index';

const envs = [{ id: 'stg', name: 'staging' }, { id: 'prod', name: 'production' }];

describe('deployed status helpers', () => {
  it('detects deployed statuses incl. legacy bare', () => {
    expect(isDeployedStatus('deployed:stg')).toBe(true);
    expect(isDeployedStatus('deployed')).toBe(true);
    expect(isDeployedStatus('merged')).toBe(false);
  });
  it('extracts env id (null for legacy bare)', () => {
    expect(deployedEnvId('deployed:prod')).toBe('prod');
    expect(deployedEnvId('deployed')).toBeNull();
    expect(deployedEnvId('merged')).toBeNull();
  });
  it('builds env-qualified status', () => {
    expect(makeDeployedStatus('prod')).toBe('deployed:prod');
  });
});

describe('terminal/open', () => {
  it('terminal = cancelled or any deployed', () => {
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('deployed:stg')).toBe(true);
    expect(isTerminalStatus('deployed')).toBe(true);
    expect(isTerminalStatus('done')).toBe(false);
    expect(isTerminalStatus('merged')).toBe(false);
    expect(isOpenStatus('done')).toBe(true);
    expect(isOpenStatus('reviewed')).toBe(true);
    expect(isOpenStatus('merged')).toBe(true);
    expect(isOpenStatus('deployed:stg')).toBe(false);
  });
});

describe('ranking', () => {
  it('orders base phases then envs by deployConfig order', () => {
    expect(todoStatusRank('pending', envs)).toBe(0);
    expect(todoStatusRank('done', envs)).toBe(3);
    expect(todoStatusRank('reviewed', envs)).toBe(4);
    expect(todoStatusRank('merged', envs)).toBe(5);
    expect(todoStatusRank('deployed:stg', envs)).toBe(6);
    expect(todoStatusRank('deployed:prod', envs)).toBeGreaterThan(todoStatusRank('deployed:stg', envs));
    expect(todoStatusRank('cancelled', envs)).toBe(-1);
  });
  it('unknown env and legacy bare sort after known envs', () => {
    expect(todoStatusRank('deployed', envs)).toBeGreaterThan(todoStatusRank('deployed:prod', envs));
    expect(todoStatusRank('deployed:ghost', envs)).toBeGreaterThan(todoStatusRank('deployed:prod', envs));
  });
});

describe('label', () => {
  it('renders env name for deployed', () => {
    expect(todoStatusLabel('deployed:prod', envs)).toBe('Deployed → production');
    expect(todoStatusLabel('deployed', envs)).toBe('Deployed');
    expect(todoStatusLabel('reviewed', envs)).toBe('Reviewed');
    expect(todoStatusLabel('merged', envs)).toBe('Merged');
  });
});

describe('display resolver (BE customer-facing)', () => {
  it('maps any deployed:* and bare deployed to the deployed entry', () => {
    expect(todoStatusDisplay('deployed:prod')).toBe(TODO_STATUS_DISPLAY.deployed);
    expect(todoStatusDisplay('deployed')).toBe(TODO_STATUS_DISPLAY.deployed);
    expect(todoStatusDisplay('deployed:prod').label).toBe('Deployed');
  });
  it('maps base statuses to their own entry', () => {
    expect(todoStatusDisplay('reviewed')).toBe(TODO_STATUS_DISPLAY.reviewed);
    expect(todoStatusDisplay('merged')).toBe(TODO_STATUS_DISPLAY.merged);
    expect(todoStatusDisplay('done')).toBe(TODO_STATUS_DISPLAY.done);
  });
  it('falls back to pending for unknown values', () => {
    expect(todoStatusDisplay('needs_review')).toBe(TODO_STATUS_DISPLAY.pending);
    expect(todoStatusDisplay('bogus')).toBe(TODO_STATUS_DISPLAY.pending);
  });
});
