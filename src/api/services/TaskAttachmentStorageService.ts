import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

type StorageProvider = 'workspace-local' | 'r2' | 's3';

type DownloadableAttachment = {
  storageProvider: StorageProvider;
  storageKey: string;
  originalName?: string | null;
};

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

  async createDownloadUrl(attachment: DownloadableAttachment): Promise<string | null> {
    if (attachment.storageProvider === 'workspace-local') return null;
    if (!this.isConfigured()) return null;

    const bucket = process.env.TASK_ATTACHMENT_STORAGE_BUCKET!;
    const expiresIn = Number(process.env.TASK_ATTACHMENT_STORAGE_PRESIGN_TTL_SECONDS || '86400');
    const disposition = attachment.originalName
      ? `inline; filename="${attachment.originalName.replace(/"/g, '')}"`
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
    ownerType?: 'task' | 'comment' | 'activity';
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
    const ext = (() => {
      const idx = params.filename.lastIndexOf('.');
      return idx >= 0 ? params.filename.slice(idx) : '';
    })();
    const base = ext ? params.filename.slice(0, -ext.length) : params.filename;
    const key = params.mode === 'migration' && params.ownerType && params.ownerLegacyId
      ? [
          'servers',
          params.serverId,
          'workspace-task-migration',
          params.ownerType,
          params.ownerLegacyId,
          params.filename,
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
        filename: params.filename,
        originalname: params.originalName ?? '',
        serverid: params.serverId,
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
}
