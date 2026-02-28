'use client';

import { useState, useTransition } from 'react';
import { updateUserPlan, addBonusCredits, resetMonthlyUsage } from './actions';

// Format cents as dollars
function formatDollars(cents: number): string {
  if (cents === 0) return '$0.00';
  if (cents < 100) return `$${(cents / 100).toFixed(2)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

interface Plan {
  id: string;
  name: string;
  monthlyCreditsCents: number;
}

interface Subscription {
  id: string;
  planId: string;
  status: string;
  creditBalanceCents: number;
}

interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  totalCostCents: number;
  requestCount: number;
}

interface SubscriptionManagerProps {
  userId: string;
  subscription: Subscription | null;
  plan: Plan | null;
  allPlans: Plan[];
  currentUsage: UsageRecord | null;
}

export function SubscriptionManager({
  userId,
  subscription,
  plan,
  allPlans,
  currentUsage,
}: SubscriptionManagerProps) {
  const [isPending, startTransition] = useTransition();
  const [selectedPlan, setSelectedPlan] = useState(subscription?.planId || 'free');
  const [bonusCents, setBonusCents] = useState('500'); // $5.00 default
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Credit-based billing
  const balanceCents = subscription?.creditBalanceCents || 0;
  const monthlyCreditsCents = plan?.monthlyCreditsCents || 0;
  const costSpentCents = currentUsage?.totalCostCents || 0;
  const usagePercent = monthlyCreditsCents > 0 ? Math.min(100, (costSpentCents / monthlyCreditsCents) * 100) : 0;

  const handleChangePlan = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await updateUserPlan(userId, selectedPlan);
      setMessage(result.success
        ? { type: 'success', text: `Plan → ${selectedPlan}` }
        : { type: 'error', text: result.error || 'Failed' });
    });
  };

  const handleAddBonus = () => {
    setMessage(null);
    const cents = parseInt(bonusCents, 10);
    if (isNaN(cents) || cents <= 0) {
      setMessage({ type: 'error', text: 'Invalid amount' });
      return;
    }
    startTransition(async () => {
      const result = await addBonusCredits(userId, cents);
      setMessage(result.success
        ? { type: 'success', text: `+${formatDollars(cents)} credits` }
        : { type: 'error', text: result.error || 'Failed' });
    });
  };

  const handleResetUsage = () => {
    setMessage(null);
    if (!confirm('Reset monthly usage to 0?')) return;
    startTransition(async () => {
      const result = await resetMonthlyUsage(userId);
      setMessage(result.success
        ? { type: 'success', text: 'Usage reset' }
        : { type: 'error', text: result.error || 'Failed' });
    });
  };

  return (
    <div className="space-y-6">
      {/* Section Title */}
      <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">Subscription & Billing</h2>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Current Plan */}
        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">Current Plan</div>
          <div className="text-white font-semibold capitalize">{plan?.name || 'None'}</div>
          <div className="text-xs text-slate-500">{formatDollars(monthlyCreditsCents)} monthly credits</div>
        </div>

        {/* Credit Balance */}
        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">Credit Balance</div>
          <div className="text-green-400 font-semibold text-lg">{formatDollars(balanceCents)}</div>
          <div className="text-xs text-slate-500">Available to spend</div>
        </div>

        {/* Spent This Month */}
        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">Spent This Month</div>
          <div className="text-white font-semibold text-lg">{formatDollars(costSpentCents)}</div>
          <div className="text-xs text-slate-500">
            {monthlyCreditsCents > 0
              ? `${usagePercent.toFixed(0)}% of ${formatDollars(monthlyCreditsCents)} limit`
              : 'No monthly limit set'
            }
          </div>
        </div>

        {/* Usage Bar */}
        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">Usage</div>
          <div className="h-2 bg-slate-600 rounded-full overflow-hidden mt-2">
            <div
              className={`h-full transition-all ${
                usagePercent >= 90 ? 'bg-red-500' :
                usagePercent >= 70 ? 'bg-yellow-500' :
                'bg-green-500'
              }`}
              style={{ width: `${Math.min(100, usagePercent)}%` }}
            />
          </div>
          <div className={`text-xs mt-1 ${
            usagePercent >= 90 ? 'text-red-400' :
            usagePercent >= 70 ? 'text-yellow-400' :
            'text-green-400'
          }`}>
            {usagePercent.toFixed(0)}% used
          </div>
        </div>
      </div>

      {/* Message */}
      {message && (
        <div className={`text-sm px-3 py-2 rounded ${message.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
          {message.text}
        </div>
      )}

      {/* Admin Actions */}
      <div className="border-t border-slate-700 pt-4">
        <div className="text-xs text-slate-400 uppercase tracking-wide mb-3">Admin Actions</div>
        <div className="flex flex-wrap gap-4 items-end">
          {/* Change Plan */}
          <div>
            <label className="block text-xs text-slate-500 mb-1">Change Plan</label>
            <div className="flex items-center gap-2">
              <select
                value={selectedPlan}
                onChange={(e) => setSelectedPlan(e.target.value)}
                className="bg-slate-700 text-white text-sm rounded px-2 py-1.5"
                disabled={isPending}
              >
                {allPlans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button
                onClick={handleChangePlan}
                disabled={isPending || selectedPlan === subscription?.planId}
                className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm rounded px-3 py-1.5"
              >
                Set
              </button>
            </div>
          </div>

          {/* Add Credits */}
          <div>
            <label className="block text-xs text-slate-500 mb-1">Add Credits (in cents)</label>
            <div className="flex items-center gap-2">
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm">¢</span>
                <input
                  type="number"
                  value={bonusCents}
                  onChange={(e) => setBonusCents(e.target.value)}
                  className="w-20 bg-slate-700 text-white text-sm rounded pl-6 pr-2 py-1.5"
                  disabled={isPending}
                  placeholder="500"
                />
              </div>
              <button
                onClick={handleAddBonus}
                disabled={isPending}
                className="bg-green-600 hover:bg-green-500 disabled:bg-slate-600 text-white text-sm rounded px-3 py-1.5"
              >
                Add
              </button>
              <span className="text-xs text-slate-500">= {formatDollars(parseInt(bonusCents) || 0)}</span>
            </div>
          </div>

          {/* Reset Usage */}
          <div>
            <label className="block text-xs text-slate-500 mb-1">Reset Monthly Cost</label>
            <button
              onClick={handleResetUsage}
              disabled={isPending}
              className="bg-slate-600 hover:bg-slate-500 disabled:bg-slate-700 text-white text-sm rounded px-3 py-1.5"
            >
              Reset to $0
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
