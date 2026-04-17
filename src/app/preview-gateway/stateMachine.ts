export type GatewayStep =
  | 'auth'
  | 'channel-lookup'
  | 'wake'
  | 'start-channel'
  | 'poll'
  | 'mint'
  | 'redirect';

export type GatewayResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'redirect-login' }
  | { kind: 'error'; reason: 'no-access' | 'destroyed' | 'invalid-target' }
  | { kind: 'timeout' };

export interface GatewayDeps {
  isAuthenticated: () => Promise<boolean>;
  channelForPort: (args: { serverId: string; port: number }) => Promise<{
    channelId: string;
    channelName: string;
    startingCommand: string | null;
  } | null>;
  wakeServer: (args: { serverId: string }) => Promise<{
    success: boolean;
    status: 'running' | 'starting' | 'online' | 'stopped' | 'suspended' | 'destroyed' | 'error';
  }>;
  startChannel: (args: { serverId: string; channelId: string; force: boolean }) => Promise<{
    started: boolean;
    alreadyStarted: boolean;
    terminalSessionId: string | null;
    bootId: string | null;
    channelMissing?: boolean;
  }>;
  probeReady: (args: { serverId: string; port: number }) => Promise<boolean>;
  mintToken: (args: { serverId: string }) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  onStep: (step: GatewayStep) => void;
  pollIntervalMs?: number; // default 1000
  maxPollMs?: number;      // default 90_000
}

export interface GatewayArgs extends GatewayDeps {
  target: string;      // full preview URL e.g. https://3000-abc.preview.runhq.io/path
  machineId: string;   // extracted by caller
  port: number;        // extracted by caller
  serverId: string;    // resolved by caller (machineId→serverId lookup)
  attempts?: number;   // __pg_attempts from URL, default 0
}

export async function runGateway(args: GatewayArgs): Promise<GatewayResult> {
  const {
    target,
    port,
    serverId,
    attempts,
    isAuthenticated,
    channelForPort,
    wakeServer,
    startChannel,
    probeReady,
    mintToken,
    sleep,
    onStep,
    pollIntervalMs = 1000,
    maxPollMs = 90_000,
  } = args;

  // Step 1: Auth check
  onStep('auth');
  const authed = await isAuthenticated();
  if (!authed) {
    return { kind: 'redirect-login' };
  }

  // Step 2: Channel lookup
  onStep('channel-lookup');
  let channel: { channelId: string; channelName: string; startingCommand: string | null } | null;
  try {
    channel = await channelForPort({ serverId, port });
  } catch (err: any) {
    if (typeof err?.status === 'number' && err.status === 403) {
      return { kind: 'error', reason: 'no-access' };
    }
    throw err;
  }

  // Step 3: Wake server
  onStep('wake');
  const wakeResult = await wakeServer({ serverId });
  if (wakeResult.status === 'destroyed') {
    return { kind: 'error', reason: 'destroyed' };
  }
  // Otherwise continue optimistically — even on 'error', Fly may have already woken the machine.

  // Step 4: Start channel (only if channel exists and has a startingCommand)
  if (channel !== null && channel.startingCommand !== null) {
    onStep('start-channel');
    try {
      const startResult = await startChannel({ serverId, channelId: channel.channelId, force: false });
      // Swallow channelMissing — port might be bound manually
      if (startResult.channelMissing) {
        // do nothing — proceed to poll
      }
    } catch (err: any) {
      if (typeof err?.status === 'number' && err.status === 403) {
        return { kind: 'error', reason: 'no-access' };
      }
      throw err;
    }
  }

  // Step 5: Poll for readiness
  onStep('poll');
  const deadline = Date.now() + maxPollMs;
  let ready = false;

  while (Date.now() < deadline) {
    ready = await probeReady({ serverId, port });
    if (ready) break;
    await sleep(pollIntervalMs);
  }

  // One final check after loop
  if (!ready) {
    ready = await probeReady({ serverId, port });
  }

  if (!ready) {
    return { kind: 'timeout' };
  }

  // Step 6: Mint token
  onStep('mint');
  const token = await mintToken({ serverId });

  // Step 7: Build redirect URL
  onStep('redirect');
  const url = new URL(target);
  url.searchParams.set('token', token);
  url.searchParams.set('__pg_attempts', String((attempts ?? 0) + 1));

  return { kind: 'redirect', url: url.toString() };
}
