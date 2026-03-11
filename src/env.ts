/**
 * Environment variable loader — must be imported FIRST in server.ts.
 *
 * ESM hoists all `import` statements and executes them before module body code.
 * By isolating dotenv.config() in its own module imported before everything else,
 * process.env is populated before any other module reads it at load time.
 */
import dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(import.meta.dirname ?? '.', '../.env'), override: true });
