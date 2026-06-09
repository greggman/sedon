// Macro recording for bug-repro capture. NOT a user-facing scripting
// feature — the goal is "give me a json so I don't have to type out
// my steps". Records the store-action layer (every `useEditorStore`
// method call), NOT the underlying `Command` type (which carries
// project snapshots that don't replay sensibly).
//
// Two consumers ride on the same wrapper:
//   • Menu Macro → Record / Stop Recording / Load — write a .sedon-rec
//     file, then load it back to replay.
//   • URL flag `?log-commands=1` — `console.log` each action as JSON
//     so the user can copy a few lines out of devtools.
//
// File format (v1):
//   {
//     formatVersion: 1,
//     startProject: <SaveFile.project>,   // strict starting state
//     startLayout?: <SaveFile.layout>,    // optional layout
//     actions: [ { action: string, args: SerializedArg[] }, ... ]
//   }
//
// Argument serialization: most args are plain JSON-friendly values
// (strings / numbers / arrays / nodes / edges). Two non-JSON shapes
// appear in the action surface and get encoded:
//   • `Set<string>` (removeNodes / removeEdges)  → `{__set: [...]}`
//   • `Float32Array` / `Int32Array` / etc.       → not currently used
//     by any user-callable action; if a future action takes one, we
//     throw at record time so we don't silently produce a broken
//     recording.

import { useSyncExternalStore } from 'react';
import { useEditorStore } from './store.js';
import { useLayoutStore } from './layout-store.js';
import { snapshotProject } from './file-ops.js';
import { parseSaveFile, SAVE_FORMAT_VERSION, type ProjectData, type LayoutData } from './save-load.js';
import { getDockviewApi } from './dockview-handle.js';
import type { SerializedDockview } from 'dockview-core';

// Detect `?log-commands=1` once at module load. Browsers honour
// hash-only or search-only forms; check both.
const LOG_COMMANDS = (() => {
  if (typeof window === 'undefined') return false;
  const search = new URLSearchParams(window.location.search);
  return search.get('log-commands') === '1';
})();

export const RECORDING_FORMAT_VERSION = 1;

type SerializedArg = unknown;

interface RecordedEntry {
  action: string;
  args: SerializedArg[];
}

export interface RecordingFile {
  formatVersion: typeof RECORDING_FORMAT_VERSION;
  startProject: ProjectData;
  startLayout?: LayoutData;
  actions: RecordedEntry[];
}

// Actions that produce high-frequency, non-user-meaningful noise.
// Excluded from both recording and console logging. Keep this list
// short and well-justified: it's easier to add than to remove (a
// missing log entry means a missing repro step).
const RECORDER_DENYLIST = new Set([
  // Camera/viewport persistence — drag-end churn that doesn't change
  // graph structure or eval outputs.
  'saveCameraFor',
  'saveViewportFor',
  // Drag-position commits — one per drag tick during a move. The
  // resulting node positions are saved with the recording's starting
  // snapshot anyway, so the literal drag motion isn't part of the
  // repro.
  'commitActivePositions',
  // Device init — runtime-only.
  'setDevice',
  // Pure read helpers / internal book-keeping.
  'markClean',
]);

// Live recording state. `null` = not recording.
interface ActiveRecording {
  startProject: ProjectData;
  startLayout: LayoutData | undefined;
  actions: RecordedEntry[];
}
let active: ActiveRecording | null = null;

// Subscribable so React can re-render menus when recording flips.
// Recording state is intentionally NOT in the editor store (it isn't
// editor data and shouldn't appear in undo / save), so we maintain a
// tiny listener-based store here for useSyncExternalStore. Without
// this, `Macro › Stop Recording` stays disabled after `Record` —
// nothing would tell the actions hook to re-evaluate `recordingActive()`.
const listeners = new Set<() => void>();
function subscribeRecording(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function notifyRecordingChanged(): void {
  for (const l of listeners) l();
}

function isRecording(): boolean {
  return active !== null;
}

// Type predicates kept minimal — the only non-plain shapes a current
// store action takes are Set<string> args (removeNodes / removeEdges /
// duplicateAssets-input). Anything else gets passed through JSON which
// handles primitives, plain objects, and plain arrays just fine.
function isSet(v: unknown): v is Set<unknown> {
  return v instanceof Set;
}

function serializeArg(arg: unknown): SerializedArg {
  if (isSet(arg)) return { __set: [...arg] };
  // Detect a typed-array silently slipping in — we don't currently
  // support those in recording and a broken recording is worse than
  // a loud failure when capturing.
  if (ArrayBuffer.isView(arg)) {
    throw new Error(
      `recording: typed array (${(arg as { constructor: { name: string } }).constructor.name}) ` +
        `cannot be serialized as an action argument`,
    );
  }
  return arg;
}

function deserializeArg(arg: SerializedArg): unknown {
  if (arg !== null && typeof arg === 'object' && '__set' in arg && Array.isArray((arg as { __set: unknown }).__set)) {
    return new Set((arg as { __set: unknown[] }).__set);
  }
  return arg;
}

// Wrap a single action function. Used at store-creation time once
// per action, so selectors that grab `s.foo` get the wrapped fn from
// the very first render.
export function wrapAction<Args extends unknown[], Ret>(
  name: string,
  fn: (...args: Args) => Ret,
): (...args: Args) => Ret {
  if (RECORDER_DENYLIST.has(name)) return fn;
  return (...args: Args): Ret => {
    if (LOG_COMMANDS || isRecording()) {
      let serialized: SerializedArg[];
      try {
        serialized = args.map(serializeArg);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[recording] skipping ${name}: ${(e as Error).message}`);
        return fn(...args);
      }
      if (LOG_COMMANDS) {
        // eslint-disable-next-line no-console
        console.log(`[recording] ${name}`, JSON.stringify(serialized));
      }
      if (active) {
        active.actions.push({ action: name, args: serialized });
      }
    }
    return fn(...args);
  };
}

// Wrap every function-typed property on an actions slice in one pass.
// The store's `create()` callback hands us its actions object near
// the end of construction; we mutate-in-place and return it. The
// non-function fields (graph, syncCounter, evalCache, device, …) are
// passed through unchanged.
//
// Typed as `T` in / `T` out (rather than `Record<string, unknown>`)
// so callers don't have to widen+re-narrow the EditorState slice
// through this function.
export function wrapActionsSlice<T>(slice: T): T {
  const obj = slice as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value === 'function') {
      obj[key] = wrapAction(key, value as (...args: unknown[]) => unknown);
    }
  }
  return slice;
}

function snapshotForRecording(): { project: ProjectData; layout: LayoutData | undefined } {
  return snapshotProject();
}

export function startRecording(): void {
  if (active) {
    // eslint-disable-next-line no-alert
    alert('Recording already in progress. Stop the current one first.');
    return;
  }
  const { project, layout } = snapshotForRecording();
  active = { startProject: project, startLayout: layout, actions: [] };
  notifyRecordingChanged();
  // eslint-disable-next-line no-console
  console.log('[recording] started');
}

export function stopRecording(): void {
  if (!active) {
    // eslint-disable-next-line no-alert
    alert('No recording in progress.');
    return;
  }
  const file: RecordingFile = {
    formatVersion: RECORDING_FORMAT_VERSION,
    startProject: active.startProject,
    ...(active.startLayout !== undefined ? { startLayout: active.startLayout } : {}),
    actions: active.actions,
  };
  const count = active.actions.length;
  active = null;
  notifyRecordingChanged();
  const json = JSON.stringify(file, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sedon-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.sedon-rec`;
  a.click();
  URL.revokeObjectURL(url);
  // eslint-disable-next-line no-console
  console.log(`[recording] stopped — ${count} action(s) saved`);
}

export function recordingActive(): boolean {
  return isRecording();
}

// React hook — re-renders whenever recording starts or stops. Use
// this anywhere the UI gates on recording state (e.g. enabling
// `Macro › Stop Recording` in the menu).
export function useRecordingActive(): boolean {
  return useSyncExternalStore(subscribeRecording, isRecording, isRecording);
}

// Replay a loaded recording file: reset to the captured starting
// state, then call each recorded action in order. Errors during
// replay are logged but don't abort — better to land most of the
// repro than throw away the whole sequence on one bad arg.
export async function playRecording(file: RecordingFile): Promise<void> {
  if (file.formatVersion !== RECORDING_FORMAT_VERSION) {
    throw new Error(
      `unsupported recording format ${file.formatVersion} (expected ${RECORDING_FORMAT_VERSION})`,
    );
  }
  const store = useEditorStore.getState();
  store.setGraph(
    file.startProject.graph,
    file.startProject.rootNodeId,
    file.startProject.subgraphs,
    file.startProject.cameras,
    file.startProject.viewports,
    file.startProject.folders,
  );
  if (file.startLayout) {
    useLayoutStore.setState({
      canvasGraphIds: file.startLayout.canvasGraphIds ?? {},
      pinnedGraphIds: file.startLayout.pinnedGraphIds ?? {},
      canvasViewports: file.startLayout.canvasViewports ?? {},
      previewCameras: file.startLayout.previewCameras ?? {},
      recentCanvasViewports: {},
      recentPreviewCameras: {},
    });
    const dockApi = getDockviewApi();
    if (dockApi && file.startLayout.dockview) {
      dockApi.fromJSON(file.startLayout.dockview as SerializedDockview);
      if (file.startLayout.canvasGraphIds) {
        useLayoutStore.setState({ canvasGraphIds: file.startLayout.canvasGraphIds });
      }
    }
    if (file.startLayout.currentEditingId && file.startLayout.currentEditingId !== 'main') {
      store.setActiveEditing(file.startLayout.currentEditingId);
    }
  }
  // Yield once so React commits the state restore before we start
  // dispatching actions — otherwise the very first replayed action
  // sees stale state.
  await new Promise((r) => setTimeout(r, 0));

  for (let i = 0; i < file.actions.length; i++) {
    const entry = file.actions[i]!;
    const state = useEditorStore.getState() as unknown as Record<string, unknown>;
    const fn = state[entry.action];
    if (typeof fn !== 'function') {
      // eslint-disable-next-line no-console
      console.warn(`[recording] step ${i}: no action named "${entry.action}"`);
      continue;
    }
    const args = entry.args.map(deserializeArg);
    try {
      await (fn as (...a: unknown[]) => unknown).apply(state, args);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[recording] step ${i} (${entry.action}) failed:`, e);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[recording] replayed ${file.actions.length} action(s)`);
}

export function loadRecordingFromFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.sedon-rec,.json';
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    void (async () => {
      try {
        const text = await f.text();
        const parsed = JSON.parse(text) as RecordingFile;
        // Cheap structural validation. Doesn't reuse parseSaveFile
        // because the inner project is the SaveFile project block
        // (already shape-validated at record-save time) — we just
        // re-route it through parseSaveFile by reconstructing the
        // outer wrapper.
        const dummy = {
          formatVersion: SAVE_FORMAT_VERSION,
          project: parsed.startProject,
          ...(parsed.startLayout !== undefined ? { layout: parsed.startLayout } : {}),
        };
        const reparsed = parseSaveFile(JSON.stringify(dummy));
        const file: RecordingFile = {
          formatVersion: parsed.formatVersion,
          startProject: reparsed.project,
          ...(reparsed.layout !== undefined ? { startLayout: reparsed.layout } : {}),
          actions: parsed.actions,
        };
        await playRecording(file);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-alert
        alert(`Failed to load recording: ${msg}`);
      }
    })();
  };
  input.click();
}
