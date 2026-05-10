import { Handle, Position, useConnection, type NodeProps } from '@xyflow/react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { InputDef, NodeDef, NodeOutputs } from '../core/node-def.js';
import type { HeightfieldValue, MaterialValue, Texture2DValue } from '../core/resources.js';
import { createCoreTypeRegistry } from '../core/types.js';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { BoolInput } from './inputs/bool-input.js';
import { ColorInput } from './inputs/color-input.js';
import { NumberInput } from './inputs/number-input.js';
import { VecInput } from './inputs/vec-input.js';
import { MaterialPreview } from './material-preview.js';
import { useEditorStore } from './store.js';
import { TexturePreview } from './texture-preview.js';

const nodes = createCoreNodeRegistry();
const types = createCoreTypeRegistry();

const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 28;
const HANDLE_SIZE = 10;
const PREVIEW_SIZE = 128;
const PREVIEW_PADDING = 8;
const OUTPUT_BAR_HEIGHT = 5;
const NODE_RADIUS = 4;

function typeColor(typeId: string): string {
  return types.get(typeId)?.color ?? '#888';
}

// Hard-stop gradient where each output occupies an equal-width segment of
// the bar, in declared order. Single-output nodes get a solid color.
function outputBarBackground(def: NodeDef): string {
  if (def.outputs.length === 0) return 'transparent';
  if (def.outputs.length === 1) {
    return typeColor(def.outputs[0]!.type);
  }
  const stops: string[] = [];
  const n = def.outputs.length;
  for (let i = 0; i < n; i++) {
    const color = typeColor(def.outputs[i]!.type);
    const a = (i / n) * 100;
    const b = ((i + 1) / n) * 100;
    stops.push(`${color} ${a}%`, `${color} ${b}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function getSocketType(
  nodeId: string,
  socketName: string,
  side: 'source' | 'target',
): string | undefined {
  const graphNode = useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId);
  if (!graphNode) return undefined;
  const def = nodes.get(graphNode.kind);
  if (!def) return undefined;
  if (side === 'source') return def.outputs.find((o) => o.name === socketName)?.type;
  return def.inputs.find((i) => i.name === socketName)?.type;
}

function isTexture2D(v: unknown): v is Texture2DValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    'view' in v &&
    'texture' in v &&
    'format' in v
  );
}

function isMaterial(v: unknown): v is MaterialValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    'basecolor' in v &&
    'roughness' in v &&
    'metallic' in v
  );
}

function isHeightfield(v: unknown): v is HeightfieldValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    'texture' in v &&
    'worldSize' in v &&
    'heightRange' in v
  );
}

type PreviewTarget =
  | { kind: 'texture'; value: Texture2DValue }
  | { kind: 'material'; value: MaterialValue };

function previewTargetFor(outputs: NodeOutputs | undefined): PreviewTarget | null {
  if (!outputs) return null;
  for (const v of Object.values(outputs)) {
    if (isMaterial(v)) return { kind: 'material', value: v };
    if (isHeightfield(v)) return { kind: 'texture', value: v.texture };
    if (isTexture2D(v)) return { kind: 'texture', value: v };
  }
  return null;
}

// Whether this node *type* has a preview slot — based on its declared output
// types, not on whether eval has produced data yet. Reserving the slot at
// type level keeps the node's size stable across eval transitions, so users
// can place a node and not have it grow under their cursor when the first
// preview arrives.
function hasPreviewSlot(def: NodeDef): boolean {
  for (const out of def.outputs) {
    if (out.type === 'Texture2D' || out.type === 'Material' || out.type === 'Heightfield') {
      return true;
    }
  }
  return false;
}

interface TypedHandleProps {
  socketName: string;
  socketType: string;
  side: 'input' | 'output';
  top: number;
}

function TypedHandle({ socketName, socketType, side, top }: TypedHandleProps) {
  const connection = useConnection();
  const color = typeColor(socketType);

  let matches = false;
  if (connection.inProgress && connection.fromHandle) {
    const handleId = connection.fromHandle.id;
    const handleNodeId = connection.fromHandle.nodeId;
    if (handleId && handleNodeId) {
      const fromSide: 'source' | 'target' = connection.fromHandle.type;
      const fromType = getSocketType(handleNodeId, handleId, fromSide);
      if (fromType) {
        if (side === 'input' && fromSide === 'source') {
          matches = types.isCompatible(fromType, socketType);
        } else if (side === 'output' && fromSide === 'target') {
          matches = types.isCompatible(socketType, fromType);
        }
      }
    }
  }

  const style: React.CSSProperties = {
    top,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: color,
    border: '1px solid #1a1a1f',
    boxShadow: matches ? `0 0 0 3px ${color}55, 0 0 8px ${color}` : 'none',
  };

  return (
    <Handle
      type={side === 'input' ? 'target' : 'source'}
      position={side === 'input' ? Position.Left : Position.Right}
      id={socketName}
      style={style}
    />
  );
}

function inlineEditor(
  input: InputDef,
  value: unknown,
  onChange: (v: unknown) => void,
): React.ReactNode {
  switch (input.type) {
    case 'Float':
      return <NumberInput value={asNumber(value, 0)} onChange={onChange} />;
    case 'Int':
      return <NumberInput value={asNumber(value, 0)} integer onChange={onChange} />;
    case 'Bool':
      return <BoolInput value={asBool(value)} onChange={onChange} />;
    case 'Color':
      return (
        <ColorInput value={asRgba(value)} onChange={onChange as (n: number[]) => void} />
      );
    case 'Vec2':
      return (
        <VecInput value={asVec(value, 2)} onChange={onChange as (n: number[]) => void} />
      );
    case 'Vec2i':
      return (
        <VecInput
          value={asVec(value, 2)}
          integer
          onChange={onChange as (n: number[]) => void}
        />
      );
    case 'Vec3':
      return (
        <VecInput value={asVec(value, 3)} onChange={onChange as (n: number[]) => void} />
      );
    default:
      return null;
  }
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function asBool(v: unknown): boolean {
  return v === true;
}
function asVec(v: unknown, n: number): number[] {
  if (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number')) {
    return v as number[];
  }
  return new Array(n).fill(0);
}
function asRgba(v: unknown): [number, number, number, number] {
  if (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number')) {
    return [v[0] as number, v[1] as number, v[2] as number, v[3] as number];
  }
  return [1, 1, 1, 1];
}

export function CustomNode({ id, data }: NodeProps) {
  const kind = typeof data['kind'] === 'string' ? data['kind'] : undefined;
  const def: NodeDef | undefined = useMemo(() => (kind ? nodes.get(kind) : undefined), [kind]);

  const inputValues = useEditorStore(
    (s) => s.graph.nodes.find((n) => n.id === id)?.inputValues,
  );
  const connectedSockets = useEditorStore(
    useShallow((s) =>
      s.graph.edges.filter((e) => e.to.node === id).map((e) => e.to.socket),
    ),
  );
  const setInputValue = useEditorStore((s) => s.setInputValue);
  const myOutputs = useEditorStore((s) => s.evalResult?.allOutputs.get(id));
  const device = useEditorStore((s) => s.device);

  if (!def) {
    return <div style={{ ...nodeStyle, padding: 8 }}>unknown: {kind ?? '(no kind)'}</div>;
  }

  const previewTarget = previewTargetFor(myOutputs);
  const hasSlot = hasPreviewSlot(def);
  const previewBlockHeight = hasSlot ? PREVIEW_SIZE + PREVIEW_PADDING * 2 : 0;
  const inputsTop = OUTPUT_BAR_HEIGHT + HEADER_HEIGHT + previewBlockHeight;

  const valueOf = (input: InputDef) => {
    const v = inputValues?.[input.name];
    return v !== undefined ? v : input.default;
  };

  return (
    <div style={nodeStyle}>
      <div
        style={{
          height: OUTPUT_BAR_HEIGHT,
          background: outputBarBackground(def),
          borderTopLeftRadius: NODE_RADIUS - 1,
          borderTopRightRadius: NODE_RADIUS - 1,
        }}
      />
      <div style={headerStyle}>{def.id}</div>

      {hasSlot && (
        <div style={previewBlockStyle}>
          {previewTarget && device ? (
            previewTarget.kind === 'material' ? (
              <MaterialPreview
                device={device}
                material={previewTarget.value}
                size={PREVIEW_SIZE}
              />
            ) : (
              <TexturePreview
                device={device}
                value={previewTarget.value}
                size={PREVIEW_SIZE}
              />
            )
          ) : (
            <div style={placeholderStyle}>—</div>
          )}
        </div>
      )}

      {def.inputs.map((input, i) => (
        <TypedHandle
          key={`h-in-${input.name}`}
          socketName={input.name}
          socketType={input.type}
          side="input"
          top={inputsTop + i * ROW_HEIGHT + ROW_HEIGHT / 2}
        />
      ))}

      {def.inputs.map((input) => {
        const connected = connectedSockets.includes(input.name);
        const editor = !connected
          ? inlineEditor(input, valueOf(input), (v) => setInputValue(id, input.name, v))
          : null;
        return (
          <div key={`row-in-${input.name}`} style={inputRowStyle} title={input.type}>
            <span style={labelStyle}>{input.name}</span>
            {editor && (
              <span className="nodrag nopan" style={editorContainerStyle}>
                {editor}
              </span>
            )}
          </div>
        );
      })}

      {def.outputs.map((output, i) => (
        <TypedHandle
          key={`h-out-${output.name}`}
          socketName={output.name}
          socketType={output.type}
          side="output"
          top={inputsTop + (def.inputs.length + i) * ROW_HEIGHT + ROW_HEIGHT / 2}
        />
      ))}
      {def.outputs.map((output) => (
        <div
          key={`row-out-${output.name}`}
          style={{ ...inputRowStyle, justifyContent: 'flex-end' }}
          title={output.type}
        >
          {output.name}
        </div>
      ))}
    </div>
  );
}

const nodeStyle: React.CSSProperties = {
  background: '#2a2a35',
  border: '1px solid #555',
  borderRadius: 4,
  color: '#ddd',
  fontSize: 12,
  fontFamily: 'system-ui, sans-serif',
  minWidth: 240,
};

const headerStyle: React.CSSProperties = {
  height: HEADER_HEIGHT,
  padding: '0 10px',
  background: '#3a3a48',
  borderBottom: '1px solid #555',
  display: 'flex',
  alignItems: 'center',
  fontWeight: 600,
};

const previewBlockStyle: React.CSSProperties = {
  padding: PREVIEW_PADDING,
  background: '#22222a',
  borderBottom: '1px solid #555',
};

const placeholderStyle: React.CSSProperties = {
  width: PREVIEW_SIZE,
  height: PREVIEW_SIZE,
  margin: '0 auto',
  background: '#000',
  borderRadius: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#444',
  fontSize: 24,
  userSelect: 'none',
};

const inputRowStyle: React.CSSProperties = {
  height: ROW_HEIGHT,
  padding: '0 12px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const labelStyle: React.CSSProperties = {
  flexShrink: 0,
  color: '#bbb',
};

const editorContainerStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
};
