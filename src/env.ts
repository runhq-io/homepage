/**
 * Environment variable loader — must be imported FIRST in server.ts.
 *
 * ESM hoists all `import` statements and executes them before module body code.
 * By isolating dotenv.config() in its own module imported before everything else,
 * process.env is populated before any other module reads it at load time.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import dotenv from 'dotenv';
import * as path from 'node:path';

// Next.js 16 checks globalThis.AsyncLocalStorage at module load time.
// In a custom server via tsx, the Next.js bootstrap that sets this global
// hasn't run yet, so we set it here before any Next.js module loads.
(globalThis as any).AsyncLocalStorage = AsyncLocalStorage;

dotenv.config({ path: path.resolve(import.meta.dirname ?? '.', '../.env'), override: true });
