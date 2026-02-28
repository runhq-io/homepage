'use client';

import dynamic from 'next/dynamic';

// Dynamically import the visual editor to avoid SSR issues with ReactFlow
const VisualMachineEditor = dynamic(
  () => import('./VisualMachineEditor').then((mod) => mod.VisualMachineEditor),
  {
    ssr: false,
    loading: () => (
      <div className="h-full bg-slate-900 rounded-lg border border-slate-700 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </div>
    ),
  }
);

interface MachineEditorProps {
  agentId: string;
  machineDefinition: Record<string, unknown> | null;
}

export function MachineEditor({ agentId, machineDefinition }: MachineEditorProps) {
  return (
    <div className="h-full">
      <VisualMachineEditor
        agentId={agentId}
        machineDefinition={machineDefinition}
      />
    </div>
  );
}
