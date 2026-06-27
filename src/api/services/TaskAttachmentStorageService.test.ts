import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const awsMocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: awsMocks.send })),
  PutObjectCommand: vi.fn((input) => ({ input, type: 'PutObjectCommand' })),
  GetObjectCommand: vi.fn((input) => ({ input, type: 'GetObjectCommand' })),
  DeleteObjectCommand: vi.fn((input) => ({ input, type: 'DeleteObjectCommand' })),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example/attachment'),
}));

import { TaskAttachmentStorageService } from './TaskAttachmentStorageService';

function configureStorageEnv() {
  process.env.TASK_ATTACHMENT_STORAGE_PROVIDER = 'r2';
  process.env.TASK_ATTACHMENT_STORAGE_BUCKET = 'bucket';
  process.env.TASK_ATTACHMENT_STORAGE_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
  process.env.TASK_ATTACHMENT_STORAGE_ACCESS_KEY_ID = 'key';
  process.env.TASK_ATTACHMENT_STORAGE_SECRET_ACCESS_KEY = 'secret';
}

describe('TaskAttachmentStorageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureStorageEnv();
    awsMocks.send.mockResolvedValue({});
  });

  it('uses ASCII-safe object metadata and storage keys for uploaded filenames', async () => {
    const service = new TaskAttachmentStorageService();

    await service.storeUpload({
      serverId: 'ws_test',
      body: Buffer.from('png'),
      mimeType: 'image/png',
      filename: 'Screenshot 2026-05-13 at 8.06.24\u202fPM.png',
      originalName: '제주닷컴\nbad.png',
    });

    const input = vi.mocked(PutObjectCommand).mock.calls[0]?.[0] as any;
    expect(input.Key).toContain('Screenshot 2026-05-13 at 8.06.24_PM');
    expect(input.Key).toMatch(/^[\x20-\x7E]+$/);
    expect(input.Metadata.filename).toMatch(/^[\x20-\x7E]*$/);
    expect(input.Metadata.originalname).toMatch(/^[\x20-\x7E]*$/);
    expect(input.Metadata.originalname).not.toContain('\n');
  });

  it('builds a standards-compatible content disposition for unicode download names', async () => {
    const service = new TaskAttachmentStorageService();

    await service.createDownloadUrl({
      storageProvider: 'r2',
      storageKey: 'servers/ws/workspace-tasks/image.png',
      originalName: '제주 "screen".png',
    });

    const input = vi.mocked(GetObjectCommand).mock.calls[0]?.[0] as any;
    expect(input.ResponseContentDisposition).toMatch(/^[\x20-\x7E]+$/);
    expect(input.ResponseContentDisposition).toContain('filename=');
    expect(input.ResponseContentDisposition).toContain("filename*=UTF-8''%EC%A0%9C%EC%A3%BC");
  });
});
