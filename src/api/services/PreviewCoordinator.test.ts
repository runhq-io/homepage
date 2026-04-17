import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ServerService from './ServerService';
import { channelForPort, startChannel } from './PreviewCoordinator';

vi.mock('./ServerService', async () => {
  const actual = await vi.importActual<typeof import('./ServerService')>('./ServerService');
  return { ...actual, fetchFromServer: vi.fn() };
});

const mockServer = { id: 's1', serverUrl: 'https://srv' } as any;

describe('PreviewCoordinator.channelForPort', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the channel whose previewPort matches', async () => {
    (ServerService.fetchFromServer as any).mockResolvedValue({
      success: true,
      data: [
        { id: 'ch_a', name: 'frontend', previewPort: 3000, agentConfig: { startingCommand: 'npm run dev' } },
        { id: 'ch_b', name: 'api',      previewPort: 8000, agentConfig: { startingCommand: 'uvicorn main:app' } },
      ],
    });
    const result = await channelForPort({ server: mockServer, userId: 'u1', port: 3000 });
    expect(result).toEqual({ channelId: 'ch_a', channelName: 'frontend', startingCommand: 'npm run dev' });
  });

  it('returns null when no channel has that port', async () => {
    (ServerService.fetchFromServer as any).mockResolvedValue({ success: true, data: [] });
    const result = await channelForPort({ server: mockServer, userId: 'u1', port: 3000 });
    expect(result).toBeNull();
  });

  it('null startingCommand when channel has none', async () => {
    (ServerService.fetchFromServer as any).mockResolvedValue({
      success: true,
      data: [{ id: 'ch_c', name: 'docs', previewPort: 4000, agentConfig: null }],
    });
    const result = await channelForPort({ server: mockServer, userId: 'u1', port: 4000 });
    expect(result).toEqual({ channelId: 'ch_c', channelName: 'docs', startingCommand: null });
  });

  it('null startingCommand when command is empty string', async () => {
    (ServerService.fetchFromServer as any).mockResolvedValue({
      success: true,
      data: [{ id: 'ch_d', name: 'x', previewPort: 5000, agentConfig: { startingCommand: '' } }],
    });
    const result = await channelForPort({ server: mockServer, userId: 'u1', port: 5000 });
    expect(result?.startingCommand).toBeNull();
  });

  it('passes userId through to fetchFromServer', async () => {
    (ServerService.fetchFromServer as any).mockResolvedValue({ success: true, data: [] });
    await channelForPort({ server: mockServer, userId: 'u_xyz', port: 3000 });
    expect(ServerService.fetchFromServer).toHaveBeenCalledWith(mockServer, 'u_xyz', expect.stringMatching(/\/api\/channels/), expect.anything());
  });

  it('propagates fetch errors', async () => {
    (ServerService.fetchFromServer as any).mockRejectedValue(new Error('server down'));
    await expect(channelForPort({ server: mockServer, userId: 'u1', port: 3000 })).rejects.toThrow('server down');
  });
});

describe('PreviewCoordinator.startChannel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('relays success response from the machine', async () => {
    (ServerService.fetchFromServer as any).mockResolvedValue({
      started: true, alreadyStarted: false, terminalSessionId: 'sess_1', bootId: 'b1',
    });
    const result = await startChannel({ server: mockServer, userId: 'u1', channelId: 'ch_a' });
    expect(result).toEqual({ started: true, alreadyStarted: false, terminalSessionId: 'sess_1', bootId: 'b1' });
    expect(ServerService.fetchFromServer).toHaveBeenCalledWith(
      mockServer, 'u1', '/__preview/start-channel',
      { method: 'POST', body: { channelId: 'ch_a', force: false } },
    );
  });

  it('propagates force=true', async () => {
    (ServerService.fetchFromServer as any).mockResolvedValue({ started: true, alreadyStarted: false, terminalSessionId: 's', bootId: 'b' });
    await startChannel({ server: mockServer, userId: 'u1', channelId: 'ch_a', force: true });
    expect(ServerService.fetchFromServer).toHaveBeenCalledWith(
      mockServer, 'u1', '/__preview/start-channel',
      { method: 'POST', body: { channelId: 'ch_a', force: true } },
    );
  });

  it('returns channelMissing on HTTP 404', async () => {
    (ServerService.fetchFromServer as any).mockRejectedValue(new Error('Server responded with HTTP 404'));
    const result = await startChannel({ server: mockServer, userId: 'u1', channelId: 'ch_a' });
    expect(result).toEqual({
      started: false, alreadyStarted: false,
      terminalSessionId: null, bootId: null,
      channelMissing: true,
    });
  });

  it('propagates other HTTP errors', async () => {
    (ServerService.fetchFromServer as any).mockRejectedValue(new Error('Server responded with HTTP 500'));
    await expect(startChannel({ server: mockServer, userId: 'u1', channelId: 'ch_a' })).rejects.toThrow('HTTP 500');
  });
});
