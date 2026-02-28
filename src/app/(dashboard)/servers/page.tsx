'use client';

import { useState, useEffect } from 'react';
import { Plus, Monitor, Cloud, Clock, Users, MapPin, RefreshCw } from 'lucide-react';
import { CreateServerModal, CreateServerResult, REGIONS, Region } from '@/components/CreateServerModal';
import { ServerStatusBadge, ServerStatusType } from '@/components/ServerStatus';

interface Server {
  id: string;
  name: string;
  deploymentType: 'local' | 'remote';
  status: ServerStatusType;
  region?: Region;
  lastActiveAt?: string;
  teamMemberCount?: number;
  serverUrl?: string;
  createdAt: string;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) {
    return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
  }
  if (diffHour > 0) {
    return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
  }
  if (diffMin > 0) {
    return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
  }
  return 'Just now';
}

function getRegionDisplay(regionCode: Region): string {
  const region = REGIONS.find((r) => r.code === regionCode);
  return region ? `${region.location}` : regionCode;
}

export default function ServersPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [serversList, setServersList] = useState<Server[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Load servers
  const loadServers = async (showLoader = true) => {
    if (showLoader) setIsLoading(true);
    setIsRefreshing(!showLoader);

    try {
      const response = await fetch('/api/servers');
      if (!response.ok) {
        throw new Error('Failed to fetch servers');
      }
      const data = await response.json();
      // Map API response to Server interface
      const mappedServers: Server[] = (data.servers || data || []).map((w: any) => ({
        id: w.id,
        name: w.name,
        deploymentType: w.deploymentType || 'local',
        status: w.serverStatus || (w.deploymentType === 'remote' ? 'provisioning' : 'offline'),
        region: w.flyRegion,
        lastActiveAt: w.serverLastSeen,
        serverUrl: w.serverUrl,
        createdAt: w.createdAt,
      }));
      setServersList(mappedServers);
    } catch (error) {
      console.error('Failed to load servers:', error);
      // Fall back to empty list on error
      setServersList([]);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  const handleServerCreated = (server: CreateServerResult) => {
    // Add the new server to the list
    const newServer: Server = {
      id: server.id,
      name: server.name,
      deploymentType: server.deploymentType,
      status: server.deploymentType === 'remote' ? 'online' : 'offline',
      region: server.region,
      serverUrl: server.serverUrl,
      createdAt: new Date().toISOString(),
    };
    setServersList((prev) => [newServer, ...prev]);
  };

  const handleRefresh = () => {
    loadServers(false);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-white">Servers</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Server
          </button>
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-slate-800 rounded-lg p-5 animate-pulse">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-slate-700 rounded-lg" />
                  <div>
                    <div className="h-5 w-32 bg-slate-700 rounded mb-2" />
                    <div className="h-4 w-48 bg-slate-700 rounded" />
                  </div>
                </div>
                <div className="h-5 w-20 bg-slate-700 rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && serversList.length === 0 && (
        <div className="bg-slate-800 rounded-lg p-12 text-center">
          <div className="w-16 h-16 mx-auto bg-slate-700 rounded-full flex items-center justify-center mb-4">
            <Cloud className="h-8 w-8 text-slate-400" />
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">No servers yet</h2>
          <p className="text-slate-400 mb-6 max-w-md mx-auto">
            Create a server to get started. You can run locally on your machine or deploy to the cloud.
          </p>
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create Server
          </button>
        </div>
      )}

      {/* Server list */}
      {!isLoading && serversList.length > 0 && (
        <div className="space-y-3">
          {serversList.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}

      {/* Create server modal */}
      <CreateServerModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={handleServerCreated}
      />
    </div>
  );
}

function ServerCard({ server }: { server: Server }) {
  const isRemote = server.deploymentType === 'remote';
  const regionDisplay = server.region ? getRegionDisplay(server.region) : null;

  return (
    <div
      className="bg-slate-800 rounded-lg p-5 border border-slate-700 hover:border-slate-600 transition-colors cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={() => {
        // Navigate to server detail page
        // router.push(`/servers/${server.id}`);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          // Navigate to server detail page
        }
      }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          {/* Icon */}
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              isRemote ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-700 text-slate-400'
            }`}
          >
            {isRemote ? <Cloud className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
          </div>

          {/* Info */}
          <div>
            <h3 className="text-white font-medium">{server.name}</h3>
            <div className="flex items-center gap-3 text-sm text-slate-400 mt-1">
              {/* Deployment type */}
              <span className={isRemote ? 'text-blue-400' : 'text-slate-500'}>
                {isRemote ? 'Remote' : 'Local'}
              </span>

              {/* Region (remote only) */}
              {isRemote && regionDisplay && (
                <>
                  <span className="text-slate-600">-</span>
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {regionDisplay}
                  </span>
                </>
              )}

              {/* Team members (remote only) */}
              {isRemote && server.teamMemberCount && server.teamMemberCount > 0 && (
                <>
                  <span className="text-slate-600">-</span>
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {server.teamMemberCount} member{server.teamMemberCount > 1 ? 's' : ''}
                  </span>
                </>
              )}

              {/* Last active (local/suspended) */}
              {server.lastActiveAt && (server.status === 'offline' || server.status === 'suspended') && (
                <>
                  <span className="text-slate-600">-</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {server.status === 'suspended' ? 'Suspended' : 'Last active'}{' '}
                    {formatRelativeTime(server.lastActiveAt)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Status */}
        <ServerStatusBadge status={server.status} size="md" />
      </div>
    </div>
  );
}
