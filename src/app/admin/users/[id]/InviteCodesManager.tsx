'use client';

import { useState } from 'react';
import { generateInviteCode } from './actions';

interface InviteCode {
  id: string;
  code: string;
  usedByUserId: string | null;
  usedAt: Date | null;
  createdAt: Date;
}

interface InviteCodesManagerProps {
  userId: string;
  inviteCodes: InviteCode[];
}

export function InviteCodesManager({ userId, inviteCodes }: InviteCodesManagerProps) {
  const [loading, setLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      await generateInviteCode(userId);
    } catch (error) {
      console.error('Failed to generate invite code:', error);
    }
    setLoading(false);
  };

  const handleCopy = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const unusedCodes = inviteCodes.filter(c => !c.usedByUserId);
  const usedCodes = inviteCodes.filter(c => c.usedByUserId);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">
          Invite Codes ({inviteCodes.length})
        </h2>
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 disabled:opacity-50 text-white text-sm rounded transition-colors flex items-center gap-2"
        >
          {loading ? (
            <>
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Generate Invite Code
            </>
          )}
        </button>
      </div>

      {inviteCodes.length === 0 ? (
        <p className="text-slate-500 text-sm">No invite codes generated yet.</p>
      ) : (
        <div className="space-y-2">
          {/* Unused codes first */}
          {unusedCodes.map((code) => (
            <div
              key={code.id}
              className="flex items-center justify-between bg-slate-700/50 rounded px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-green-500" title="Available" />
                <code className="font-mono text-green-400">{code.code}</code>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">
                  Created {new Date(code.createdAt).toLocaleDateString()}
                </span>
                <button
                  onClick={() => handleCopy(code.code)}
                  className="px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded text-xs transition-colors"
                >
                  {copiedCode === code.code ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          ))}

          {/* Used codes */}
          {usedCodes.map((code) => (
            <div
              key={code.id}
              className="flex items-center justify-between bg-slate-700/30 rounded px-3 py-2 opacity-60"
            >
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-slate-500" title="Used" />
                <code className="font-mono text-slate-400 line-through">{code.code}</code>
              </div>
              <span className="text-xs text-slate-500">
                Used {code.usedAt ? new Date(code.usedAt).toLocaleDateString() : 'unknown'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
