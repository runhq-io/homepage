import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

type StorageProvider = 'workspace-local' | 'r2' | 's3';

type DownloadableAttachment = {
  storageProvider: StorageProvider;
  storageKey: string;
  originalName?: string | null;
};

const METADATA_VALUE_MAX_LENGTH = 1024;
const STORAGE_FILENAME_MAX_LENGTH = 160;

function toSafeHeaderValue(value: string | null | undefined, maxLength = METADATA_VALUE_MAX_LENGTH): string {
  if (!value) return '';
  return value.replace(/[^\x20-\x7E]/g, '_').slice(0, maxLength);
}

function sanitizeStorageFilename(input: string | null | undefined): string {
  const leaf = String(input || '').split(/[\\/]/).filter(Boolean).pop() || 'attachment';
  const sanitized = leaf
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  return (sanitized || 'attachment').slice(0, STORAGE_FILENAME_MAX_LENGTH);
}

function encodeRFC5987Value(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');
}

function contentDispositionForFilename(originalName: string): string {
  const fallback = toSafeHeaderValue(originalName, STORAGE_FILENAME_MAX_LENGTH)
    .replace(/[\\"]/g, '_')
    .trim() || 'attachment';
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987Value(originalName)}`;
}

export class TaskAttachmentStorageService {
  private client: S3Client | null = null;

  isConfigured(): boolean {
    return !!(
      process.env.TASK_ATTACHMENT_STORAGE_PROVIDER
      && process.env.TASK_ATTACHMENT_STORAGE_BUCKET
      && process.env.TASK_ATTACHMENT_STORAGE_ENDPOINT
      && process.env.TASK_ATTACHMENT_STORAGE_ACCESS_KEY_ID
      && process.env.TASK_ATTACHMENT_STORAGE_SECRET_ACCESS_KEY
    );
  }

  private getClient(): S3Client {
    if (!this.isConfigured()) {
      throw new Error('Task attachment object storage is not configured');
    }
    if (!this.client) {
      this.client = new S3Client({
        region: process.env.TASK_ATTACHMENT_STORAGE_REGION || 'auto',
        endpoint: process.env.TASK_ATTACHMENT_STORAGE_ENDPOINT!,
        forcePathStyle: false,
        credentials: {
          accessKeyId: process.env.TASK_ATTACHMENT_STORAGE_ACCESS_KEY_ID!,
          secretAccessKey: process.env.TASK_ATTACHMENT_STORAGE_SECRET_ACCESS_KEY!,
        },
      });
    }
    return this.client;
  }

  async createDownloadUrl(attachment: DownloadableAttachment, options?: { ttlSeconds?: number }): Promise<string | null> {
    if (attachment.storageProvider === 'workspace-local') return null;
    if (!this.isConfigured()) return null;

    const bucket = process.env.TASK_ATTACHMENT_STORAGE_BUCKET!;
    const defaultTtl = Number(process.env.TASK_ATTACHMENT_STORAGE_PRESIGN_TTL_SECONDS || '604800');
    const rawTtl = options?.ttlSeconds ?? (Number.isFinite(defaultTtl) ? defaultTtl : 604800);
    const expiresIn = Math.max(60, Math.min(rawTtl, 604800));
    const disposition = attachment.originalName
      ? contentDispositionForFilename(attachment.originalName)
      : undefined;

    return getSignedUrl(
      this.getClient(),
      new GetObjectCommand({
        Bucket: bucket,
        Key: attachment.storageKey,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn },
    );
  }

  async storeUpload(params: {
    serverId: string;
    body: Buffer | Uint8Array | ArrayBuffer;
    mimeType: string;
    filename: string;
    originalName?: string | null;
    mode?: 'upload' | 'migration';
    ownerType?: 'task' | 'comment' | 'activity' | 'widget_chat_message';
    ownerLegacyId?: string | null;
  }): Promise<{
    storageProvider: 'r2' | 's3';
    storageKey: string;
    mimeType: string;
    originalName?: string | null;
    url: string | null;
  }> {
    if (!this.isConfigured()) {
      throw new Error('Task attachment object storage is not configured');
    }

    const storageProvider = process.env.TASK_ATTACHMENT_STORAGE_PROVIDER as 'r2' | 's3';
    const bucket = process.env.TASK_ATTACHMENT_STORAGE_BUCKET!;
    const storageFilename = sanitizeStorageFilename(params.filename);
    const ext = (() => {
      const idx = storageFilename.lastIndexOf('.');
      return idx > 0 ? storageFilename.slice(idx) : '';
    })();
    const base = ext ? storageFilename.slice(0, -ext.length) : storageFilename;
    const key = params.mode === 'migration' && params.ownerType && params.ownerLegacyId
      ? [
          'servers',
          params.serverId,
          'workspace-task-migration',
          params.ownerType,
          params.ownerLegacyId,
          storageFilename,
        ].join('/')
      : [
          'servers',
          params.serverId,
          'workspace-tasks',
          `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
        ].join('/');

    await this.getClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: params.body instanceof ArrayBuffer ? Buffer.from(params.body) : params.body,
      ContentType: params.mimeType,
      Metadata: {
        filename: toSafeHeaderValue(storageFilename),
        originalname: toSafeHeaderValue(params.originalName ?? params.filename),
        serverid: toSafeHeaderValue(params.serverId),
      },
    }));

    return {
      storageProvider,
      storageKey: key,
      mimeType: params.mimeType,
      originalName: params.originalName ?? null,
      url: null,
    };
  }

  async deleteStoredObject(input: {
    storageProvider: StorageProvider;
    storageKey: string;
  }): Promise<void> {
    if (input.storageProvider === 'workspace-local') return;
    if (!this.isConfigured()) {
      throw new Error('Task attachment object storage is not configured');
    }

    await this.getClient().send(new DeleteObjectCommand({
      Bucket: process.env.TASK_ATTACHMENT_STORAGE_BUCKET!,
      Key: input.storageKey,
    }));
  }

  /**
   * Fetch the raw bytes of a stored object. Uses the same configured S3 client
   * and bucket as `storeUpload` / `createDownloadUrl` — there is one storage
   * provider per deployment (r2 OR s3, never both simultaneously).
   *
   * Throws if storage is not configured or the object body is absent.
   */
  async getObjectBuffer(input: {
    storageProvider: 'r2' | 's3';
    storageKey: string;
  }): Promise<Buffer> {
    if (!this.isConfigured()) {
      throw new Error('Task attachment object storage is not configured');
    }
    const response = await this.getClient().send(new GetObjectCommand({
      Bucket: process.env.TASK_ATTACHMENT_STORAGE_BUCKET!,
      Key: input.storageKey,
    }));
    if (!response.Body) {
      throw new Error(`getObjectBuffer: no response body for key: ${input.storageKey}`);
    }
    // AWS SDK v3 attaches transformToByteArray() to the Body stream in Node.js.
    const bytes = await (response.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
}
