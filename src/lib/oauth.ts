import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';

// Generate a cryptographically random token (URL-safe base64, 32 bytes)
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

// Generate a short authorization code (URL-safe base64, 16 bytes)
export function generateAuthCode(): string {
  return randomBytes(16).toString('base64url');
}

// SHA-256 hash a token for storage
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Verify PKCE: SHA-256(code_verifier) must equal code_challenge
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
  } catch {
    return false; // Different lengths
  }
}

// Hash a client secret for storage
export async function hashClientSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, 10);
}

// Verify a client secret against stored hash
export async function verifyClientSecret(
  secret: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(secret, hash);
}

// First-party client IDs (from env var, comma-separated)
export function getFirstPartyClientIds(): string[] {
  const ids = process.env.FIRST_PARTY_CLIENT_IDS || '';
  return ids.split(',').map((id) => id.trim()).filter(Boolean);
}

export function isFirstPartyClient(clientId: string): boolean {
  return getFirstPartyClientIds().includes(clientId);
}
