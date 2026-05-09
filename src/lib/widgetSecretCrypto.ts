/**
 * Encrypt-at-rest for widget JWT signing secrets.
 *
 * Each widget project has a 32-byte secret used as the HS256 key for signed
 * widget_user JWTs (`widget_projects.api_secret_hash`). Despite the column
 * name, this is a symmetric signing key — it cannot be hashed because the
 * server has to re-derive the same key to verify tokens.
 *
 * To prevent a database-only compromise (read replica, backup, SQL injection)
 * from yielding the ability to forge any user's widget JWT, secrets are
 * wrapped with AES-256-GCM under an env-var key (`WIDGET_SECRET_ENCRYPTION_KEY`).
 *
 * Wire format (base64url-encoded after the prefix):
 *
 *   enc:v1:<base64url(nonce ‖ ciphertext ‖ authTag)>
 *
 * - prefix `enc:v1:` distinguishes ciphertext from any legacy plaintext rows.
 * - nonce: 12 bytes (GCM standard)
 * - authTag: 16 bytes (default)
 * - ciphertext length == plaintext length
 *
 * Legacy plaintext rows (no prefix) are still accepted on read so the system
 * keeps working while a backfill is in flight; new writes always go through
 * `encrypt()`. Once `scripts/encrypt-widget-secrets.ts` has run against prod,
 * legacy support can be dropped.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Maximum age of a widget_user JWT regardless of the `exp` value the
 * customer's issuer sets. 24h matches what `signWidgetUserJwt` mints
 * server-side; tokens minted by customer backends cannot exceed this even
 * with a longer `exp`. Lives here (not in WidgetService) so verification
 * tests don't drag in the DB layer.
 */
export const WIDGET_JWT_MAX_TOKEN_AGE = '24h';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class WidgetSecretCryptoError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WidgetSecretCryptoError';
  }
}

export interface WidgetSecretCryptoDeps {
  /** Override for tests — defaults to reading WIDGET_SECRET_ENCRYPTION_KEY. */
  readKey?: () => string | undefined;
}

export class WidgetSecretCrypto {
  private cachedKey: Buffer | null = null;
  private readonly readKey: () => string | undefined;

  constructor(deps: WidgetSecretCryptoDeps = {}) {
    this.readKey = deps.readKey ?? (() => process.env.WIDGET_SECRET_ENCRYPTION_KEY);
  }

  /** Reset cached key — primarily for tests that swap env between cases. */
  resetCache(): void {
    this.cachedKey = null;
  }

  /**
   * True when an encryption key is configured. Callers that need to refuse
   * starting up without one (production) should check this at boot.
   */
  isConfigured(): boolean {
    return !!this.readKey();
  }

  private getKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    const raw = this.readKey();
    if (!raw) {
      throw new WidgetSecretCryptoError(
        'WIDGET_SECRET_ENCRYPTION_KEY is not set — cannot encrypt or decrypt widget secrets',
      );
    }
    let key: Buffer;
    try {
      key = Buffer.from(raw, 'base64');
    } catch (err) {
      throw new WidgetSecretCryptoError('WIDGET_SECRET_ENCRYPTION_KEY is not valid base64', err);
    }
    if (key.length !== KEY_BYTES) {
      throw new WidgetSecretCryptoError(
        `WIDGET_SECRET_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
      );
    }
    this.cachedKey = key;
    return key;
  }

  /** Returns true iff `stored` is in the encrypted wire format. */
  isEncrypted(stored: string): boolean {
    return stored.startsWith(PREFIX);
  }

  /** Encrypts `plaintext` with the configured key, returning the wire format. */
  encrypt(plaintext: string): string {
    const key = this.getKey();
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGO, key, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (tag.length !== TAG_BYTES) {
      throw new WidgetSecretCryptoError(`unexpected auth tag length: ${tag.length}`);
    }
    const blob = Buffer.concat([nonce, ct, tag]);
    return `${PREFIX}${blob.toString('base64url')}`;
  }

  /**
   * Decrypts `stored`. Accepts both the encrypted wire format and legacy
   * plaintext (returned as-is) for backward compatibility during backfill.
   */
  decrypt(stored: string): string {
    if (!this.isEncrypted(stored)) return stored;
    const blobB64 = stored.slice(PREFIX.length);
    let blob: Buffer;
    try {
      blob = Buffer.from(blobB64, 'base64url');
    } catch (err) {
      throw new WidgetSecretCryptoError('invalid widget secret ciphertext (base64)', err);
    }
    if (blob.length < NONCE_BYTES + TAG_BYTES) {
      throw new WidgetSecretCryptoError('widget secret ciphertext too short');
    }
    const nonce = blob.subarray(0, NONCE_BYTES);
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const ct = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
    const key = this.getKey();
    const decipher = createDecipheriv(ALGO, key, nonce);
    decipher.setAuthTag(tag);
    try {
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf8');
    } catch (err) {
      throw new WidgetSecretCryptoError('widget secret decryption failed (key mismatch or tampered ciphertext)', err);
    }
  }

  /**
   * Returns the HS256 signing-key bytes for a stored secret. Kept separate
   * from `decrypt` so call sites read as "get key for verifying" rather than
   * "decrypt to a string." Returns a fresh Uint8Array.
   */
  async getSigningKey(stored: string): Promise<Uint8Array> {
    const plain = this.decrypt(stored);
    return new TextEncoder().encode(plain);
  }
}

/** Singleton — used everywhere except tests. */
export const widgetSecretCrypto = new WidgetSecretCrypto();

/** Generate a fresh 32-byte key suitable for WIDGET_SECRET_ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
