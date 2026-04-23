/**
 * Server Session Keys
 *
 * Loads and manages the Ed25519 keypair used to sign server session JWTs.
 *
 * The private key lives only on the backend (`SERVER_SESSION_PRIVATE_KEY_PEM`).
 * The public key (`SERVER_SESSION_PUBLIC_KEY_PEM`) is safe to distribute — it
 * is injected into every workspace machine so the machine can verify tokens
 * without being able to forge them.
 *
 * ## Key resolution
 *
 * 1. If both env vars are set, they are used.
 * 2. If exactly one half is set, that is always a misconfiguration — throw.
 * 3. If neither is set and `NODE_ENV` is `development` or `test`, generate an
 *    **ephemeral** keypair (in-memory only, new per process start). Never a
 *    committed secret — a compromised repo must not yield a usable signing
 *    key.
 * 4. Otherwise (production, staging, unknown NODE_ENV) — throw. The operator
 *    must provide real keys.
 */

import { importPKCS8, importSPKI, exportJWK, type JWK } from 'jose';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';

// jose@6 exports `CryptoKey` but dropped the legacy `KeyLike` type. Derive the
// key type from the import functions so this file stays portable across
// library versions instead of pinning to a specific exported name.
type ImportedKey = Awaited<ReturnType<typeof importSPKI>>;

export type EdKeyPair = {
  privateKey: ImportedKey;
  publicKey: ImportedKey;
  publicJwk: JWK;
  kid: string;
};

let cached: Promise<EdKeyPair> | null = null;

function normalizePem(raw: string): string {
  // Allow PEMs to be supplied as a single line with literal "\n" escapes
  // (common in CI/secret-manager round-tripping).
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

/** Compute a stable `kid` from the public key JWK (RFC 7638 thumbprint, SHA-256). */
function computeKid(jwk: JWK): string {
  // RFC 7638 canonical JWK members for OKP keys: crv, kty, x
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash('sha256').update(canonical).digest('base64url');
}

function isLocalDevEnv(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  // Strict allowlist — an unset or unknown NODE_ENV does NOT count as "dev".
  // The reviewer concern was that a misconfigured staging env would silently
  // fall through to a shared dev key; with this check the only way to skip
  // providing real keys is to deliberately set NODE_ENV to one of these.
  return nodeEnv === 'development' || nodeEnv === 'test';
}

async function generateEphemeralPems(): Promise<{ privatePem: string; publicPem: string }> {
  // Node's crypto.generateKeyPairSync returns KeyObjects; we PEM-encode them
  // so the downstream code path is identical to env-provided keys.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privatePem = (privateKey as KeyObject).export({ format: 'pem', type: 'pkcs8' }) as string;
  const publicPem = (publicKey as KeyObject).export({ format: 'pem', type: 'spki' }) as string;
  return { privatePem, publicPem };
}

/**
 * Load the Ed25519 keypair. Required in production (hard-fails if missing).
 * In development / test, falls back to an **ephemeral** in-memory keypair.
 * Throws if exactly one half is set — that is always a misconfiguration.
 */
export function getServerSessionKeyPair(): Promise<EdKeyPair> {
  if (cached !== null) return cached;

  cached = (async () => {
    let privatePem = process.env.SERVER_SESSION_PRIVATE_KEY_PEM;
    let publicPem = process.env.SERVER_SESSION_PUBLIC_KEY_PEM;

    if (!privatePem && !publicPem) {
      if (!isLocalDevEnv()) {
        throw new Error(
          'SERVER_SESSION_PRIVATE_KEY_PEM and SERVER_SESSION_PUBLIC_KEY_PEM must be set outside of local dev (NODE_ENV=development|test).',
        );
      }
      const ephemeral = await generateEphemeralPems();
      privatePem = ephemeral.privatePem;
      publicPem = ephemeral.publicPem;
      console.warn(
        `[serverSessionKeys] NODE_ENV=${process.env.NODE_ENV ?? '<unset>'} — generated EPHEMERAL Ed25519 keypair (in-memory only). Tokens signed with this key do not survive process restart and cannot be verified by other processes. Set SERVER_SESSION_PRIVATE_KEY_PEM / SERVER_SESSION_PUBLIC_KEY_PEM for multi-process dev setups.`,
      );
    }
    if (!privatePem || !publicPem) {
      throw new Error(
        'SERVER_SESSION_PRIVATE_KEY_PEM and SERVER_SESSION_PUBLIC_KEY_PEM must both be set (or both unset).',
      );
    }

    const privateKey = await importPKCS8(normalizePem(privatePem), 'EdDSA');
    const publicKey = await importSPKI(normalizePem(publicPem), 'EdDSA');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.alg = 'EdDSA';
    publicJwk.use = 'sig';
    const kid = computeKid(publicJwk);
    publicJwk.kid = kid;

    return { privateKey, publicKey, publicJwk, kid };
  })().catch((err) => {
    // Reset cache on error so a corrected env triggers a retry without restart.
    cached = null;
    throw err;
  });

  return cached;
}

/** Test-only: reset the cached keypair so tests can re-read env vars. */
export function _resetServerSessionKeyPairCache(): void {
  cached = null;
}
