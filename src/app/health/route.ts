import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type BuildInfo = {
  gitSha?: string;
  ref?: string;
  runNumber?: number;
  builtAt?: string;
};

let cachedBuildInfo: BuildInfo | null | undefined;
let cachedNextBuildId: string | null | undefined;

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function getBuildInfo(): BuildInfo | null {
  if (cachedBuildInfo !== undefined) return cachedBuildInfo;
  const filePath = path.join(process.cwd(), 'public', 'build-info.json');
  cachedBuildInfo = readJsonFile<BuildInfo>(filePath);
  return cachedBuildInfo;
}

function getNextBuildId(): string | null {
  if (cachedNextBuildId !== undefined) return cachedNextBuildId;
  const filePath = path.join(process.cwd(), '.next', 'BUILD_ID');
  try {
    cachedNextBuildId = fs.readFileSync(filePath, 'utf8').trim() || null;
  } catch {
    cachedNextBuildId = null;
  }
  return cachedNextBuildId;
}

// GET /health
// Public uptime endpoint.
export async function GET() {
  const start = Date.now();

  const buildInfo = getBuildInfo();
  const nextBuildId = getNextBuildId();

  const responseTimeMs = Date.now() - start;

  const response = NextResponse.json(
    {
      status: 'ok',
      service: 'be',
      timestamp: Date.now(),
      responseTimeMs,
      build: {
        ...(buildInfo ?? {}),
        nextBuildId,
      },
    },
    { status: 200 }
  );

  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('x-response-time-ms', String(responseTimeMs));
  return response;
}
