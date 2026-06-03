import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGithubWebhook } from './verifyWebhook.js';

const secret = 'whsec_test';
const body = JSON.stringify({ action: 'created' });
const goodSig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifyGithubWebhook', () => {
  it('accepts a correct signature', () => {
    expect(verifyGithubWebhook(body, goodSig, secret)).toBe(true);
  });
  it('rejects a wrong signature', () => {
    expect(verifyGithubWebhook(body, 'sha256=deadbeef', secret)).toBe(false);
  });
  it('rejects a missing signature', () => {
    expect(verifyGithubWebhook(body, undefined, secret)).toBe(false);
  });
  it('rejects when the body was tampered with', () => {
    expect(verifyGithubWebhook(body + 'x', goodSig, secret)).toBe(false);
  });
});
