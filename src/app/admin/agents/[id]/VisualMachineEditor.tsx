'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Node,
  Edge,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  Connection,
  MarkerType,
  Handle,
  Position,
  NodeProps,
  EdgeProps,
  getBezierPath,
  EdgeLabelRenderer,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Default machine definition (with prompts for each state)
const DEFAULT_MACHINE = {
  id: 'default-agent-machine',
  version: '1.0.0',
  description: 'Default agent workflow state machine',
  initial: 'idle',
  context: {
    actionCount: 0,
    maxActions: 50,
    thoughts: [],
    lastError: null,
    retryCount: 0,
    maxRetries: 3,
  },
  states: {
    idle: {
      on: { START: 'initializing' },
      prompt: 'Agent is idle. Waiting for a task to be assigned.',
    },
    initializing: {
      entry: ['initializeTask'],
      on: { SCREENSHOT_RECEIVED: 'browsing' },
      prompt: 'Task is starting. The browser is loading the initial page.',
    },
    browsing: {
      entry: ['updateLastActivity'],
      on: {
        SCREENSHOT_RECEIVED: 'thinking',
        PAUSE: 'paused',
        STOP: 'completed',
        ERROR: 'error',
      },
      prompt: 'Observe the current page state. Note any changes from the previous action.',
    },
    thinking: {
      entry: ['recordThought'],
      invoke: { src: 'decideNextAction', onDone: 'executing', onError: 'error' },
      on: {
        ACTION_DECIDED: 'executing',
        TASK_COMPLETE: 'completed',
        PAUSE: 'paused',
        STOP: 'completed',
        ERROR: 'error',
      },
      prompt: 'Analyze the screenshot carefully. What is the current state? What is the most effective next action? Be precise with coordinates.',
    },
    executing: {
      entry: ['incrementActionCount', 'sendActionToDesktop'],
      on: {
        ACTION_COMPLETED: 'waitingForResult',
        PAUSE: 'paused',
        STOP: 'completed',
        ERROR: 'error',
      },
      prompt: 'An action is being sent to the browser.',
    },
    waitingForResult: {
      on: {
        SCREENSHOT_RECEIVED: 'browsing',
        PAUSE: 'paused',
        STOP: 'completed',
        ERROR: 'error',
      },
      prompt: 'Waiting for the action to complete.',
    },
    paused: {
      on: { RESUME: 'browsing', STOP: 'completed' },
      prompt: 'Agent is paused. Waiting for resume or stop.',
    },
    completed: {
      entry: ['notifyCompletion'],
      type: 'final' as const,
      prompt: 'Task completed.',
    },
    error: {
      entry: ['logError'],
      on: { RETRY: 'browsing', STOP: 'completed' },
      prompt: 'An error occurred. Consider if this can be retried or needs a different approach.',
    },
  },
};

// Built-in actions with descriptions
const BUILT_IN_ACTIONS = [
  { id: 'initializeTask', label: 'Initialize Task', desc: 'Set up task context and variables' },
  { id: 'updateLastActivity', label: 'Update Activity', desc: 'Record timestamp of last action' },
  { id: 'incrementActionCount', label: 'Increment Count', desc: 'Add 1 to action counter' },
  { id: 'recordThought', label: 'Record Thought', desc: 'Save AI reasoning to history' },
  { id: 'sendActionToDesktop', label: 'Send to Desktop', desc: 'Execute action on user machine' },
  { id: 'notifyCompletion', label: 'Notify Complete', desc: 'Signal task finished successfully' },
  { id: 'logError', label: 'Log Error', desc: 'Record error details for debugging' },
  { id: 'resetRetryCount', label: 'Reset Retries', desc: 'Set retry counter back to 0' },
  { id: 'incrementRetryCount', label: 'Increment Retry', desc: 'Add 1 to retry counter' },
] as const;

// Common events
const COMMON_EVENTS = [
  { id: 'START', desc: 'Begin the task' },
  { id: 'SCREENSHOT_RECEIVED', desc: 'New screenshot available' },
  { id: 'ACTION_DECIDED', desc: 'AI chose an action' },
  { id: 'ACTION_COMPLETED', desc: 'Action finished executing' },
  { id: 'TASK_COMPLETE', desc: 'Objective achieved' },
  { id: 'PAUSE', desc: 'User paused agent' },
  { id: 'RESUME', desc: 'User resumed agent' },
  { id: 'STOP', desc: 'User stopped agent' },
  { id: 'ERROR', desc: 'Something went wrong' },
  { id: 'RETRY', desc: 'Attempt recovery' },
] as const;

interface StateNodeData extends Record<string, unknown> {
  label: string;
  isInitial: boolean;
  isFinal: boolean;
  isSelected: boolean;
  entry?: string[];
  exit?: string[];
  invoke?: { src: string; onDone?: string; onError?: string };
  onEdit: (stateId: string) => void;
}

// Custom state node component
function StateNode({ data, id }: NodeProps<Node<StateNodeData>>) {
  const bgColor = data.isInitial
    ? 'bg-blue-600'
    : data.isFinal
    ? 'bg-green-600'
    : 'bg-slate-700';

  const borderColor = data.isSelected ? 'border-blue-400 ring-2 ring-blue-400/50' : 'border-slate-500';

  return (
    <div
      className={`px-4 py-2 rounded-lg ${bgColor} border-2 ${borderColor} shadow-lg cursor-pointer hover:border-blue-400 transition-all min-w-[120px]`}
      onClick={() => data.onEdit(id)}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />
      <div className="text-center">
        <div className="text-white font-medium text-sm">{data.label}</div>
        {data.isInitial && (
          <div className="text-[10px] text-blue-200 mt-0.5">initial</div>
        )}
        {data.isFinal && (
          <div className="text-[10px] text-green-200 mt-0.5">final</div>
        )}
        {data.entry && data.entry.length > 0 && (
          <div className="text-[10px] text-slate-300 mt-1">
            entry: {data.entry.join(', ')}
          </div>
        )}
        {data.invoke && (
          <div className="text-[10px] text-purple-300 mt-1">
            invoke: {data.invoke.src}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}

const nodeTypes = { stateNode: StateNode };

// Custom edge data interface
interface TransitionEdgeData extends Record<string, unknown> {
  label: string;
  isSelected: boolean;
  onEdit: (sourceState: string, event: string) => void;
  sourceState: string;
}

// Custom clickable edge component
function TransitionEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps<Edge<TransitionEdgeData>>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: sourcePosition || Position.Bottom,
    targetX,
    targetY,
    targetPosition: targetPosition || Position.Top,
  });

  const isSelected = data?.isSelected ?? false;
  const strokeColor = isSelected ? '#3b82f6' : (style?.stroke as string) || '#64748b';
  const strokeWidth = isSelected ? 3 : 2;

  const handleClick = () => {
    if (data?.onEdit && data?.sourceState && data?.label) {
      data.onEdit(data.sourceState, data.label);
    }
  };

  return (
    <>
      {/* Invisible wider path for easier clicking */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: 'pointer' }}
        onClick={handleClick}
      />
      {/* Visible edge */}
      <path
        d={edgePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        markerEnd={typeof markerEnd === 'string' ? markerEnd : undefined}
        style={{ cursor: 'pointer' }}
        onClick={handleClick}
      />
      {/* Label */}
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
              cursor: 'pointer',
            }}
            className={`px-1.5 py-0.5 rounded text-[10px] ${
              isSelected
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
            onClick={handleClick}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { transitionEdge: TransitionEdge };

// Auto-layout using dagre (loaded dynamically)
async function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB'
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const dagre = await import('dagre');

  const dagreGraph = new dagre.default.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 80, ranksep: 100 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 150, height: 60 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.default.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 75,
        y: nodeWithPosition.y - 30,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
}

// Synchronous version with simple manual layout (fallback)
function getSimpleLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  console.log('[getSimpleLayout] Input nodes:', nodes.length);
  const layoutedNodes = nodes.map((node, index) => ({
    ...node,
    position: {
      x: 250 + (index % 3) * 200,
      y: 100 + Math.floor(index / 3) * 150,
    },
  }));
  console.log('[getSimpleLayout] Output nodes with positions:', layoutedNodes.length);
  return { nodes: layoutedNodes, edges };
}

// Selection type
type Selection =
  | { type: 'state'; stateId: string }
  | { type: 'edge'; sourceState: string; event: string }
  | null;

// Convert machine definition to ReactFlow nodes and edges (without layout)
function machineToFlowRaw(
  machine: typeof DEFAULT_MACHINE,
  onEditState: (stateId: string) => void,
  onEditEdge: (sourceState: string, event: string) => void,
  selection: Selection | null
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  Object.entries(machine.states).forEach(([stateId, stateConfig]) => {
    nodes.push({
      id: stateId,
      type: 'stateNode',
      position: { x: 0, y: 0 },
      data: {
        label: stateId,
        isInitial: stateId === machine.initial,
        isFinal: (stateConfig as { type?: string }).type === 'final',
        isSelected: selection?.type === 'state' && selection.stateId === stateId,
        entry: (stateConfig as { entry?: string[] }).entry,
        exit: (stateConfig as { exit?: string[] }).exit,
        invoke: (stateConfig as { invoke?: { src: string; onDone?: string; onError?: string } }).invoke,
        onEdit: onEditState,
      },
    });

    // Add edges for transitions
    const stateConfigOn = (stateConfig as { on?: Record<string, string> }).on;
    if (stateConfigOn) {
      Object.entries(stateConfigOn).forEach(([event, target]) => {
        const targetState = typeof target === 'string' ? target : (target as { target: string }).target;
        if (targetState && targetState in machine.states) {
          const isEdgeSelected = selection?.type === 'edge' &&
            selection.sourceState === stateId &&
            selection.event === event;
          edges.push({
            id: `${stateId}-${event}-${targetState}`,
            source: stateId,
            target: targetState,
            // Use default edge type for now (simpler)
            label: event,
            labelStyle: { fill: isEdgeSelected ? '#3b82f6' : '#94a3b8', fontSize: 10 },
            labelBgStyle: { fill: '#1e293b', fillOpacity: 0.8 },
            labelBgPadding: [4, 2] as [number, number],
            markerEnd: { type: MarkerType.ArrowClosed, color: isEdgeSelected ? '#3b82f6' : '#64748b' },
            style: { stroke: isEdgeSelected ? '#3b82f6' : '#64748b', strokeWidth: isEdgeSelected ? 3 : 2 },
            animated: event === 'START',
            // Store data for click handling
            data: {
              label: event,
              isSelected: isEdgeSelected,
              onEdit: onEditEdge,
              sourceState: stateId,
            },
          });
        }
      });
    }

    // Add edges for invoke onDone/onError (not editable directly)
    const stateConfigInvoke = (stateConfig as { invoke?: { src: string; onDone?: string; onError?: string } }).invoke;
    if (stateConfigInvoke) {
      if (stateConfigInvoke.onDone) {
        edges.push({
          id: `${stateId}-onDone-${stateConfigInvoke.onDone}`,
          source: stateId,
          target: stateConfigInvoke.onDone,
          label: 'onDone',
          labelStyle: { fill: '#22c55e', fontSize: 10 },
          labelBgStyle: { fill: '#1e293b', fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
          markerEnd: { type: MarkerType.ArrowClosed, color: '#22c55e' },
          style: { stroke: '#22c55e', strokeDasharray: '5,5' },
        });
      }
      if (stateConfigInvoke.onError) {
        edges.push({
          id: `${stateId}-onError-${stateConfigInvoke.onError}`,
          source: stateId,
          target: stateConfigInvoke.onError,
          label: 'onError',
          labelStyle: { fill: '#ef4444', fontSize: 10 },
          labelBgStyle: { fill: '#1e293b', fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
          markerEnd: { type: MarkerType.ArrowClosed, color: '#ef4444' },
          style: { stroke: '#ef4444', strokeDasharray: '5,5' },
        });
      }
    }
  });

  return { nodes, edges };
}

interface StateSidebarProps {
  stateId: string;
  stateConfig: Record<string, unknown>;
  allStates: string[];
  onSave: (stateId: string, config: Record<string, unknown>) => void;
  onDelete: (stateId: string) => void;
  onClose: () => void;
  isInitial: boolean;
}

// Token chip component for actions
function ActionToken({
  action,
  onRemove,
  showRemove = true
}: {
  action: string;
  onRemove?: () => void;
  showRemove?: boolean;
}) {
  const info = BUILT_IN_ACTIONS.find(a => a.id === action);
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-1 bg-blue-600/20 text-blue-300 rounded text-xs"
      title={info?.desc || action}
    >
      {info?.label || action}
      {showRemove && onRemove && (
        <button onClick={onRemove} className="hover:text-white ml-0.5">×</button>
      )}
    </span>
  );
}

function StateSidebar({
  stateId,
  stateConfig,
  allStates,
  onSave,
  onDelete,
  onClose,
  isInitial,
}: StateSidebarProps) {
  const [name, setName] = useState(stateId);
  const [entryActions, setEntryActions] = useState<string[]>(
    (stateConfig.entry as string[]) || []
  );
  const [exitActions, setExitActions] = useState<string[]>(
    (stateConfig.exit as string[]) || []
  );
  const [statePrompt, setStatePrompt] = useState(
    (stateConfig.prompt as string) || ''
  );
  const [isFinal, setIsFinal] = useState(stateConfig.type === 'final');
  const [transitions, setTransitions] = useState<{ event: string; target: string }[]>(() => {
    const on = stateConfig.on as Record<string, string | { target: string }> | undefined;
    if (!on) return [];
    return Object.entries(on).map(([event, target]) => ({
      event,
      target: typeof target === 'string' ? target : target.target,
    }));
  });

  // Reset form when stateId changes
  useEffect(() => {
    setName(stateId);
    setEntryActions((stateConfig.entry as string[]) || []);
    setExitActions((stateConfig.exit as string[]) || []);
    setStatePrompt((stateConfig.prompt as string) || '');
    setIsFinal(stateConfig.type === 'final');
    const on = stateConfig.on as Record<string, string | { target: string }> | undefined;
    if (on) {
      setTransitions(Object.entries(on).map(([event, target]) => ({
        event,
        target: typeof target === 'string' ? target : target.target,
      })));
    } else {
      setTransitions([]);
    }
  }, [stateId, stateConfig]);

  const handleSave = () => {
    const config: Record<string, unknown> = {};

    if (entryActions.length > 0) {
      config.entry = entryActions;
    }
    if (exitActions.length > 0) {
      config.exit = exitActions;
    }
    if (statePrompt.trim()) {
      config.prompt = statePrompt.trim();
    }
    if (isFinal) {
      config.type = 'final';
    }
    if (transitions.length > 0) {
      config.on = transitions.reduce((acc, { event, target }) => {
        if (event && target) acc[event] = target;
        return acc;
      }, {} as Record<string, string>);
    }

    onSave(name, config);
  };

  const addTransition = () => {
    setTransitions([...transitions, { event: '', target: '' }]);
  };

  const updateTransition = (index: number, field: 'event' | 'target', value: string) => {
    const updated = [...transitions];
    updated[index][field] = value;
    setTransitions(updated);
  };

  const removeTransition = (index: number) => {
    setTransitions(transitions.filter((_, i) => i !== index));
  };

  const addAction = (actionId: string, type: 'entry' | 'exit') => {
    if (type === 'entry' && !entryActions.includes(actionId)) {
      setEntryActions([...entryActions, actionId]);
    } else if (type === 'exit' && !exitActions.includes(actionId)) {
      setExitActions([...exitActions, actionId]);
    }
  };

  const removeAction = (actionId: string, type: 'entry' | 'exit') => {
    if (type === 'entry') {
      setEntryActions(entryActions.filter(a => a !== actionId));
    } else {
      setExitActions(exitActions.filter(a => a !== actionId));
    }
  };

  return (
    <div className="w-80 bg-slate-800 border-l border-slate-700 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 shrink-0">
        <h3 className="text-sm font-semibold text-white truncate">{stateId}</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-white p-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* State Name */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-sm focus:border-blue-500 focus:outline-none"
            disabled={isInitial}
          />
          {isInitial && <p className="text-[10px] text-slate-500 mt-0.5">Initial state</p>}
        </div>

        {/* State Prompt */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            AI Prompt <span className="text-slate-500 font-normal">(instructions for this state)</span>
          </label>
          <textarea
            value={statePrompt}
            onChange={(e) => setStatePrompt(e.target.value)}
            placeholder="e.g., Analyze the screenshot and decide what action to take next..."
            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs focus:border-blue-500 focus:outline-none resize-none h-16"
          />
        </div>

        {/* Entry Actions */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Entry Actions</label>
          <div className="space-y-1.5">
            {entryActions.map(action => (
              <div key={action} className="flex items-center gap-1">
                <ActionToken action={action} showRemove={false} />
                <button onClick={() => removeAction(action, 'entry')} className="text-red-400 hover:text-red-300 p-0.5">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            <select
              value=""
              onChange={(e) => { if (e.target.value) addAction(e.target.value, 'entry'); }}
              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-slate-400 text-xs focus:border-blue-500 focus:outline-none"
            >
              <option value="">+ Add entry action...</option>
              {BUILT_IN_ACTIONS.filter(a => !entryActions.includes(a.id)).map(action => (
                <option key={action.id} value={action.id}>{action.label} - {action.desc}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Exit Actions */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Exit Actions</label>
          <div className="space-y-1.5">
            {exitActions.map(action => (
              <div key={action} className="flex items-center gap-1">
                <ActionToken action={action} showRemove={false} />
                <button onClick={() => removeAction(action, 'exit')} className="text-red-400 hover:text-red-300 p-0.5">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
            <select
              value=""
              onChange={(e) => { if (e.target.value) addAction(e.target.value, 'exit'); }}
              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-slate-400 text-xs focus:border-blue-500 focus:outline-none"
            >
              <option value="">+ Add exit action...</option>
              {BUILT_IN_ACTIONS.filter(a => !exitActions.includes(a.id)).map(action => (
                <option key={action.id} value={action.id}>{action.label} - {action.desc}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Final State Toggle */}
        <div className="flex items-center gap-2 py-1">
          <input
            type="checkbox"
            id="isFinal"
            checked={isFinal}
            onChange={(e) => setIsFinal(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-900 text-blue-600"
          />
          <label htmlFor="isFinal" className="text-xs text-slate-300">Final state</label>
        </div>

        {/* Transitions */}
        {!isFinal && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-400">Transitions</label>
              <button onClick={addTransition} className="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
            </div>
            <div className="space-y-1.5">
              {transitions.map((t, i) => (
                <div key={i} className="flex items-center gap-1">
                  <select
                    value={t.event}
                    onChange={(e) => updateTransition(i, 'event', e.target.value)}
                    className="flex-1 px-1.5 py-1 bg-slate-900 border border-slate-700 rounded text-white text-xs focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">Event...</option>
                    {COMMON_EVENTS.map(e => (
                      <option key={e.id} value={e.id}>{e.id}</option>
                    ))}
                  </select>
                  <span className="text-slate-500 text-xs">→</span>
                  <select
                    value={t.target}
                    onChange={(e) => updateTransition(i, 'target', e.target.value)}
                    className="flex-1 px-1.5 py-1 bg-slate-900 border border-slate-700 rounded text-white text-xs focus:border-blue-500 focus:outline-none"
                  >
                    <option value="">Target...</option>
                    {allStates.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button onClick={() => removeTransition(i)} className="text-red-400 hover:text-red-300 p-0.5">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
              {transitions.length === 0 && <p className="text-[10px] text-slate-500">No transitions defined</p>}
            </div>
          </div>
        )}

        {/* Help Link */}
        <div className="pt-2 border-t border-slate-700">
          <a
            href="https://statemachine.io/docs/states"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            Learn about state machines →
          </a>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 px-3 py-2 border-t border-slate-700 space-y-1.5">
        <button
          onClick={handleSave}
          className="w-full px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded font-medium"
        >
          Apply
        </button>
        {!isInitial && (
          <button
            onClick={() => {
              if (confirm(`Delete state "${stateId}"?`)) {
                onDelete(stateId);
                onClose();
              }
            }}
            className="w-full px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded"
          >
            Delete State
          </button>
        )}
      </div>
    </div>
  );
}

// Edge editing sidebar
interface EdgeSidebarProps {
  sourceState: string;
  event: string;
  targetState: string;
  allStates: string[];
  onSave: (sourceState: string, oldEvent: string, newEvent: string, newTarget: string) => void;
  onDelete: (sourceState: string, event: string) => void;
  onClose: () => void;
}

function EdgeSidebar({
  sourceState,
  event,
  targetState,
  allStates,
  onSave,
  onDelete,
  onClose,
}: EdgeSidebarProps) {
  const [eventName, setEventName] = useState(event);
  const [target, setTarget] = useState(targetState);

  useEffect(() => {
    setEventName(event);
    setTarget(targetState);
  }, [event, targetState]);

  const handleSave = () => {
    if (eventName && target) {
      onSave(sourceState, event, eventName, target);
    }
  };

  return (
    <div className="w-80 bg-slate-800 border-l border-slate-700 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
        <h3 className="text-sm font-semibold text-white">Edit Transition</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-white p-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Visual representation */}
        <div className="flex items-center gap-2 p-2 bg-slate-900 rounded text-sm">
          <span className="text-slate-300">{sourceState}</span>
          <span className="text-slate-500">—[{eventName || '?'}]→</span>
          <span className="text-slate-300">{target || '?'}</span>
        </div>

        {/* Event Name */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Event</label>
          <select
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">Select event...</option>
            {COMMON_EVENTS.map((e) => (
              <option key={e.id} value={e.id}>{e.id} — {e.desc}</option>
            ))}
          </select>
        </div>

        {/* Target State */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Target State</label>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">Select target...</option>
            {allStates.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Event description */}
        {eventName && (
          <div className="p-2 bg-slate-900/50 rounded">
            <p className="text-xs text-slate-400">
              {COMMON_EVENTS.find(e => e.id === eventName)?.desc || 'Custom event'}
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-4 py-3 border-t border-slate-700 space-y-2">
        <button
          onClick={handleSave}
          disabled={!eventName || !target}
          className="w-full px-3 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded font-medium"
        >
          Apply Changes
        </button>
        <button
          onClick={() => {
            if (confirm(`Delete transition "${event}" from ${sourceState}?`)) {
              onDelete(sourceState, event);
              onClose();
            }
          }}
          className="w-full px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded"
        >
          Delete Transition
        </button>
      </div>
    </div>
  );
}

interface VisualMachineEditorProps {
  agentId: string;
  machineDefinition: Record<string, unknown> | null;
}

export function VisualMachineEditor({ agentId, machineDefinition }: VisualMachineEditorProps) {
  const [machine, setMachine] = useState<typeof DEFAULT_MACHINE>(
    (machineDefinition as typeof DEFAULT_MACHINE) || DEFAULT_MACHINE
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Callbacks for selecting states/edges
  const handleSelectState = useCallback((stateId: string) => {
    setSelection({ type: 'state', stateId });
  }, []);

  const handleSelectEdge = useCallback((sourceState: string, event: string) => {
    setSelection({ type: 'edge', sourceState, event });
  }, []);

  // Start with simple layout, then apply dagre layout async
  const { nodes: rawNodes, edges: rawEdges } = useMemo(
    () => machineToFlowRaw(machine, handleSelectState, handleSelectEdge, selection),
    [machine, handleSelectState, handleSelectEdge, selection]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(getSimpleLayout(rawNodes, rawEdges).nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rawEdges);

  // Apply dagre layout only when machine structure changes (not on selection changes)
  useEffect(() => {
    const applyLayout = async () => {
      // Use null selection for layout - we'll update selection highlighting separately
      const { nodes: rawN, edges: rawE } = machineToFlowRaw(machine, handleSelectState, handleSelectEdge, null);
      console.log('[VisualEditor] Generated nodes:', rawN.length, 'edges:', rawE.length);
      try {
        const layouted = await getLayoutedElements(rawN, rawE);
        console.log('[VisualEditor] Dagre layout applied');
        setNodes(layouted.nodes);
        setEdges(layouted.edges);
      } catch (e) {
        console.error('[VisualEditor] Dagre layout failed:', e);
        const simple = getSimpleLayout(rawN, rawE);
        setNodes(simple.nodes);
        setEdges(simple.edges);
      }
    };
    applyLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, handleSelectState, handleSelectEdge, setNodes, setEdges]);

  // Update selection highlighting without changing positions
  useEffect(() => {
    if (!selection) return;

    setNodes((nds) =>
      nds.map((node) => ({
        ...node,
        data: {
          ...node.data,
          isSelected: selection.type === 'state' && selection.stateId === node.id,
        },
      }))
    );

    setEdges((eds) =>
      eds.map((edge) => {
        const data = edge.data as { sourceState?: string; label?: string } | undefined;
        const isSelected =
          selection.type === 'edge' &&
          data?.sourceState === selection.sourceState &&
          data?.label === selection.event;
        return {
          ...edge,
          style: { ...edge.style, stroke: isSelected ? '#3b82f6' : '#64748b', strokeWidth: isSelected ? 3 : 2 },
          labelStyle: { fill: isSelected ? '#3b82f6' : '#94a3b8', fontSize: 10 },
          markerEnd: { type: MarkerType.ArrowClosed, color: isSelected ? '#3b82f6' : '#64748b' },
          data: { ...data, isSelected },
        };
      })
    );
  }, [selection, setNodes, setEdges]);

  // Debug: log current state
  useEffect(() => {
    console.log('[VisualEditor] State updated - nodes:', nodes.length, 'edges:', edges.length);
    console.log('[VisualEditor] Machine states:', Object.keys(machine.states));
    if (nodes.length > 0) {
      console.log('[VisualEditor] First node position:', nodes[0].position);
    }
  }, [nodes, edges, machine]);

  const onConnect = useCallback(
    (params: Connection) => {
      const event = prompt('Enter event name for this transition:');
      if (event && params.source && params.target) {
        setMachine((prev) => ({
          ...prev,
          states: {
            ...prev.states,
            [params.source!]: {
              ...((prev.states as Record<string, unknown>)[params.source!] as Record<string, unknown>),
              on: {
                ...(((prev.states as Record<string, unknown>)[params.source!] as { on?: Record<string, string> })?.on || {}),
                [event]: params.target!,
              },
            },
          },
        }));
      }
    },
    []
  );

  const handleAddState = () => {
    const name = prompt('Enter new state name:');
    if (name && !(name in machine.states)) {
      setMachine((prev) => ({
        ...prev,
        states: {
          ...prev.states,
          [name]: { on: {} },
        },
      }));
      setSelection({ type: 'state', stateId: name });
    }
  };

  const handleSaveState = (stateId: string, config: Record<string, unknown>) => {
    setMachine((prev) => ({
      ...prev,
      states: {
        ...prev.states,
        [stateId]: config as Record<string, unknown>,
      },
    }));
  };

  const handleDeleteState = (stateId: string) => {
    if (stateId === machine.initial) {
      alert('Cannot delete initial state');
      return;
    }
    setMachine((prev) => {
      const { [stateId]: _, ...remainingStates } = prev.states as Record<string, unknown>;
      const cleanedStates = Object.fromEntries(
        Object.entries(remainingStates).map(([id, config]) => {
          const configTyped = config as { on?: Record<string, string> };
          if (configTyped.on) {
            const cleanedOn = Object.fromEntries(
              Object.entries(configTyped.on).filter(([, target]) => {
                const t = typeof target === 'string' ? target : (target as { target: string }).target;
                return t !== stateId;
              })
            );
            return [id, { ...configTyped, on: cleanedOn }];
          }
          return [id, config];
        })
      );
      return { ...prev, states: cleanedStates as typeof prev.states };
    });
    setSelection(null);
  };

  const handleSaveEdge = (sourceState: string, oldEvent: string, newEvent: string, newTarget: string) => {
    setMachine((prev) => {
      const stateConfig = (prev.states as Record<string, unknown>)[sourceState] as { on?: Record<string, string> } | undefined;
      if (!stateConfig || !stateConfig.on) return prev;

      // Remove old event, add new event
      const { [oldEvent]: _, ...remainingTransitions } = stateConfig.on;
      return {
        ...prev,
        states: {
          ...prev.states,
          [sourceState]: {
            ...stateConfig,
            on: {
              ...remainingTransitions,
              [newEvent]: newTarget,
            },
          },
        },
      };
    });
    // Update selection to reflect the new event name
    setSelection({ type: 'edge', sourceState, event: newEvent });
  };

  const handleDeleteEdge = (sourceState: string, event: string) => {
    setMachine((prev) => {
      const stateConfig = (prev.states as Record<string, unknown>)[sourceState] as { on?: Record<string, string> } | undefined;
      if (!stateConfig || !stateConfig.on) return prev;

      const { [event]: _, ...remainingTransitions } = stateConfig.on;
      return {
        ...prev,
        states: {
          ...prev.states,
          [sourceState]: {
            ...stateConfig,
            on: remainingTransitions,
          },
        },
      };
    });
    setSelection(null);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage(null);

    try {
      const response = await fetch(`/api/agents/${agentId}/machine`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineDefinition: machine }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to save');
      }

      setSaveMessage('Saved!');
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (e) {
      setSaveMessage(`Error: ${(e as Error).message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    if (confirm('Reset to default machine configuration?')) {
      setMachine(DEFAULT_MACHINE);
      setSelection(null);
    }
  };

  // Get currently selected edge info for the EdgeSidebar
  const getSelectedEdgeInfo = () => {
    if (selection?.type !== 'edge') return null;
    const stateConfig = (machine.states as Record<string, unknown>)[selection.sourceState] as { on?: Record<string, string> } | undefined;
    if (!stateConfig?.on) return null;
    const target = stateConfig.on[selection.event];
    if (!target) return null;
    return {
      sourceState: selection.sourceState,
      event: selection.event,
      targetState: typeof target === 'string' ? target : (target as { target: string }).target,
    };
  };

  return (
    <div className="h-full bg-slate-900 overflow-hidden flex">
      {/* Main diagram area */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeClick={(_, edge) => {
            const data = edge.data as { sourceState?: string; label?: string } | undefined;
            if (data?.sourceState && data?.label) {
              handleSelectEdge(data.sourceState, data.label);
            }
          }}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#334155" />
          <Controls className="!bg-slate-800 !border-slate-700 !rounded-lg [&>button]:!bg-slate-700 [&>button]:!border-slate-600 [&>button:hover]:!bg-slate-600" />
        </ReactFlow>

        {/* Toolbar */}
        <div className="absolute top-4 right-4 flex gap-2">
          <button
            onClick={handleAddState}
            className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded shadow"
          >
            + Add State
          </button>
          <button
            onClick={handleReset}
            className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded shadow"
          >
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white rounded shadow flex items-center gap-1"
          >
            {isSaving ? 'Saving...' : saveMessage ? saveMessage : 'Save to DB'}
          </button>
        </div>

        {/* Legend */}
        <div className="absolute bottom-4 left-4 bg-slate-800/90 rounded px-3 py-2 text-xs text-slate-400">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 bg-blue-600 rounded-sm" />
              <span>Initial</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 bg-green-600 rounded-sm" />
              <span>Final</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 bg-slate-700 rounded-sm" />
              <span>State</span>
            </div>
            <span className="text-slate-500">|</span>
            <span>Click state or transition to edit</span>
          </div>
        </div>

        {/* Hint when nothing selected */}
        {!selection && (
          <div className="absolute top-4 left-4 bg-slate-800/90 rounded px-3 py-2 text-xs text-slate-400">
            Click a state or transition to edit it
          </div>
        )}
      </div>

      {/* State Sidebar */}
      {selection?.type === 'state' && selection.stateId in machine.states && (
        <StateSidebar
          stateId={selection.stateId}
          stateConfig={(machine.states as Record<string, unknown>)[selection.stateId] as Record<string, unknown>}
          allStates={Object.keys(machine.states)}
          onSave={handleSaveState}
          onDelete={handleDeleteState}
          onClose={() => setSelection(null)}
          isInitial={selection.stateId === machine.initial}
        />
      )}

      {/* Edge Sidebar */}
      {selection?.type === 'edge' && (() => {
        const edgeInfo = getSelectedEdgeInfo();
        if (!edgeInfo) return null;
        return (
          <EdgeSidebar
            sourceState={edgeInfo.sourceState}
            event={edgeInfo.event}
            targetState={edgeInfo.targetState}
            allStates={Object.keys(machine.states)}
            onSave={handleSaveEdge}
            onDelete={handleDeleteEdge}
            onClose={() => setSelection(null)}
          />
        );
      })()}
    </div>
  );
}
