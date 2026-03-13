'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Monitor, Cloud, ChevronLeft, Check, AlertCircle, Loader2 } from 'lucide-react';

// Types
export type DeploymentType = 'local' | 'remote';
export type Region = 'iad' | 'lax' | 'ord' | 'sea' | 'ams' | 'fra' | 'sin' | 'syd';

export interface RegionInfo {
  code: Region;
  name: string;
  flag: string;
  location: string;
}

export const REGIONS: RegionInfo[] = [
  { code: 'iad', name: 'US East', flag: 'US', location: 'Virginia' },
  { code: 'lax', name: 'US West', flag: 'US', location: 'Los Angeles' },
  { code: 'ord', name: 'US Central', flag: 'US', location: 'Chicago' },
  { code: 'sea', name: 'US Northwest', flag: 'US', location: 'Seattle' },
  { code: 'ams', name: 'Europe West', flag: 'NL', location: 'Amsterdam' },
  { code: 'fra', name: 'Europe Central', flag: 'DE', location: 'Frankfurt' },
  { code: 'sin', name: 'Asia Pacific', flag: 'SG', location: 'Singapore' },
  { code: 'syd', name: 'Oceania', flag: 'AU', location: 'Sydney' },
];

type ModalStep = 'select-type' | 'configure' | 'provisioning' | 'success' | 'error';

interface ProvisioningStep {
  label: string;
  status: 'pending' | 'active' | 'completed';
}

export interface CreateServerResult {
  id: string;
  name: string;
  deploymentType: DeploymentType;
  region?: Region;
  serverUrl?: string;
}

export interface CreateServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (server: CreateServerResult) => void;
}

export function CreateServerModal({ isOpen, onClose, onSuccess }: CreateServerModalProps) {
  const [step, setStep] = useState<ModalStep>('select-type');
  const [deploymentType, setDeploymentType] = useState<DeploymentType | null>(null);
  const [name, setName] = useState('');
  const [region, setRegion] = useState<Region>('iad');
  const [provisioningSteps, setProvisioningSteps] = useState<ProvisioningStep[]>([]);
  const [provisioningProgress, setProvisioningProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [createdServer, setCreatedServer] = useState<CreateServerResult | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep('select-type');
      setDeploymentType(null);
      setName('');
      setRegion('iad');
      setProvisioningSteps([]);
      setProvisioningProgress(0);
      setError(null);
      setCreatedServer(null);
    }
  }, [isOpen]);

  // Focus management
  useEffect(() => {
    if (step === 'configure' && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [step]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && step !== 'provisioning') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, step, onClose]);

  // Simulate provisioning progress
  const simulateProvisioning = useCallback(async () => {
    const steps: ProvisioningStep[] = [
      { label: 'Allocating resources', status: 'pending' },
      { label: 'Starting container', status: 'pending' },
      { label: 'Connecting to network', status: 'pending' },
      { label: 'Registering with cloud', status: 'pending' },
    ];

    setProvisioningSteps(steps);
    setProvisioningProgress(0);

    // Simulate each step
    for (let i = 0; i < steps.length; i++) {
      // Mark current step as active
      setProvisioningSteps((prev) =>
        prev.map((s, idx) => ({
          ...s,
          status: idx === i ? 'active' : idx < i ? 'completed' : 'pending',
        }))
      );
      setProvisioningProgress(((i + 0.5) / steps.length) * 100);

      // Wait for step duration
      await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1000));

      // Mark step as completed
      setProvisioningSteps((prev) =>
        prev.map((s, idx) => ({
          ...s,
          status: idx <= i ? 'completed' : 'pending',
        }))
      );
      setProvisioningProgress(((i + 1) / steps.length) * 100);
    }
  }, []);

  const handleContinue = () => {
    if (step === 'select-type' && deploymentType) {
      if (deploymentType === 'local') {
        // For local, skip configuration and just create
        handleCreateServer('local');
      } else {
        setStep('configure');
      }
    }
  };

  const handleBack = () => {
    if (step === 'configure') {
      setStep('select-type');
    } else if (step === 'error') {
      setStep('configure');
    }
  };

  const handleCreateServer = async (type: DeploymentType = deploymentType!) => {
    const serverName = type === 'local' ? 'Local Server' : name.trim();

    if (type === 'remote' && !serverName) {
      return;
    }

    setStep('provisioning');

    try {
      // Start provisioning simulation
      const provisioningPromise = type === 'remote' ? simulateProvisioning() : Promise.resolve();

      // Make API call
      const response = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: serverName,
          deploymentType: type,
          region: type === 'remote' ? region : undefined,
        }),
      });

      // Wait for provisioning animation to complete
      await provisioningPromise;

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create server');
      }

      const server = await response.json();

      setCreatedServer({
        id: server.id,
        name: serverName,
        deploymentType: type,
        region: type === 'remote' ? region : undefined,
        serverUrl: server.serverUrl,
      });

      setStep('success');

      // Auto-close after success
      setTimeout(() => {
        onSuccess?.(server);
        onClose();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
      setStep('error');
    }
  };

  const handleTryAgain = () => {
    setError(null);
    handleCreateServer();
  };

  const handleChangeRegion = () => {
    setError(null);
    setStep('configure');
  };

  if (!isOpen) return null;

  const selectedRegion = REGIONS.find((r) => r.code === region);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={step !== 'provisioning' ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        className="relative w-full max-w-lg bg-slate-800 rounded-xl shadow-2xl border border-slate-700 animate-modal-in"
      >
        {/* Close button */}
        {step !== 'provisioning' && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700 transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        )}

        {/* Step: Type Selection */}
        {step === 'select-type' && (
          <div className="p-4 sm:p-6">
            <h2 id="modal-title" className="text-xl font-semibold text-white mb-6">
              Create Server
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              {/* Local option */}
              <button
                type="button"
                onClick={() => setDeploymentType('local')}
                className={`relative p-5 rounded-xl border-2 text-left transition-all ${
                  deploymentType === 'local'
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-600 hover:border-slate-500 hover:bg-slate-700/50'
                }`}
              >
                <div className="flex justify-center mb-4">
                  <Monitor className="h-10 w-10 text-slate-400" />
                </div>
                <h3 className="text-lg font-medium text-white text-center mb-2">Local</h3>
                <p className="text-sm text-slate-400 text-center mb-3">
                  Run on your machine
                </p>
                <p className="text-xs text-slate-500 text-center">
                  Free - Full control
                </p>
                <div className="mt-4 pt-3 border-t border-slate-600">
                  <p className="text-xs text-slate-400 font-medium mb-1">Best for:</p>
                  <ul className="text-xs text-slate-500 space-y-0.5">
                    <li>- Solo development</li>
                    <li>- Sensitive data</li>
                    <li>- Offline work</li>
                  </ul>
                </div>
                {deploymentType === 'local' && (
                  <div className="absolute top-3 right-3 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                    <Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>

              {/* Remote option */}
              <button
                type="button"
                onClick={() => setDeploymentType('remote')}
                className={`relative p-5 rounded-xl border-2 text-left transition-all ${
                  deploymentType === 'remote'
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-600 hover:border-slate-500 hover:bg-slate-700/50'
                }`}
              >
                <div className="flex justify-center mb-4">
                  <Cloud className="h-10 w-10 text-blue-400" />
                </div>
                <h3 className="text-lg font-medium text-white text-center mb-2">Remote</h3>
                <p className="text-sm text-slate-400 text-center mb-3">
                  Cloud-hosted server
                </p>
                <p className="text-xs text-slate-500 text-center">
                  ~$5/mo - Always available
                </p>
                <div className="mt-4 pt-3 border-t border-slate-600">
                  <p className="text-xs text-slate-400 font-medium mb-1">Best for:</p>
                  <ul className="text-xs text-slate-500 space-y-0.5">
                    <li>- Team collaboration</li>
                    <li>- 24/7 availability</li>
                    <li>- No local setup</li>
                  </ul>
                </div>
                {deploymentType === 'remote' && (
                  <div className="absolute top-3 right-3 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                    <Check className="h-3 w-3 text-white" />
                  </div>
                )}
              </button>
            </div>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleContinue}
                disabled={!deploymentType}
                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                Continue
                <ChevronLeft className="h-4 w-4 rotate-180" />
              </button>
            </div>
          </div>
        )}

        {/* Step: Configuration */}
        {step === 'configure' && (
          <div className="p-4 sm:p-6">
            <h2 id="modal-title" className="text-xl font-semibold text-white mb-1">
              Create Remote Server
            </h2>
            <div className="h-0.5 w-12 bg-blue-500 mb-6" />

            <div className="space-y-5">
              <div>
                <label htmlFor="server-name" className="block text-sm font-medium text-slate-300 mb-2">
                  Name
                </label>
                <input
                  ref={nameInputRef}
                  id="server-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Team Backend"
                  className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label htmlFor="server-region" className="block text-sm font-medium text-slate-300 mb-2">
                  Region
                </label>
                <select
                  id="server-region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value as Region)}
                  className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {REGIONS.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.flag} {r.name} ({r.location})
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-slate-400">
                  Choose the region closest to your team for best performance
                </p>
              </div>

              {/* Info box */}
              <div className="bg-slate-700/50 rounded-lg p-4 border border-slate-600">
                <div className="flex gap-3">
                  <div className="flex-shrink-0 mt-0.5">
                    <div className="w-5 h-5 rounded-full bg-blue-500/20 flex items-center justify-center">
                      <span className="text-blue-400 text-xs">i</span>
                    </div>
                  </div>
                  <div className="text-sm text-slate-300">
                    <p className="font-medium mb-1">Tip</p>
                    <p className="text-slate-400 text-xs leading-relaxed">
                      Remote servers automatically suspend when idle to save costs.
                      They wake up instantly when you reconnect.
                    </p>
                  </div>
                </div>
              </div>

              <div className="text-sm text-slate-400">
                Estimated cost: <span className="text-white font-medium">~$5-6/month</span>{' '}
                <span className="text-slate-500">(less if suspended often)</span>
              </div>
            </div>

            <div className="flex justify-between mt-6 pt-4 border-t border-slate-700">
              <button
                type="button"
                onClick={handleBack}
                className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white transition-colors flex items-center gap-2"
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </button>
              <button
                type="button"
                onClick={() => handleCreateServer()}
                disabled={!name.trim()}
                className="px-5 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Create Server
              </button>
            </div>
          </div>
        )}

        {/* Step: Provisioning */}
        {step === 'provisioning' && (
          <div className="p-8 text-center">
            <div className="mb-6">
              <div className="w-16 h-16 mx-auto bg-slate-700 rounded-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 text-blue-400 animate-spin" />
              </div>
            </div>

            <h2 className="text-xl font-semibold text-white mb-2">
              Creating your server...
            </h2>

            {/* Progress bar */}
            <div className="w-full max-w-xs mx-auto mt-6 mb-6">
              <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${provisioningProgress}%` }}
                />
              </div>
              <p className="text-sm text-slate-400 mt-2">
                {Math.round(provisioningProgress)}%
              </p>
            </div>

            {/* Steps */}
            <div className="text-left max-w-xs mx-auto space-y-2">
              {provisioningSteps.map((s, idx) => (
                <div key={idx} className="flex items-center gap-3">
                  {s.status === 'completed' && (
                    <Check className="h-4 w-4 text-green-400" />
                  )}
                  {s.status === 'active' && (
                    <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                  )}
                  {s.status === 'pending' && (
                    <div className="h-4 w-4 rounded-full border border-slate-500" />
                  )}
                  <span
                    className={
                      s.status === 'completed'
                        ? 'text-slate-300'
                        : s.status === 'active'
                          ? 'text-white'
                          : 'text-slate-500'
                    }
                  >
                    {s.label}
                  </span>
                </div>
              ))}
            </div>

            <p className="text-xs text-slate-500 mt-6">
              Usually takes 5-10 seconds
            </p>
          </div>
        )}

        {/* Step: Success */}
        {step === 'success' && createdServer && (
          <div className="p-8 text-center">
            <div className="mb-6">
              <div className="w-16 h-16 mx-auto bg-green-500/20 rounded-full flex items-center justify-center animate-zoom-in">
                <Check className="h-8 w-8 text-green-400" />
              </div>
            </div>

            <h2 className="text-xl font-semibold text-white mb-2">
              Server Ready!
            </h2>

            <p className="text-slate-400 mb-4">
              <Cloud className="inline h-4 w-4 mr-1 text-blue-400" />
              {createdServer.name} is now online
            </p>

            {createdServer.serverUrl && (
              <div className="inline-block bg-slate-700 rounded-lg px-4 py-2 font-mono text-sm text-slate-300">
                {createdServer.serverUrl}
              </div>
            )}

            <p className="text-xs text-slate-500 mt-6">
              Redirecting to server...
            </p>
          </div>
        )}

        {/* Step: Error */}
        {step === 'error' && (
          <div className="p-8 text-center">
            <div className="mb-6">
              <div className="w-16 h-16 mx-auto bg-red-500/20 rounded-full flex items-center justify-center">
                <AlertCircle className="h-8 w-8 text-red-400" />
              </div>
            </div>

            <h2 className="text-xl font-semibold text-white mb-4">
              Failed to create server
            </h2>

            <div className="bg-slate-700/50 rounded-lg p-4 mb-6 text-sm text-slate-300">
              {error || 'Could not allocate resources in the selected region. This is usually temporary. Please try again.'}
            </div>

            <div className="flex justify-center gap-3">
              <button
                type="button"
                onClick={handleTryAgain}
                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={handleChangeRegion}
                className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-700 transition-colors"
              >
                Choose Different Region
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
