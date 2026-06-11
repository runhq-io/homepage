import 'dotenv/config';
import { describe, it, expect, afterEach } from 'vitest';
import * as WidgetService from './WidgetService';

// These cover the prompt-injection kill-switch (WIDGET_ATTACHMENTS_ENABLED).
// The guard is the first line of each upload function, before any DB access,
// so the rejection path needs no database.

const ORIGINAL = process.env.WIDGET_ATTACHMENTS_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WIDGET_ATTACHMENTS_ENABLED;
  else process.env.WIDGET_ATTACHMENTS_ENABLED = ORIGINAL;
});

const DUMMY_FILE = { buffer: Buffer.from('x'), mimeType: 'image/png', filename: 'a.png' };

describe('attachmentsEnabled() flag', () => {
  it('defaults to false when the env var is unset', () => {
    delete process.env.WIDGET_ATTACHMENTS_ENABLED;
    expect(WidgetService.attachmentsEnabled()).toBe(false);
  });

  it('is false for any value other than the literal "true"', () => {
    process.env.WIDGET_ATTACHMENTS_ENABLED = '1';
    expect(WidgetService.attachmentsEnabled()).toBe(false);
    process.env.WIDGET_ATTACHMENTS_ENABLED = 'TRUE';
    expect(WidgetService.attachmentsEnabled()).toBe(false);
  });

  it('is true only for the literal "true"', () => {
    process.env.WIDGET_ATTACHMENTS_ENABLED = 'true';
    expect(WidgetService.attachmentsEnabled()).toBe(true);
  });
});

describe('attachment uploads reject when disabled', () => {
  it('uploadTicketAttachment throws attachments_disabled (403) before touching the DB', async () => {
    delete process.env.WIDGET_ATTACHMENTS_ENABLED;
    await expect(
      WidgetService.uploadTicketAttachment('ticket', 'project', 'user', DUMMY_FILE),
    ).rejects.toMatchObject({ code: 'attachments_disabled', status: 403 });
  });

  it('addWidgetCommentAttachment throws attachments_disabled (403) before touching the DB', async () => {
    delete process.env.WIDGET_ATTACHMENTS_ENABLED;
    await expect(
      WidgetService.addWidgetCommentAttachment('project', 'ticket', 'comment', 'user', DUMMY_FILE),
    ).rejects.toMatchObject({ code: 'attachments_disabled', status: 403 });
  });
});
