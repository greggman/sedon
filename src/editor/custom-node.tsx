import { Handle, Position, useConnection, useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { requestPicker } from './add-node-picker-bus.js';
import { CanvasContextMenu } from './canvas-context-menu.js';
import { buildCanvasMenuItems } from './canvas-menu-items.js';
import { useRenameBus } from './rename-bus.js';
import type { InputDef, NodeDef, NodeOutputs, OutputDef } from '../core/node-def.js';
import type {
  GeometryValue,
  MaterialValue,
  SceneValue,
  Texture2DValue,
} from '../core/resources.js';
import { isSubgraphInstanceKind, subgraphIdFromKind } from '../core/subgraph.js';
import { createCoreTypeRegistry } from '../core/types.js';
import { docsUrlFor } from '../docs/doc-paths.js';
import { useCanvasPanelId, useDocsLocation } from './canvas-panel-context.js';
import { useCanvasNode, useCanvasNodeOutput } from './canvas-data.js';
import { BoolInput } from './inputs/bool-input.js';
import { ColorInput } from './inputs/color-input.js';
import { GradientInput } from './inputs/gradient-editor.js';
import type { GradientStop } from '../nodes/ramp.js';
import { EnumInput } from './inputs/enum-input.js';
import { NumberInput } from './inputs/number-input.js';
import { PointListInput } from './inputs/point-list-editor.js';
import type { Point } from '../nodes/point-list.js';
import { StringInput } from './inputs/string-input.js';
import { VecInput } from './inputs/vec-input.js';
import { navigateCanvasTo } from './open-graph.js';
import { MaterialPreview } from './material-preview.js';
import { MeshPreview } from './mesh-preview.js';
import { useRegistry } from './registry.js';
import { ScenePreview } from './scene-preview.js';
import { useEditorStore, type CameraState } from './store.js';
import { ASSET_DND_TYPE, type AssetDndItem } from './assets-panel.js';
import { LeafSkeletonPreview } from './leaf-skeleton-preview.js';
import { TexturePreview } from './texture-preview.js';

const types = createCoreTypeRegistry();

// Tooltip text for an input/output socket row. First line is the type
// plus any declared numeric bounds; description (if authored) follows
// on a new line. Newlines in `title` render as multi-line tooltips in
// every browser we care about — keeps short cases compact while still
// surfacing long descriptions where they matter most.
//
// The native `title` attribute can't render HTML, so we strip the only
// markdown shape that appears commonly in descriptions: `[text](url)`
// → `text`. Backticks / asterisks read fine as-is in plain text. Full
// markdown rendering would need a custom popover; this is the cheap
// path that gets the worst case (cross-node links displayed as raw
// markdown source) looking sane.
function stripInlineMarkdown(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function socketTooltip(def: InputDef | OutputDef): string {
  const isInput = (d: InputDef | OutputDef): d is InputDef => 'min' in d || 'max' in d || 'default' in d;
  let header = def.type;
  if (isInput(def)) {
    const hasMin = def.min !== undefined;
    const hasMax = def.max !== undefined;
    if (hasMin && hasMax) header += ` (${def.min}–${def.max})`;
    else if (hasMin) header += ` (min: ${def.min})`;
    else if (hasMax) header += ` (max: ${def.max})`;
  }
  return def.description
    ? `${header}\n\n${stripInlineMarkdown(def.description)}`
    : header;
}

// Two-line stacked title (user name on top, kind label below). Fixed so
// the inputsTop math stays simple regardless of whether the user has
// named this node — an unnamed node centres its kind label vertically
// in the same height. Slightly taller than the old single-line layout,
// but consistent across the whole graph.
const HEADER_HEIGHT = 40;
const ROW_HEIGHT = 28;
const HANDLE_SIZE = 10;
const PREVIEW_SIZE = 128;
const PREVIEW_PADDING = 8;
const OUTPUT_BAR_HEIGHT = 5;
const NODE_RADIUS = 4;
// Handle .top is measured from the .react-flow__node outer edge, but row
// boxes flow inside .sedon-node's 1px border AND below the header /
// preview-block bottom borders (also 1px each). Without accounting for
// these, every handle is rendered 2–3px above its row center — visually
// "the dot doesn't align with the text". Numbers come from the matching
// CSS rules in editor.css; if you change a border there, change it here.
const NODE_BORDER = 1;
const SECTION_BORDER = 1;

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
  if (side === 'source') {
    // Per-instance extraOutputs (for-each-point) REPLACE the static
    // def.outputs when non-empty — look there first, then fall back
    // to the static list.
    const fromExtras = graphNode.extraOutputs?.find((o) => o.name === socketName)?.type;
    if (fromExtras !== undefined) return fromExtras;
    return def.outputs.find((o) => o.name === socketName)?.type;
  }
  // Inputs: def.inputs + per-instance extraInputs (concat semantics —
  // scene-merge / variadic + for-each-point both work this way).
  const fromInputExtras = graphNode.extraInputs?.find((i) => i.name === socketName)?.type;
  if (fromInputExtras !== undefined) return fromInputExtras;
  return def.inputs.find((i) => i.name === socketName)?.type;
}

function isTexture2D(v: unknown): v is Texture2DValue {
  return (
    typeof v === 'object' &&
    v !== null &&
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

function isScene(v: unknown): v is SceneValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { entities?: unknown }).entities)
  );
}

function isGeometry(v: unknown): v is GeometryValue {
  // GeometryValue carries GPU buffers + indexCount/indexFormat. The
  // `positionBuffer` field uniquely identifies it vs. other kinds.
  // Geometry instances with a CPU-side mesh additionally have `mesh`,
  // but MeshPreview can render from that, so we only require the GPU
  // shape here.
  return (
    typeof v === 'object' &&
    v !== null &&
    'positionBuffer' in v &&
    'indexCount' in v
  );
}

type PreviewTarget =
  | { kind: 'texture'; value: Texture2DValue }
  | { kind: 'material'; value: MaterialValue }
  | { kind: 'scene'; value: SceneValue }
  | { kind: 'geometry'; value: GeometryValue };

function previewTargetFor(outputs: NodeOutputs | undefined): PreviewTarget | null {
  if (!outputs) return null;
  for (const v of Object.values(outputs)) {
    if (isMaterial(v)) return { kind: 'material', value: v };
    if (isTexture2D(v)) return { kind: 'texture', value: v };
    if (isScene(v)) return { kind: 'scene', value: v };
    // Geometry comes last so a node that emits both a Scene and a
    // Geometry (none today, but possible) gets the richer preview.
    if (isGeometry(v)) return { kind: 'geometry', value: v };
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
    if (
      out.type === 'Texture2D' ||
      out.type === 'Material' ||
      out.type === 'Scene' ||
      out.type === 'Geometry'
    ) {
      return true;
    }
  }
  return false;
}

const DEFAULT_SCENE_PREVIEW_CAMERA: CameraState = {
  yaw: 0.4,
  pitch: 0.2,
  distance: 8,
  target: [0, 1, 0],
};

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

type InlineEditorOnChange = (v: unknown, opts?: { coalesce?: boolean }) => void;

function inlineEditor(
  input: InputDef,
  value: unknown,
  onChange: InlineEditorOnChange,
  // Custom widgets that need to read sibling inputs / upstream outputs
  // (e.g. point-list reads the wired Texture2D for its backdrop) get
  // the node + panel context. Optional because most widgets are
  // self-contained.
  nodeId?: string,
  panelId?: string | null,
): React.ReactNode {
  // Widget override comes first: an input may declare a `widget`
  // (e.g. 'gradient') that maps to a special editor regardless of
  // its underlying `type`. Drop-through for known widgets; if
  // unrecognised, fall through to type-based dispatch so a typo
  // in `widget` doesn't silently swallow the editor entirely.
  if (input.widget === 'gradient') {
    return (
      <GradientInput
        value={asStops(value)}
        onChange={onChange as (n: GradientStop[]) => void}
      />
    );
  }
  if (input.widget === 'point-list' && nodeId !== undefined) {
    return (
      <PointListInput
        value={asPoints(value)}
        onChange={onChange as (n: Point[]) => void}
        nodeId={nodeId}
        panelId={panelId ?? null}
      />
    );
  }
  // Optional numeric bounds are forwarded to NumberInput when present —
  // the widget clamps drag-end / typed-commit values so the UI never
  // shows a number the evaluator would silently clip.
  const numBounds: { min?: number; max?: number } = {};
  if (input.min !== undefined) numBounds.min = input.min;
  if (input.max !== undefined) numBounds.max = input.max;
  switch (input.type) {
    case 'Float':
      return <NumberInput value={asNumber(value, 0)} onChange={onChange} {...numBounds} />;
    case 'Int':
      // Enum-typed Int gets a dropdown instead of a number scrubber.
      if (input.enumOptions && input.enumOptions.length > 0) {
        return (
          <EnumInput
            value={asNumber(value, input.enumOptions[0]!.value)}
            options={input.enumOptions}
            onChange={onChange as (n: number) => void}
          />
        );
      }
      return <NumberInput value={asNumber(value, 0)} integer onChange={onChange} {...numBounds} />;
    case 'Bool':
      return <BoolInput value={asBool(value)} onChange={onChange} />;
    case 'String':
      return <StringInput value={asString(value)} onChange={onChange as (n: string) => void} />;
    case 'Color':
      return (
        <ColorInput value={asRgba(value)} onChange={onChange as (n: number[]) => void} />
      );
    case 'Texture2D':
      // Inline color picker for Texture2D inputs that opted into the
      // color-fallback affordance by declaring an `[r,g,b,a]` default
      // on the InputDef (or where an inputValue has been written as
      // an `[r,g,b,a]`). evaluate.ts auto-promotes that array into a
      // 1×1 cached Texture2DValue at eval time, so node code sees a
      // normal Texture2D and the user gets to skip the
      // `core/solid-color → core/material.basecolor` boilerplate.
      // Texture2D inputs without a color default render nothing
      // inline — they're "wire a real texture in" sockets only.
      if (isRgbaArray(value)) {
        return (
          <ColorInput value={asRgba(value)} onChange={onChange as (n: number[]) => void} />
        );
      }
      return null;
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

// Matches the shape evaluate.ts auto-promotes to a 1×1 cached
// Texture2DValue: a 3- or 4-element numeric array. Texture2D inputs
// whose value (default OR inputValue) has this shape render an
// inline color picker — the picker writes a fresh array back through
// setInputValue, eval sees it, promotes to a texture.
function isRgbaArray(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  if (v.length < 3 || v.length > 4) return false;
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return false;
  }
  return true;
}
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asPoints(v: unknown): Point[] {
  if (!Array.isArray(v)) return [];
  const out: Point[] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 3) continue;
    // Preserve trailing tuple slots (curve-2d packs left/right handle
    // deltas at indices 3..6). Only the first three are validated as
    // finite numbers since the terrain-path use case never relies on
    // anything past index 2; the curve-2d sampler does its own
    // safety check on the handle slots.
    const x = typeof p[0] === 'number' && Number.isFinite(p[0]) ? p[0] : 0;
    const y = typeof p[1] === 'number' && Number.isFinite(p[1]) ? p[1] : 0;
    const z = typeof p[2] === 'number' && Number.isFinite(p[2]) ? p[2] : 0;
    const rest = p.slice(3).map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0));
    out.push([x, y, z, ...rest] as Point);
  }
  return out;
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
function asStops(v: unknown): GradientStop[] {
  if (!Array.isArray(v)) return [{ position: 0, color: [0, 0, 0, 1] }, { position: 1, color: [1, 1, 1, 1] }];
  const out: GradientStop[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { position?: unknown; color?: unknown; midpoint?: unknown };
    if (typeof e.position !== 'number') continue;
    if (!Array.isArray(e.color) || e.color.length !== 4) continue;
    if (!e.color.every((c) => typeof c === 'number')) continue;
    const stop: GradientStop = {
      position: e.position,
      color: [e.color[0]!, e.color[1]!, e.color[2]!, e.color[3]!] as [number, number, number, number],
    };
    // Preserve the optional midpoint — earlier I forgot this, which
    // meant edits to the diamond persisted to the store but were
    // stripped on the next render, so the diamond would never move.
    if (typeof e.midpoint === 'number' && Number.isFinite(e.midpoint)) {
      stop.midpoint = e.midpoint;
    }
    out.push(stop);
  }
  if (out.length === 0) return [{ position: 0, color: [0, 0, 0, 1] }, { position: 1, color: [1, 1, 1, 1] }];
  return out;
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

// Phantom handle id for variadic node-defs (those that declare
// `extraInputsSpec`). Drops here create a new per-instance extra input
// and connect the dropped edge in one undoable step. Same drag-target
// shape as the subgraph boundary's phantom — different routing.
export const ADD_EXTRA_INPUT_HANDLE_ID = '__add_extra_input__';

// Inline-editable node title shown in the header. Two concepts:
//   • name      — the user's chosen identifier; undefined until they
//                 set one. Renaming to "" clears it back to undefined.
//   • defaultName — what to show in italic when `name` is undefined.
//                   For a regular node this equals `type`; for a
//                   subgraph wrapper it's the SubgraphDef's friendly
//                   label (e.g. "Branch Bush").
//   • type      — the structural kind, shown as the bottom-row
//                 subtitle when the user has named the node. Stays
//                 constant ("subgraph" for wrappers, the node kind
//                 for everything else) regardless of name.
// Double-click swaps to a text input that commits on Enter/blur
// (Escape reverts). An empty commit clears the name back to undefined.
function EditableNodeName({
  nodeId,
  name,
  defaultName,
  type,
  onCommit,
}: {
  nodeId: string;
  name: string | undefined;
  defaultName: string;
  type: string;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Rename-bus subscriber: when a Finder-style "create + rename now"
  // gesture (or the right-click → Rename context menu) targets this
  // node, drop straight into the editing input. The bus persists the
  // request across renders, so a request fired before this node
  // first mounted still fires the moment it does.
  const pendingNodeId = useRenameBus((s) => s.pendingNodeId);
  useEffect(() => {
    if (pendingNodeId !== nodeId) return;
    setDraft(name ?? '');
    setEditing(true);
    useRenameBus.getState().consumeNodeRename(nodeId);
  }, [pendingNodeId, nodeId, name]);

  // Focus + select-all whenever we enter edit mode. Pre-selecting
  // matches Finder / VS Code rename UX: the user can type to
  // replace, or arrow / cmd-A out of the selection to extend.
  // Replaces `autoFocus`, which would focus but leave the caret at
  // the end with nothing selected.
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  if (!editing) {
    // Two-line stack when named: bold name on top, dim type subtitle
    // below. Single dim italic line (the defaultName) when unnamed —
    // it's a placeholder telegraphing what the node will be called
    // until the user picks something else. DOUBLE-click to rename
    // (single-click bubbles to ReactFlow for node selection — matches
    // Finder / Explorer / Houdini).
    return (
      <div
        className={
          name !== undefined
            ? 'sedon-node-title sedon-editable-name'
            : 'sedon-node-title sedon-node-title--unnamed sedon-editable-name'
        }
        title={name !== undefined ? `${type} — double-click to rename` : 'Double-click to name'}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(name ?? '');
          setEditing(true);
        }}
      >
        {name !== undefined ? (
          <>
            <div className="sedon-node-title-name">{name}</div>
            <div className="sedon-node-title-kind">{type}</div>
          </>
        ) : (
          <div className="sedon-node-title-kind sedon-node-title-kind--alone">{defaultName}</div>
        )}
      </div>
    );
  }
  const commit = () => {
    onCommit(draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(name ?? '');
    setEditing(false);
  };
  return (
    <input
      ref={inputRef}
      type="text"
      className="nodrag nopan sedon-editable-name-input"
      value={draft}
      placeholder={defaultName}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') cancel();
      }}
    />
  );
}

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

export function CustomNode({ id, data, selected }: NodeProps) {
  const kind = typeof data['kind'] === 'string' ? data['kind'] : undefined;
  const registry = useRegistry();
  const def: NodeDef | undefined = useMemo(
    () => (kind ? registry.get(kind) : undefined),
    [kind, registry],
  );

  // Look up this node's data from THIS canvas's graph (not state.graph,
  // which is the globally-active editing context). With per-canvas
  // pinning, those can be different graphs — querying state.graph would
  // miss this node entirely on any canvas not currently the active edit
  // target, leaving us with empty extraInputs / inputValues / sockets
  // and triggering "scene_0 handle not found" / error 008.
  // panelId of the canvas this node renders inside (stable context).
  const canvasPanelId = useCanvasPanelId();
  // Where this canvas is hosted on the deployed site — used below to
  // build the [?] doc-link URL relative to the current page.
  const docsLocation = useDocsLocation();
  // This node's data (GraphNode + connected input sockets), subscribed
  // PER-NODE from the canvas-data store — so an edit elsewhere in the
  // graph doesn't re-render this CustomNode. The view object is
  // reference-stable across edits that don't touch this node.
  const view = useCanvasNode(canvasPanelId, id);
  const myNode = view?.node;
  const inputValues = myNode?.inputValues;
  const connectedSockets = view?.connectedSockets ?? [];
  const extraInputs = myNode?.extraInputs ?? [];
  const setInputValue = useEditorStore((s) => s.setInputValue);
  // This node's eval output — also a per-node subscription. On a cache
  // hit the output object is reference-identical across evals, so a
  // re-eval that doesn't change THIS node's output is a no-op here.
  const myOutputs = useCanvasNodeOutput(canvasPanelId, id);
  const device = useEditorStore((s) => s.device);
  const addSubgraphSocket = useEditorStore((s) => s.addSubgraphSocket);
  const removeSubgraphSocket = useEditorStore((s) => s.removeSubgraphSocket);
  const renameSubgraphSocket = useEditorStore((s) => s.renameSubgraphSocket);
  const setActiveEditing = useEditorStore((s) => s.setActiveEditing);
  const addNodeExtraInput = useEditorStore((s) => s.addNodeExtraInput);
  const removeNodeExtraInput = useEditorStore((s) => s.removeNodeExtraInput);
  const renameNode = useEditorStore((s) => s.renameNode);
  const renameSubgraph = useEditorStore((s) => s.renameSubgraph);
  const setSubgraphInputDefault = useEditorStore((s) => s.setSubgraphInputDefault);
  const attachIterationBody = useEditorStore((s) => s.attachIterationBody);
  // for-each-point's "Edit" navigation needs the bridge id
  // to step into. Header label looks up the body subgraph wrapper
  // currently placed inside the bridge so the canvas tells you which
  // body is bound at a glance.
  const isForEachPoint = kind === 'core/for-each-point';
  const forEachBridgeId = isForEachPoint
    ? (inputValues?.__bridgeId as string | undefined) ?? ''
    : '';
  const forEachBodyLabel = useEditorStore((s) => {
    if (!forEachBridgeId) return undefined;
    const bridge = s.subgraphs.find((sg) => sg.id === forEachBridgeId);
    if (!bridge) return undefined;
    // The body wrapper is whichever `subgraph/<id>` node lives inside
    // the bridge inner graph. There can only ever be at most one
    // body in the auto-wired default, but the user could place more
    // by hand; we pick the first as the "label."
    const bodyNode = bridge.graph.nodes.find((n) => n.kind.startsWith('subgraph/'));
    if (!bodyNode) return undefined;
    const bodyId = bodyNode.kind.slice('subgraph/'.length);
    return s.subgraphs.find((sg) => sg.id === bodyId)?.label;
  });

  // Subgraph-boundary handling. The "editable side" is the one carrying
  // the subgraph's I/O list: outputs for the input-boundary, inputs for
  // the output-boundary. We render +/× affordances on that side only.
  const boundary = subgraphIdFromBoundaryKind(kind);
  const [adding, setAdding] = useState(false);
  // For the INPUT boundary: subscribe to the SubgraphDef's inputs list
  // so each output row can read its `default` value and surface it as
  // an editable widget. The OutputDef itself doesn't carry `default`,
  // only the SubgraphDef.inputs[] do.
  const boundaryInputs = useEditorStore((s) =>
    boundary && boundary.side === 'input'
      ? s.subgraphs.find((g) => g.id === boundary.subgraphId)?.inputs
      : undefined,
  );

  // Subgraph-wrapper handling. A wrapper node (kind = `subgraph/<id>`)
  // shows an Edit button that swaps the editor into that subgraph and
  // looks up the per-subgraph saved camera so its Scene preview reads
  // as the user authored it.
  const subgraphId =
    kind && isSubgraphInstanceKind(kind) ? subgraphIdFromKind(kind) : null;
  const subgraphCamera = useEditorStore((s) =>
    subgraphId ? s.cameras[subgraphId] : undefined,
  );
  // For subgraph wrappers, prefer the SubgraphDef's friendly label
  // ("Oak Tree") over the kebab-id internal kind ("subgraph/oak-tree-...")
  // when displaying the "kind" subtitle. Subscribed reactively so a
  // subgraph rename in another panel updates this header live.
  const subgraphLabel = useEditorStore((s) =>
    subgraphId ? s.subgraphs.find((g) => g.id === subgraphId)?.label : undefined,
  );

  // for-each-point's "drag a subgraph asset onto this node" hover state.
  // Lives above the `if (!def)` bail-out below so the hook count stays
  // constant — without this, an unknown-kind frame skips the useState
  // and the next valid-def render throws "rendered fewer hooks than
  // expected." Could only matter for for-each-point nodes, but the hook
  // ALWAYS runs; cost is one boolean cell.
  const [forEachDragOver, setForEachDragOver] = useState(false);

  // Per-node context menu (right-click on the node body or header).
  // `null` = closed; otherwise screen + flow coordinates of the
  // click. Flow coords are captured at click time (via the canvas's
  // RF instance) so "Add Node…" and "Add Subgraph" know where to
  // drop, and "Paste" knows where to anchor. Items are unified with
  // the pane context menu via buildCanvasMenuItems — adding an item
  // there lights both surfaces up.
  const [nodeMenu, setNodeMenu] = useState<{
    screenX: number;
    screenY: number;
    flowX: number;
    flowY: number;
  } | null>(null);
  const rf = useReactFlow();

  if (!def) {
    return <div className={selected ? 'sedon-node sedon-node--unknown sedon-node--selected' : 'sedon-node sedon-node--unknown'}>unknown: {kind ?? '(no kind)'}</div>;
  }

  // Every node has ONE name and ONE type.
  //
  // For a SUBGRAPH WRAPPER, the name == the SubgraphDef's `label`
  // (e.g. "Branch Bush"). Renaming the wrapper here IS renaming the
  // subgraph — propagates to every wrapper instance and to the Asset
  // panel, so "Branch Bush" never lingers in one view after being
  // renamed in another. Wrappers do NOT carry a per-node name; the
  // identity of the wrapper IS the wrapped subgraph.
  //
  // For a REGULAR node, name is per-instance: my graph can hold three
  // perlins each named whatever the user wants ("base", "ridges", "fbm")
  // without affecting any other perlin in the project.
  const isSubgraphWrapper = subgraphId !== null;
  // for-each-point's "drop a subgraph asset to set the body" affordance.
  // The root div opts into HTML5 drop targeting (onDragOver +
  // preventDefault registers it as a drop zone); on a successful drop
  // we stop propagation so the canvas-level handler in panels.tsx
  // doesn't ALSO spawn a wrapper next to this node. Hover state lights
  // up the node so the drop target is unambiguous mid-drag. The
  // useState itself lives ABOVE the `if (!def) return` bail-out so the
  // hook count stays constant; see there.
  const onForEachDragOver = isForEachPoint
    ? (e: React.DragEvent<HTMLDivElement>) => {
        if (!e.dataTransfer.types.includes(ASSET_DND_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'link';
        if (!forEachDragOver) setForEachDragOver(true);
      }
    : undefined;
  const onForEachDragLeave = isForEachPoint
    ? () => { if (forEachDragOver) setForEachDragOver(false); }
    : undefined;
  const onForEachDrop = isForEachPoint
    ? (e: React.DragEvent<HTMLDivElement>) => {
        const raw = e.dataTransfer.getData(ASSET_DND_TYPE);
        if (!raw) return;
        e.preventDefault();
        e.stopPropagation();
        setForEachDragOver(false);
        let items: AssetDndItem[];
        try { items = JSON.parse(raw) as AssetDndItem[]; }
        catch { return; }
        // First subgraph item wins. Multi-asset drops onto a single
        // for-each-point don't really have a sensible interpretation —
        // a for-each has exactly one body.
        const sg = items.find((it) => it.kind === 'subgraph');
        if (!sg) return;
        attachIterationBody(id, `subgraph/${sg.id}`);
      }
    : undefined;
  // for-each-point shows "for-each: <body label>" (or "drop a subgraph
  // here" before a body is dropped) instead of the bare
  // `core/for-each-point`, so the canvas at a glance tells you which
  // subgraph each instance is iterating without opening the inspector.
  //
  // Boundary kinds are registered per-subgraph as `<role>/<subgraphId>`
  // (e.g. `subgraph-input/cabinet-cell`, `iteration-output/bridge-abc…`)
  // so the registry can distinguish boundaries from different subgraphs.
  // The user doesn't need to see the id — there's only ever one of each
  // boundary kind inside any given subgraph, and the id is just the
  // subgraph they're already editing. Show the role half only.
  const boundaryRole =
    def.id.startsWith('subgraph-input/') ? 'subgraph-input'
    : def.id.startsWith('subgraph-output/') ? 'subgraph-output'
    : def.id.startsWith('iteration-input/') ? 'iteration-input'
    : def.id.startsWith('iteration-output/') ? 'iteration-output'
    : null;
  const typeLabel = isSubgraphWrapper
    ? 'subgraph'
    : isForEachPoint
      ? `for-each: ${forEachBodyLabel ?? (forEachBridgeId ? '(empty bridge)' : 'drop a subgraph here')}`
      : boundaryRole ?? def.id;
  // What the editor shows + commits on. For wrappers we always have a
  // label (SubgraphDef requires one), so wrappers are always "named".
  // For regular nodes, name is the optional per-node annotation.
  const headerName = isSubgraphWrapper ? subgraphLabel : myNode?.name;
  // Only used for the unnamed placeholder. Use typeLabel here too so
  // boundary kinds render as their short role ("subgraph-input"
  // instead of "subgraph-input/<sgid>") even when the user hasn't
  // named the node — which is the common case for boundaries.
  const defaultName = typeLabel;

  const previewTarget = previewTargetFor(myOutputs);
  const hasSlot = hasPreviewSlot(def);
  const previewBlockHeight = hasSlot ? PREVIEW_SIZE + PREVIEW_PADDING * 2 + SECTION_BORDER : 0;
  const inputsTop =
    NODE_BORDER + OUTPUT_BAR_HEIGHT + HEADER_HEIGHT + SECTION_BORDER + previewBlockHeight;

  const onEditSubgraph = () => {
    if (!subgraphId) return;
    // Drill-in: navigateCanvasTo handles per-canvas pin, browser-style
    // history (push, truncating any forward branch), and the global
    // currentEditingId flip. Pinning is what keeps the click scoped to
    // this canvas — otherwise every canvas in the app would follow
    // setActiveEditing.
    if (canvasPanelId) {
      navigateCanvasTo(canvasPanelId, subgraphId);
    } else {
      setActiveEditing(subgraphId);
    }
  };
  // for-each-point's bridge is just a subgraph the user can drill
  // into the same way as a regular wrapper, but reached via the
  // owning node instead of an Assets-panel pick.
  const onEditIteration = () => {
    if (!forEachBridgeId) return;
    if (canvasPanelId) {
      navigateCanvasTo(canvasPanelId, forEachBridgeId);
    } else {
      setActiveEditing(forEachBridgeId);
    }
  };

  const valueOf = (input: InputDef) => {
    const v = inputValues?.[input.name];
    return v !== undefined ? v : input.default;
  };

  // Inputs flagged `hidden` are part of the data model (inputValues
  // round-trip through serialize / undo / fragment paste / eval) but
  // produce no inspector row and no socket. Layout indexing — handle
  // top positions, row order, output-handle offset — uses this filtered
  // list so hidden inputs don't leave invisible gaps in the node UI.
  const visibleInputs = def.inputs.filter((i) => !i.hidden);
  // Per-instance dynamic outputs (currently only set by
  // `core/for-each-point` after a body is dropped) REPLACE the static
  // def.outputs. Falls back to def.outputs when extraOutputs is
  // undefined or empty so regular nodes keep their static output
  // socket list.
  const effectiveOutputs = (myNode?.extraOutputs && myNode.extraOutputs.length > 0)
    ? myNode.extraOutputs
    : def.outputs;

  // Which socket array is the "subgraph I/O list" view of this boundary?
  const editableInputs = boundary?.side === 'output';
  const editableOutputs = boundary?.side === 'input';

  // Items for the per-node context menu — derived from the shared
  // buildCanvasMenuItems so the node menu and pane menu can't drift.
  // The shared builder always includes Add Node / Add Subgraph /
  // Cut / Copy / Paste; when given a `node` context it appends
  // Rename + (Edit on wrappers) + (Edit iteration on for-each
  // points). flowX/flowY come from the click and feed Add Node /
  // Add Subgraph / Paste so things land where the user clicked.
  // Plain const, not useMemo — buildCanvasMenuItems is a cheap
  // function call and putting a hook here would land BELOW the
  // `if (!def)` early return above, violating React's
  // hooks-must-run-in-the-same-order rule. The few-millis savings
  // a useMemo would buy aren't worth a refactor of where the
  // bail-out lives.
  // When this node's right-click is part of a MULTI-selection
  // (this node is selected + at least one other node is selected
  // too), drop the node-only items (Rename, Edit, Open Docs) since
  // they're ambiguous over multiple nodes. Cut / Copy / Extract
  // still operate on the whole selection.
  //
  // RF normally dispatches multi-select right-clicks to its
  // `onSelectionContextMenu` prop, but events on the node's own
  // DOM land here first (CustomNode's stopPropagation in
  // onContextMenu prevents RF's selection handler from firing).
  // Branching here means a single code path produces the right
  // menu for both single- and multi-selection right-clicks.
  const isMultiSelectActive = !nodeMenu
    ? false
    : (() => {
        const selectedIds = rf.getNodes().filter((n) => n.selected).map((n) => n.id);
        return selectedIds.length > 1 && selectedIds.includes(id);
      })();
  const nodeMenuItems = !nodeMenu
    ? []
    : buildCanvasMenuItems({
        flowX: nodeMenu.flowX,
        flowY: nodeMenu.flowY,
        openAddNodePicker: () => {
          if (!canvasPanelId) return;
          requestPicker({
            canvasPanelId,
            screenX: nodeMenu.screenX,
            screenY: nodeMenu.screenY,
            flowX: nodeMenu.flowX,
            flowY: nodeMenu.flowY,
          });
        },
        // Omit the node-only context entirely when multi-selected;
        // the shared items (Add Node, Add Subgraph, Cut, Copy,
        // Paste, Extract) still apply and operate on the full
        // selection, which is what the user wants.
        ...(isMultiSelectActive
          ? {}
          : {
              node: {
                id,
                isSubgraphWrapper,
                isForEachPoint,
                ...(subgraphId !== null ? { subgraphId } : {}),
                ...(forEachBridgeId !== '' ? { forEachBridgeId } : {}),
                ...(isSubgraphWrapper && subgraphId !== null
                  ? { onEdit: () => onEditSubgraph() }
                  : {}),
                ...(isForEachPoint && forEachBridgeId !== ''
                  ? { onEditIteration: () => onEditIteration() }
                  : {}),
                // Same URL the inline `?` header link uses. Only
                // set when the node's def actually carries a doc
                // block, so the menu suppresses "Open Docs" for
                // nodes that have no page.
                ...(def?.doc
                  ? { docsUrl: docsUrlFor(def.id, docsLocation) }
                  : {}),
              },
            }),
      });

  return (
    <div
      className={
        (selected ? 'sedon-node sedon-node--selected' : 'sedon-node')
        + (forEachDragOver ? ' sedon-node--drop-target' : '')
      }
      onDragOver={onForEachDragOver}
      onDragLeave={onForEachDragLeave}
      onDrop={onForEachDrop}
      // Right-click on the node body opens its context menu. We stop
      // propagation so RF's pane handler (which would otherwise show
      // the "Add Node" search popup on the bare canvas) doesn't also
      // fire. preventDefault suppresses the browser's native menu.
      // The node's root div is NOT marked as a menu-popup-root —
      // clicking the node body (when the menu is open) should
      // dismiss, matching how clicking outside the menubar's open
      // submenu dismisses it.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        setNodeMenu({
          screenX: e.clientX,
          screenY: e.clientY,
          flowX: flow.x,
          flowY: flow.y,
        });
      }}
    >
      <div
        className="sedon-node-output-bar"
        style={{
          height: OUTPUT_BAR_HEIGHT,
          background: outputBarBackground(def),
          borderTopLeftRadius: NODE_RADIUS - 1,
          borderTopRightRadius: NODE_RADIUS - 1,
        }}
      />
      <div className="sedon-node-header" style={{ height: HEADER_HEIGHT }}>
        <EditableNodeName
          nodeId={id}
          name={headerName}
          defaultName={defaultName}
          type={typeLabel}
          onCommit={(next) => {
            // Subgraph wrappers route to the def label so renaming
            // here updates EVERY view of that subgraph at once (the
            // Asset panel, every other wrapper instance). Regular
            // nodes get a per-instance name.
            if (isSubgraphWrapper && subgraphId) renameSubgraph(subgraphId, next);
            else renameNode(id, next);
          }}
        />
        {subgraphId && (
          <button
            type="button"
            className="nodrag nopan sedon-subgraph-edit"
            title="Edit this subgraph"
            onClick={onEditSubgraph}
          >
            Edit
          </button>
        )}
        {isForEachPoint && forEachBridgeId && (
          <button
            type="button"
            className="nodrag nopan sedon-subgraph-edit"
            title="Edit this for-each-point's bridge graph (wires iteration context onto body inputs)"
            onClick={onEditIteration}
          >
            Edit
          </button>
        )}
        {def?.doc && (
          <a
            className="nodrag nopan sedon-node-help"
            href={docsUrlFor(def.id, docsLocation)}
            target="_blank"
            rel="noreferrer"
            title={`Open documentation for ${def.id}`}
            onPointerDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); }}
          >
            ?
          </a>
        )}
      </div>

      {hasSlot && (
        <div
          className="sedon-node-preview-block"
          style={{
            padding: PREVIEW_PADDING,
            // Subgraph wrappers: double-clicking the preview drills
            // into the wrapped subgraph, same as clicking the "Edit"
            // button in the header. The cursor hint advertises the
            // affordance.
            ...(isSubgraphWrapper ? { cursor: 'pointer' } : {}),
          }}
          {...(isSubgraphWrapper
            ? {
                onDoubleClick: (e: React.MouseEvent) => {
                  e.stopPropagation();
                  onEditSubgraph();
                },
                title: 'Double-click to edit this subgraph',
              }
            : {})}
        >
          {previewTarget && device ? (
            // Leaf-skeleton special case: the node emits two greyscale
            // textures (shape + veins). The generic TexturePreview would
            // only show the silhouette; this composites both so the user
            // can see vein placement against the leaf at a glance.
            // Downstream consumers still see the two separate textures.
            def.id === 'leaf/skeleton'
              && myOutputs
              && isTexture2D(myOutputs.shape)
              && isTexture2D(myOutputs.veins) ? (
              <LeafSkeletonPreview
                device={device}
                shape={myOutputs.shape}
                veins={myOutputs.veins}
                size={PREVIEW_SIZE}
              />
            ) : previewTarget.kind === 'material' ? (
              <MaterialPreview
                device={device}
                material={previewTarget.value}
                size={PREVIEW_SIZE}
              />
            ) : previewTarget.kind === 'scene' ? (
              // ScenePreview always fills its parent — wrap in a
              // sized box so the in-node thumbnail stays at PREVIEW_SIZE.
              <div style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}>
                <ScenePreview
                  device={device}
                  scene={previewTarget.value}
                  camera={subgraphCamera ?? DEFAULT_SCENE_PREVIEW_CAMERA}
                />
              </div>
            ) : previewTarget.kind === 'geometry' ? (
              // Wireframe thumbnail of the raw mesh. Same fill-parent
              // pattern as ScenePreview — wrap in a sized box. We only
              // render when CPU-side mesh data is available; GPU-only
              // meshes (compute-built grass, heightfield-to-mesh with
              // cpu_access=false) fall back to the placeholder.
              previewTarget.value.mesh ? (
                <div style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}>
                  <MeshPreview
                    device={device}
                    geometry={previewTarget.value}
                  />
                </div>
              ) : (
                <div
                  className="sedon-node-preview-placeholder"
                  style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
                >
                  GPU
                </div>
              )
            ) : (
              <TexturePreview
                device={device}
                value={previewTarget.value}
                size={PREVIEW_SIZE}
              />
            )
          ) : isForEachPoint && !forEachBodyLabel ? (
            // for-each-point with no body attached: the preview slot
            // doubles as the drop hint so the user knows what to do
            // with the node. The drop-target outline (cyan border via
            // `.sedon-node--drop-target`) appears the moment a
            // subgraph asset hovers over the node.
            <div
              className="sedon-node-preview-placeholder sedon-node-preview-placeholder--hint"
              style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
            >
              drop<br/>
              subgraph<br/>
              here
            </div>
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

      {/* Render def.inputs FIRST, then any per-instance extra inputs.
       * Both sets get type-colored handles + row UI; extras additionally
       * get a × remove button (the regular inputs aren't user-removable).
       * Inputs flagged `hideSocket` skip the handle entirely — they're
       * authored-only (no wire can target them); the row's inline editor
       * still renders below. */}
      {visibleInputs.map((input, i) => (
        input.hideSocket ? null : (
          <TypedHandle
            key={`h-in-${input.name}`}
            socketName={input.name}
            socketType={input.type}
            side="input"
            top={inputsTop + i * ROW_HEIGHT + ROW_HEIGHT / 2}
          />
        )
      ))}
      {extraInputs.map((input, i) => (
        <TypedHandle
          key={`h-in-extra-${input.name}`}
          socketName={input.name}
          socketType={input.type}
          side="input"
          top={inputsTop + (visibleInputs.length + i) * ROW_HEIGHT + ROW_HEIGHT / 2}
        />
      ))}

      {visibleInputs.map((input) => {
        const connected = connectedSockets.includes(input.name);
        const editor = !connected
          ? inlineEditor(
              input,
              valueOf(input),
              (v, opts) => setInputValue(id, input.name, v, opts),
              id,
              canvasPanelId,
            )
          : null;
        const displayLabel = input.label ?? input.name;
        // Override-dot is a subgraph-wrapper concept only. Wrappers
        // have two distinct sources for an input's value — the
        // SubgraphDef-declared default and an instance-level
        // override on the wrapper node — so the dot exists to
        // visualise + reset the override. Regular nodes don't have
        // that duality (whatever's stored is just the value), so
        // they get no dot.
        const overridden =
          isSubgraphWrapper
          && !connected
          && inputValues?.[input.name] !== undefined;
        return (
          <div
            key={`row-in-${input.name}`}
            className="sedon-node-row"
            style={{ height: ROW_HEIGHT }}
            title={socketTooltip(input)}
          >
            {isSubgraphWrapper && (
              <button
                type="button"
                className={
                  overridden
                    ? 'nodrag nopan sedon-override-dot sedon-override-dot--set'
                    : 'nodrag nopan sedon-override-dot'
                }
                title={overridden ? 'Custom value — click to reset to default' : ''}
                onClick={overridden ? () => setInputValue(id, input.name, undefined) : undefined}
                aria-label={overridden ? 'Reset to default' : ''}
              />
            )}
            {editableInputs && boundary ? (
              <EditableSocketLabel
                label={displayLabel}
                otherLabels={visibleInputs
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

      {extraInputs.map((input) => (
        <div
          key={`row-in-extra-${input.name}`}
          className="sedon-node-row"
          style={{ height: ROW_HEIGHT }}
          title={input.type}
        >
          <span className="sedon-node-label">{input.name}</span>
          <button
            type="button"
            className="nodrag nopan sedon-boundary-remove"
            title="Remove this input"
            onClick={() => removeNodeExtraInput(id, input.name)}
          >
            ×
          </button>
        </div>
      ))}

      {effectiveOutputs.map((output, i) => (
        <TypedHandle
          key={`h-out-${output.name}`}
          socketName={output.name}
          socketType={output.type}
          side="output"
          top={
            inputsTop +
            (visibleInputs.length + extraInputs.length + i) * ROW_HEIGHT +
            ROW_HEIGHT / 2
          }
        />
      ))}
      {effectiveOutputs.map((output) => {
        const displayLabel = output.label ?? output.name;
        // Input-boundary output rows show an inline editor for the
        // subgraph input's `default`. The OutputDef itself doesn't
        // carry a default — it's stored on SubgraphDef.inputs[], so
        // we look it up there. Drag-to-create captured the initial
        // default from the drag-source; this editor lets the user
        // tune it after the fact.
        const boundaryInputDef = editableOutputs && boundary
          ? boundaryInputs?.find((i) => i.name === output.name)
          : undefined;
        const boundaryDefaultEditor =
          boundaryInputDef && boundary
            ? inlineEditor(
                // Only `type` is read by inlineEditor; name + label
                // keep the row labelled if anything refs them.
                { name: output.name, type: output.type, label: displayLabel },
                boundaryInputDef.default,
                (v) => setSubgraphInputDefault(boundary.subgraphId, output.name, v),
              )
            : null;
        return (
          <div
            key={`row-out-${output.name}`}
            className="sedon-node-row sedon-node-row--output"
            style={{ height: ROW_HEIGHT }}
            title={socketTooltip(output)}
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
                otherLabels={effectiveOutputs
                  .filter((x) => x.name !== output.name)
                  .map((x) => x.label ?? x.name)}
                onCommit={(newLabel) =>
                  renameSubgraphSocket(boundary.subgraphId, 'input', output.name, newLabel)
                }
              />
            ) : (
              displayLabel
            )}
            {boundaryDefaultEditor && (
              <span className="nodrag nopan sedon-node-editor">{boundaryDefaultEditor}</span>
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
                : visibleInputs.map((i) => i.label ?? i.name)
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
              top={inputsTop + (visibleInputs.length + def.outputs.length) * ROW_HEIGHT + ROW_HEIGHT / 2}
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

      {/* Variadic-node "+ Add" affordance — phantom drop target on the
       * left edge plus a button. Dragging a source output onto the
       * phantom creates a new extra socket AND the edge in one undoable
       * step; clicking the button just adds an empty socket. Only
       * renders when the def opts in via `extraInputsSpec`. */}
      {def.extraInputsSpec && !boundary && (
        <>
          <AddExtraInputHandle
            top={
              inputsTop +
              (visibleInputs.length + extraInputs.length + def.outputs.length) * ROW_HEIGHT +
              ROW_HEIGHT / 2
            }
          />
          <button
            type="button"
            className="nodrag nopan sedon-boundary-add"
            onClick={() =>
              addNodeExtraInput(
                id,
                def.extraInputsSpec!.type,
                def.extraInputsSpec!.namePrefix,
                def.inputs.length,
              )
            }
          >
            {def.extraInputsSpec.addLabel ?? '+ Add input'}
          </button>
        </>
      )}
      {nodeMenu && (
        <CanvasContextMenu
          x={nodeMenu.screenX}
          y={nodeMenu.screenY}
          items={nodeMenuItems}
          onClose={() => setNodeMenu(null)}
        />
      )}
    </div>
  );
}

// Phantom drop target for a variadic node's "+ Add" row. Highlights
// whenever a source-side drag is in progress (the only kind we can
// receive — extras are inputs, so the user is dragging an output here).
function AddExtraInputHandle({ top }: { top: number }) {
  const connection = useConnection();
  let active = false;
  if (connection.inProgress && connection.fromHandle) {
    active = connection.fromHandle.type === 'source';
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
      type="target"
      position={Position.Left}
      id={ADD_EXTRA_INPUT_HANDLE_ID}
      style={style}
    />
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
