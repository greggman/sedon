import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type IsValidConnection,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback } from 'react';
import { findNode } from '../core/graph.js';
import { createCoreTypeRegistry } from '../core/types.js';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { CustomNode } from './custom-node.js';
import { graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import { useEditorStore } from './store.js';

const nodeTypes = { sedon: CustomNode };
const nodes = createCoreNodeRegistry();
const types = createCoreTypeRegistry();

// Snapshot from the store at mount time. After this, React Flow's local state
// owns visual representation; user actions sync compute-relevant changes back
// to the store via the callbacks below.
const seed = useEditorStore.getState().graph;

export function NodeCanvas() {
  const [rfNodes, , onRfNodesChange] = useNodesState(graphToRfNodes(seed));
  const [rfEdges, setRfEdges, onRfEdgesChange] = useEdgesState(graphToRfEdges(seed));

  const connect = useEditorStore((s) => s.connect);
  const removeEdges = useEditorStore((s) => s.removeEdges);
  const removeNodes = useEditorStore((s) => s.removeNodes);

  const onNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      onRfNodesChange(changes);
      const removed = new Set<string>();
      for (const change of changes) {
        if (change.type === 'remove') removed.add(change.id);
      }
      if (removed.size > 0) removeNodes(removed);
    },
    [onRfNodesChange, removeNodes],
  );

  const onEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      onRfEdgesChange(changes);
      const removed = new Set<string>();
      for (const change of changes) {
        if (change.type === 'remove') removed.add(change.id);
      }
      if (removed.size > 0) removeEdges(removed);
    },
    [onRfEdgesChange, removeEdges],
  );

  const onConnect = useCallback<OnConnect>(
    (params: Connection) => {
      if (!params.sourceHandle || !params.targetHandle) return;
      const id = crypto.randomUUID();
      // Visual: drop any existing edge into the same input, then add the new one
      // with the same id we'll send to the store so the two stay in sync.
      setRfEdges((eds) => [
        ...eds.filter((e) => !(e.target === params.target && e.targetHandle === params.targetHandle)),
        {
          id,
          source: params.source,
          target: params.target,
          sourceHandle: params.sourceHandle,
          targetHandle: params.targetHandle,
        },
      ]);
      connect(
        id,
        { node: params.source, socket: params.sourceHandle },
        { node: params.target, socket: params.targetHandle },
      );
    },
    [connect, setRfEdges],
  );

  const isValidConnection = useCallback<IsValidConnection>(
    (params: Connection | Edge) => {
      const source = 'source' in params ? params.source : null;
      const target = 'target' in params ? params.target : null;
      const sourceHandle = 'sourceHandle' in params ? (params as Connection).sourceHandle : null;
      const targetHandle = 'targetHandle' in params ? (params as Connection).targetHandle : null;
      if (!source || !target || !sourceHandle || !targetHandle) return false;
      if (source === target) return false;

      const graph = useEditorStore.getState().graph;
      const fromNode = findNode(graph, source);
      const toNode = findNode(graph, target);
      if (!fromNode || !toNode) return false;
      const fromDef = nodes.get(fromNode.kind);
      const toDef = nodes.get(toNode.kind);
      if (!fromDef || !toDef) return false;
      const fromOut = fromDef.outputs.find((o) => o.name === sourceHandle);
      const toIn = toDef.inputs.find((i) => i.name === targetHandle);
      if (!fromOut || !toIn) return false;
      return types.isCompatible(fromOut.type, toIn.type);
    },
    [],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView
      fitViewOptions={{ padding: 0.2 }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
