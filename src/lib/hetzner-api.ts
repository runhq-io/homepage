/**
 * Hetzner Cloud API client (console-side)
 *
 * Lightweight fetch wrapper for listing and destroying Hetzner servers.
 * Filters by the `app=fishtank` label selector.
 */

const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';

function getHetznerApiToken(): string | undefined {
  return process.env.HETZNER_API_TOKEN;
}

export interface HetznerServer {
  id: number;
  name: string;
  status: string;
  server_type: {
    name: string;
    description: string;
    cores: number;
    memory: number;
  };
  datacenter: {
    name: string;
    description: string;
    location: {
      name: string;
      city: string;
      country: string;
    };
  };
  created: string;
  public_net?: {
    ipv4?: { ip: string };
    ipv6?: { ip: string };
  };
  labels?: Record<string, string>;
}

interface HetznerListResponse {
  servers: HetznerServer[];
  meta?: {
    pagination?: {
      page: number;
      per_page: number;
      last_page: number;
      total_entries: number;
    };
  };
}

async function hetznerRequest<T>(method: string, path: string): Promise<T> {
  const token = getHetznerApiToken();
  if (!token) {
    throw new Error('HETZNER_API_TOKEN is not configured');
  }

  const url = `${HETZNER_API_URL}${path}`;

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
    throw new Error(`Hetzner API error: ${response.status} - ${errorText}`);
  }

  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export async function listHetznerServers(): Promise<HetznerServer[]> {
  const allServers: HetznerServer[] = [];
  let page = 1;

  // Paginate through all servers with the fishtank label
  while (true) {
    const result = await hetznerRequest<HetznerListResponse>(
      'GET',
      `/servers?label_selector=${encodeURIComponent('app=fishtank')}&page=${page}&per_page=50`
    );
    allServers.push(...result.servers);

    const pagination = result.meta?.pagination;
    if (!pagination || page >= pagination.last_page) break;
    page++;
  }

  return allServers;
}

export async function destroyHetznerServer(serverId: number): Promise<void> {
  await hetznerRequest<unknown>('DELETE', `/servers/${serverId}`);
}

export function isHetznerConfigured(): boolean {
  return !!getHetznerApiToken();
}
