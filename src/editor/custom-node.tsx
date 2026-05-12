import { Handle, Position, useConnection, type NodeProps } from '@xyflow/react';
import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { InputDef, NodeDef, NodeOutputs } from '../core/node-def.js';
import type { HeightfieldValue, MaterialValue, Texture2DValue } from '../core/resources.js';
import { createCoreTypeRegistry } from '../core/types.js';
import { BoolInput } from './inputs/bool-input.js';
import { ColorInput } from './inputs/color-input.js';
import { NumberInput } from './inputs/number-input.js';
import { VecInput } from './inputs/vec-input.js';
import { MaterialPreview } from './material-preview.js';
import { useRegistry } from './registry.js';
import { useEditorStore } from './store.js';
import { TexturePreview } from './texture-preview.js';

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
  registry: import('../core/node-def.js').NodeRegistry,
  nodeId: string,
  socketName: string,
  side: 'source' | 'target',
): string | undefined {
  const graphNode = useEditorStore.getState().graph.nodes.find((n) => n.id === nodeId);
  if (!graphNode) return undefined;
  const def = registry.get(graphNode.kind);
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

// Only PBR materials get a sphere-on-cube material preview — terrain-splat
// and future kinds like water need geometry the preview doesn't provide.
function isMaterial(v: unknown): v is MaterialValue & { kind: 'pbr' } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { kind?: string }).kind === 'pbr'
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
  const registry = useRegistry();
  const color = typeColor(socketType);

  let matches = false;
  if (connection.inProgress && connection.fromHandle) {
    const handleId = connection.fromHandle.id;
    const handleNodeId = connection.fromHandle.nodeId;
    if (handleId && handleNodeId) {
      const fromSide: 'source' | 'target' = connection.fromHandle.type;
      const fromType = getSocketType(registry, handleNodeId, handleId, fromSide);
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

// AddSocketForm: tiny inline form shown when the user clicks "+" on a
// subgraph boundary. The text the user types becomes the socket's
// display LABEL; the store generates a stable UUID for the underlying
// `name` (which is what handles and edges reference). Labels must be
// unique within the side so the UI's collision warning prevents the
// user from making two indistinguishable sockets.
function AddSocketForm({
  existingLabels,
  onSubmit,
  onCancel,
}: {
  existingLabels: string[];
  onSubmit: (label: string, type: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('Float');
  const trimmed = label.trim();
  const duplicate = existingLabels.includes(trimmed);
  const canSubmit = trimmed.length > 0 && !duplicate;

  return (
    <div className="nodrag nopan sedon-add-socket-form">
      <input
        type="text"
        className="sedon-add-socket-name"
        placeholder="socket name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canSubmit) onSubmit(trimmed, type);
          else if (e.key === 'Escape') onCancel();
        }}
      />
      <select
        className="sedon-add-socket-type"
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        {types.list().map((t) => (
          <option key={t.id} value={t.id}>{t.id}</option>
        ))}
      </select>
      <button
        type="button"
        className="sedon-add-socket-add"
        onClick={() => canSubmit && onSubmit(trimmed, type)}
        disabled={!canSubmit}
        title={duplicate ? 'a socket with this name already exists' : ''}
      >
        Add
      </button>
      <button
        type="button"
        className="sedon-add-socket-cancel"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

export function subgraphIdFromBoundaryKind(kind: string | undefined): {
  side: 'input' | 'output';
  subgraphId: string;
} | null {
  if (!kind) return null;
  if (kind.startsWith('subgraph-input/')) {
    return { side: 'input', subgraphId: kind.slice('subgraph-input/'.length) };
  }
  if (kind.startsWith('subgraph-output/')) {
    return { side: 'output', subgraphId: kind.slice('subgraph-output/'.length) };
  }
  return null;
}

// Phantom handle ids that live on the "+ Add input/output" row of a
// subgraph boundary node. node-canvas.tsx routes connections involving
// these ids to addSubgraphSocketWithEdge instead of the normal connect
// path, so dropping an inner node's handle on the "+" creates a new
// boundary socket and wires it in one undoable step.
export const ADD_OUTPUT_HANDLE_ID = '__add_output__';
export const ADD_INPUT_HANDLE_ID = '__add_input__';

// Inline-rename editor for a subgraph boundary socket label. Click
// swaps the static label for a text input that commits on Enter/blur
// (and reverts on Escape). The caller passes a list of *other* socket
// labels on the same side so we can show a collision warning without
// blocking the user when they click-and-confirm unchanged.
function EditableSocketLabel({
  label,
  otherLabels,
  onCommit,
}: {
  label: string;
  otherLabels: string[];
  onCommit: (newLabel: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);

  if (!editing) {
    return (
      <span
        className="sedon-node-label sedon-editable-name"
        title="Click to rename"
        onClick={(e) => {
          e.stopPropagation();
          setDraft(label);
          setEditing(true);
        }}
      >
        {label}
      </span>
    );
  }

  const trimmed = draft.trim();
  const collides = trimmed !== label && otherLabels.includes(trimmed);
  const canCommit = trimmed.length > 0 && !collides;
  const commit = () => {
    if (canCommit && trimmed !== label) onCommit(trimmed);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(label);
    setEditing(false);
  };
  return (
    <input
      type="text"
      className="nodrag nopan sedon-editable-name-input"
      autoFocus
      value={draft}
      title={collides ? 'a socket with this name already exists' : ''}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') cancel();
      }}
    />
  );
}

export function CustomNode({ id, data }: NodeProps) {
  const kind = typeof data['kind'] === 'string' ? data['kind'] : undefined;
  const registry = useRegistry();
  const def: NodeDef | undefined = useMemo(
    () => (kind ? registry.get(kind) : undefined),
    [kind, registry],
  );

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
  const addSubgraphSocket = useEditorStore((s) => s.addSubgraphSocket);
  const removeSubgraphSocket = useEditorStore((s) => s.removeSubgraphSocket);
  const renameSubgraphSocket = useEditorStore((s) => s.renameSubgraphSocket);

  // Subgraph-boundary handling. The "editable side" is the one carrying
  // the subgraph's I/O list: outputs for the input-boundary, inputs for
  // the output-boundary. We render +/× affordances on that side only.
  const boundary = subgraphIdFromBoundaryKind(kind);
  const [adding, setAdding] = useState(false);

  if (!def) {
    return <div className="sedon-node sedon-node--unknown">unknown: {kind ?? '(no kind)'}</div>;
  }

  const previewTarget = previewTargetFor(myOutputs);
  const hasSlot = hasPreviewSlot(def);
  const previewBlockHeight = hasSlot ? PREVIEW_SIZE + PREVIEW_PADDING * 2 : 0;
  const inputsTop = OUTPUT_BAR_HEIGHT + HEADER_HEIGHT + previewBlockHeight;

  const valueOf = (input: InputDef) => {
    const v = inputValues?.[input.name];
    return v !== undefined ? v : input.default;
  };

  // Which socket array is the "subgraph I/O list" view of this boundary?
  const editableInputs = boundary?.side === 'output';
  const editableOutputs = boundary?.side === 'input';

  return (
    <div className="sedon-node">
      <div
        className="sedon-node-output-bar"
        style={{
          height: OUTPUT_BAR_HEIGHT,
          background: outputBarBackground(def),
          borderTopLeftRadius: NODE_RADIUS - 1,
          borderTopRightRadius: NODE_RADIUS - 1,
        }}
      />
      <div className="sedon-node-header" style={{ height: HEADER_HEIGHT }}>{def.id}</div>

      {hasSlot && (
        <div className="sedon-node-preview-block" style={{ padding: PREVIEW_PADDING }}>
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
            <div
              className="sedon-node-preview-placeholder"
              style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
            >
              —
            </div>
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
        const displayLabel = input.label ?? input.name;
        return (
          <div
            key={`row-in-${input.name}`}
            className="sedon-node-row"
            style={{ height: ROW_HEIGHT }}
            title={input.type}
          >
            {editableInputs && boundary ? (
              <EditableSocketLabel
                label={displayLabel}
                otherLabels={def.inputs
                  .filter((x) => x.name !== input.name)
                  .map((x) => x.label ?? x.name)}
                onCommit={(newLabel) =>
                  renameSubgraphSocket(boundary.subgraphId, 'output', input.name, newLabel)
                }
              />
            ) : (
              <span className="sedon-node-label">{displayLabel}</span>
            )}
            {editor && (
              <span className="nodrag nopan sedon-node-editor">{editor}</span>
            )}
            {editableInputs && boundary && (
              <button
                type="button"
                className="nodrag nopan sedon-boundary-remove"
                title="Remove this output"
                onClick={() => removeSubgraphSocket(boundary.subgraphId, 'output', input.name)}
              >
                ×
              </button>
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
      {def.outputs.map((output) => {
        const displayLabel = output.label ?? output.name;
        return (
          <div
            key={`row-out-${output.name}`}
            className="sedon-node-row sedon-node-row--output"
            style={{ height: ROW_HEIGHT }}
            title={output.type}
          >
            {editableOutputs && boundary && (
              <button
                type="button"
                className="nodrag nopan sedon-boundary-remove sedon-boundary-remove--left"
                title="Remove this input"
                onClick={() => removeSubgraphSocket(boundary.subgraphId, 'input', output.name)}
              >
                ×
              </button>
            )}
            {editableOutputs && boundary ? (
              <EditableSocketLabel
                label={displayLabel}
                otherLabels={def.outputs
                  .filter((x) => x.name !== output.name)
                  .map((x) => x.label ?? x.name)}
                onCommit={(newLabel) =>
                  renameSubgraphSocket(boundary.subgraphId, 'input', output.name, newLabel)
                }
              />
            ) : (
              displayLabel
            )}
          </div>
        );
      })}

      {boundary && (
        adding ? (
          <AddSocketForm
            existingLabels={
              boundary.side === 'input'
                ? def.outputs.map((o) => o.label ?? o.name)
                : def.inputs.map((i) => i.label ?? i.name)
            }
            onSubmit={(label, type) => {
              addSubgraphSocket(boundary.subgraphId, boundary.side, { label, type });
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <>
            <AddBoundaryHandle
              side={boundary.side}
              top={inputsTop + (def.inputs.length + def.outputs.length) * ROW_HEIGHT + ROW_HEIGHT / 2}
            />
            <button
              type="button"
              className="nodrag nopan sedon-boundary-add"
              onClick={() => setAdding(true)}
            >
              + Add {boundary.side}
            </button>
          </>
        )
      )}
    </div>
  );
}

// Drop target on the "+ Add" row of a subgraph boundary. Adopts whatever
// type the user is dragging — node-canvas.tsx detects the phantom id and
// routes to addSubgraphSocketWithEdge. Highlights whenever a drag is in
// progress on the side this phantom can receive, so it reads as a valid
// drop target without us needing to know the dragged-from type up here.
function AddBoundaryHandle({ side, top }: { side: 'input' | 'output'; top: number }) {
  const connection = useConnection();
  // Output boundary side: phantom is a TARGET (subgraph output adds an
  // input on the boundary), so it accepts drags that started from a
  // source. Input boundary: phantom is a SOURCE, accepts drags from a
  // target.
  const isOutput = side === 'output';
  let active = false;
  if (connection.inProgress && connection.fromHandle) {
    const fromSide = connection.fromHandle.type;
    active = isOutput ? fromSide === 'source' : fromSide === 'target';
  }
  const style: React.CSSProperties = {
    top,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: '#bbb',
    border: '1px dashed #fff',
    boxShadow: active ? '0 0 0 3px #ffffff44, 0 0 8px #ffffffaa' : 'none',
  };
  return (
    <Handle
      type={isOutput ? 'target' : 'source'}
      position={isOutput ? Position.Left : Position.Right}
      id={isOutput ? ADD_OUTPUT_HANDLE_ID : ADD_INPUT_HANDLE_ID}
      style={style}
    />
  );
}
