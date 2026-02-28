'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Power } from 'lucide-react';

export type ServerStatusType = 'online' | 'offline' | 'suspended' | 'provisioning' | 'waking';

export interface ServerStatusProps {
  serverId: string;
  initialStatus: ServerStatusType;
  /** Whether to show the wake button for suspended servers */
  showWakeButton?: boolean;
  /** Called when the server status changes */
  onStatusChange?: (status: ServerStatusType) => void;
  /** Called when wake completes successfully */
  onWakeComplete?: () => void;
  /** Polling interval in ms for status checks (0 to disable) */
  pollInterval?: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
}

const STATUS_CONFIG: Record<
  ServerStatusType,
  {
    label: string;
    dotClass: string;
    textClass: string;
  }
> = {
  online: {
    label: 'Online',
    dotClass: 'bg-green-500',
    textClass: 'text-green-400',
  },
  offline: {
    label: 'Offline',
    dotClass: 'bg-red-500',
    textClass: 'text-red-400',
  },
  suspended: {
    label: 'Suspended',
    dotClass: 'bg-amber-500',
    textClass: 'text-amber-400',
  },
  provisioning: {
    label: 'Provisioning',
    dotClass: 'bg-blue-500',
    textClass: 'text-blue-400',
  },
  waking: {
    label: 'Waking',
    dotClass: 'bg-blue-500',
    textClass: 'text-blue-400',
  },
};

const SIZE_CONFIG = {
  sm: {
    dot: 'w-2 h-2',
    text: 'text-xs',
    button: 'px-2 py-1 text-xs',
    gap: 'gap-1.5',
  },
  md: {
    dot: 'w-2.5 h-2.5',
    text: 'text-sm',
    button: 'px-3 py-1.5 text-sm',
    gap: 'gap-2',
  },
  lg: {
    dot: 'w-3 h-3',
    text: 'text-base',
    button: 'px-4 py-2 text-sm',
    gap: 'gap-2.5',
  },
};

export function ServerStatus({
  serverId,
  initialStatus,
  showWakeButton = true,
  onStatusChange,
  onWakeComplete,
  pollInterval = 0,
  size = 'md',
}: ServerStatusProps) {
  const [status, setStatus] = useState<ServerStatusType>(initialStatus);
  const [isWaking, setIsWaking] = useState(false);
  const [wakeProgress, setWakeProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const config = STATUS_CONFIG[status];
  const sizeConfig = SIZE_CONFIG[size];

  // Sync with initial status prop changes
  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  // Notify parent of status changes
  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  // Poll for status updates
  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/servers/${serverId}/machine/status`);
      if (response.ok) {
        const data = await response.json();
        if (data.status && data.status !== status) {
          setStatus(data.status);
        }
      }
    } catch {
      // Silently fail polling - network errors are expected
    }
  }, [serverId, status]);

  useEffect(() => {
    if (pollInterval <= 0) return;

    const interval = setInterval(fetchStatus, pollInterval);
    return () => clearInterval(interval);
  }, [pollInterval, fetchStatus]);

  // Handle wake action
  const handleWake = async () => {
    if (isWaking || status !== 'suspended') return;

    setIsWaking(true);
    setError(null);
    setWakeProgress(0);
    setStatus('waking');

    // Simulate progress animation
    const progressInterval = setInterval(() => {
      setWakeProgress((prev) => {
        if (prev >= 90) {
          clearInterval(progressInterval);
          return 90;
        }
        return prev + 10 + Math.random() * 15;
      });
    }, 300);

    try {
      const response = await fetch(`/api/servers/${serverId}/machine/wake`, {
        method: 'POST',
      });

      clearInterval(progressInterval);

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to wake server');
      }

      setWakeProgress(100);
      setStatus('online');
      onWakeComplete?.();
    } catch (err) {
      clearInterval(progressInterval);
      setError(err instanceof Error ? err.message : 'Failed to wake server');
      setStatus('suspended');
    } finally {
      setIsWaking(false);
      setWakeProgress(0);
    }
  };

  const isAnimating = status === 'provisioning' || status === 'waking' || status === 'online';

  return (
    <div className={`flex items-center ${sizeConfig.gap}`}>
      {/* Status dot */}
      <span className="relative flex items-center justify-center">
        <span
          className={`${sizeConfig.dot} rounded-full ${config.dotClass}`}
          aria-hidden="true"
        />
        {isAnimating && (
          <span
            className={`absolute ${sizeConfig.dot} rounded-full ${config.dotClass} animate-ping opacity-75`}
            aria-hidden="true"
          />
        )}
      </span>

      {/* Status label */}
      <span className={`${sizeConfig.text} font-medium ${config.textClass}`}>
        {isWaking ? `Waking... ${Math.round(wakeProgress)}%` : config.label}
      </span>

      {/* Wake button */}
      {showWakeButton && status === 'suspended' && !isWaking && (
        <button
          type="button"
          onClick={handleWake}
          className={`${sizeConfig.button} font-medium bg-slate-700 text-slate-300 rounded hover:bg-slate-600 hover:text-white transition-colors flex items-center gap-1.5`}
          aria-label="Wake server"
        >
          <Power className="h-3.5 w-3.5" />
          Wake
        </button>
      )}

      {/* Waking spinner */}
      {isWaking && (
        <Loader2 className={`h-4 w-4 text-blue-400 animate-spin`} aria-hidden="true" />
      )}

      {/* Error indicator */}
      {error && (
        <span className="text-xs text-red-400" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Simple status badge variant - just the dot and label, no interactivity
 */
export function ServerStatusBadge({
  status,
  size = 'sm',
}: {
  status: ServerStatusType;
  size?: 'sm' | 'md' | 'lg';
}) {
  const config = STATUS_CONFIG[status];
  const sizeConfig = SIZE_CONFIG[size];
  const isAnimating = status === 'provisioning' || status === 'waking' || status === 'online';

  return (
    <span className={`inline-flex items-center ${sizeConfig.gap}`}>
      <span className="relative flex items-center justify-center">
        <span
          className={`${sizeConfig.dot} rounded-full ${config.dotClass}`}
          aria-hidden="true"
        />
        {isAnimating && (
          <span
            className={`absolute ${sizeConfig.dot} rounded-full ${config.dotClass} animate-ping opacity-75`}
            aria-hidden="true"
          />
        )}
      </span>
      <span className={`${sizeConfig.text} font-medium ${config.textClass}`}>
        {config.label}
      </span>
    </span>
  );
}
