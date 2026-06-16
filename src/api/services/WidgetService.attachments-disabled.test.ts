import 'dotenv/config';
import { describe, it, expect, afterEach } from 'vitest';
import * as WidgetService from './WidgetService';

// These cover the widget attachment kill-switch (WIDGET_ATTACHMENTS_ENABLED).
// Explicit false is the first line of each upload function, before any DB
// access, so the rejection path needs no database.

const ORIGINAL = process.env.WIDGET_ATTACHMENTS_ENABLED;
const STORAGE_ENV = [
  'TASK_ATTACHMENT_STORAGE_PROVIDER',
  'TASK_ATTACHMENT_STORAGE_BUCKET',
  'TASK_ATTACHMENT_STORAGE_ENDPOINT',
  'TASK_ATTACHMENT_STORAGE_ACCESS_KEY_ID',
  'TASK_ATTACHMENT_STORAGE_SECRET_ACCESS_KEY',
] as const;
const ORIGINAL_STORAGE = new Map<string, string | undefined>(
  STORAGE_ENV.map((key) => [key, process.env[key]]),
);
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WIDGET_ATTACHMENTS_ENABLED;
  else process.env.WIDGET_ATTACHMENTS_ENABLED = ORIGINAL;
  for (const key of STORAGE_ENV) {
    const value = ORIGINAL_STORAGE.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const DUMMY_FILE = { buffer: Buffer.from('x'), mimeType: 'image/png', filename: 'a.png' };

describe('attachmentsEnabled() flag', () => {
  it('defaults to true when the env var is unset', () => {
    delete process.env.WIDGET_ATTACHMENTS_ENABLED;
    expect(WidgetService.attachmentsEnabled()).toBe(true);
  });

  it('is false only for the literal "false"', () => {
    process.env.WIDGET_ATTACHMENTS_ENABLED = '1';
    expect(WidgetService.attachmentsEnabled()).toBe(true);
    process.env.WIDGET_ATTACHMENTS_ENABLED = 'TRUE';
    expect(WidgetService.attachmentsEnabled()).toBe(true);
    process.env.WIDGET_ATTACHMENTS_ENABLED = 'false';
    expect(WidgetService.attachmentsEnabled()).toBe(false);
  });

  it('reports uploads unavailable until object storage is configured', () => {
    delete process.env.WIDGET_ATTACHMENTS_ENABLED;
    for (const key of STORAGE_ENV) delete process.env[key];
    expect(WidgetService.attachmentUploadsAvailable()).toBe(false);

    process.env.TASK_ATTACHMENT_STORAGE_PROVIDER = 'r2';
    process.env.TASK_ATTACHMENT_STORAGE_BUCKET = 'bucket';
    process.env.TASK_ATTACHMENT_STORAGE_ENDPOINT = 'https://example.invalid';
    process.env.TASK_ATTACHMENT_STORAGE_ACCESS_KEY_ID = 'id';
    process.env.TASK_ATTACHMENT_STORAGE_SECRET_ACCESS_KEY = 'secret';
    expect(WidgetService.attachmentUploadsAvailable()).toBe(true);
  });
});

describe('attachment uploads reject when disabled', () => {
  it('uploadTicketAttachment throws attachments_disabled (403) before touching the DB', async () => {
    process.env.WIDGET_ATTACHMENTS_ENABLED = 'false';
    await expect(
      WidgetService.uploadTicketAttachment('ticket', 'project', 'user', DUMMY_FILE),
    ).rejects.toMatchObject({ code: 'attachments_disabled', status: 403 });
  });

  it('addWidgetCommentAttachment throws attachments_disabled (403) before touching the DB', async () => {
    process.env.WIDGET_ATTACHMENTS_ENABLED = 'false';
    await expect(
      WidgetService.addWidgetCommentAttachment('project', 'ticket', 'comment', 'user', DUMMY_FILE),
    ).rejects.toMatchObject({ code: 'attachments_disabled', status: 403 });
  });
});
