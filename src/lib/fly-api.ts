/**
 * Fly.io Machines API client (console-side)
 *
 * Lightweight fetch wrapper for listing and destroying Fly machines.
 * Uses the same env vars as the API's FlyService.
 */

const FLY_API_URL = 'https://api.machines.dev/v1';

function getFlyApiToken(): string | undefined {
  return process.env.FLY_API_TOKEN;
}

function getServerAppName(): string {
  return process.env.SERVER_APP || process.env.FLY_APP_NAME || 'runhq-workspaces';
}

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at: string;
  config?: {
    guest?: {
      cpus?: number;
      memory_mb?: number;
      cpu_kind?: string;
    };
  };
}

async function flyRequest<T>(method: string, path: string): Promise<T> {
  const token = getFlyApiToken();
  if (!token) {
    throw new Error('FLY_API_TOKEN is not configured');
  }

  const app = getServerAppName();
  const url = `${FLY_API_URL}/apps/${app}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Fly.io API error: ${response.status} - ${errorText}`);
  }

  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function listFlyMachines(): Promise<FlyMachine[]> {
  return flyRequest<FlyMachine[]>('GET', '/machines');
}

export async function destroyFlyMachine(machineId: string): Promise<void> {
  await flyRequest<unknown>('DELETE', `/machines/${machineId}?force=true`);
}

export function isFlyConfigured(): boolean {
  return !!getFlyApiToken();
}
