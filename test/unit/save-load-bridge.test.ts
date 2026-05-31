// Regression: parseSubgraphDef must preserve `owner`, `iterationKind`,
// and `version` for node-owned bridge subgraphs.
//
// Background: for-each-point owns a private bridge SubgraphDef that
// holds the iteration-input → body wiring. Its `owner` field marks it
// as node-owned (kind: 'iteration-bridge'); the editor uses that flag
// to (a) hide it from the Assets panel and (b) switch defineSubgraph
// into the bridge-eval path (which registers `bridge-eval/<id>` instead
// of a normal `subgraph/<id>` wrapper). When `owner` is stripped on
// load, both behaviours break:
//   • The bridge leaks into the Assets panel.
//   • for-each-point.evaluate looks up `bridge-eval/<id>`, finds
//     nothing (since defineSubgraph registered a regular wrapper
//     instead), and returns an empty Scene. Visible symptom: load a
//     saved scene that uses for-each-point → 3D preview is blank.
//
// Bug fix: parseSubgraphDef now carries `owner`, `iterationKind`, and
// `version` through verbatim alongside the other SubgraphDef fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVE_FORMAT_VERSION,
  parseSaveFile,
  serializeSaveFile,
} from '../../src/editor/save-load.js';
import { createGraph, addNode } from '../../src/core/graph.js';
import type { SubgraphDef } from '../../src/core/subgraph.js';

function makeBridgeSubgraph(): SubgraphDef {
  const id = 'bridge-fep';
  const g = createGraph();
  const inputBoundary = addNode(g, `subgraph-input/${id}`);
  addNode(g, `iteration-input/${id}`);
  const iterOutputBoundary = addNode(g, `iteration-output/${id}`);
  return {
    id,
    label: 'fep bridge',
    category: 'Subgraphs',
    inputs: [{ name: 'size', type: 'Vec3', optional: true }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputBoundary.id,
    outputNodeId: iterOutputBoundary.id,
    owner: { kind: 'iteration-bridge', nodeId: 'fep' },
    iterationKind: 'core/for-each-point',
    version: 7,
  };
}

test('parseSaveFile round-trips a bridge subgraph with owner + iterationKind + version intact', () => {
  const bridge = makeBridgeSubgraph();
  const file = {
    formatVersion: SAVE_FORMAT_VERSION,
    project: {
      graph: createGraph(),
      rootNodeId: 'placeholder',
      subgraphs: [bridge],
    },
  } as const;
  const text = serializeSaveFile(file);
  const reparsed = parseSaveFile(text);
  const round = reparsed.project.subgraphs[0]!;
  assert.deepEqual(round.owner, { kind: 'iteration-bridge', nodeId: 'fep' });
  assert.equal(round.iterationKind, 'core/for-each-point');
  assert.equal(round.version, 7);
});

test('parseSaveFile leaves owner/iterationKind/version absent for ordinary user subgraphs', () => {
  // Asymmetry check: the new fields shouldn't appear out of thin air
  // on a subgraph that was saved WITHOUT them. Important because the
  // assets-panel + bridge-eval registration both key off `owner` being
  // present.
  const g = createGraph();
  const inputBoundary = addNode(g, 'subgraph-input/regular-sg');
  const outputBoundary = addNode(g, 'subgraph-output/regular-sg');
  const sg: SubgraphDef = {
    id: 'regular-sg',
    label: 'regular',
    category: 'Subgraphs',
    inputs: [],
    outputs: [],
    graph: g,
    inputNodeId: inputBoundary.id,
    outputNodeId: outputBoundary.id,
  };
  const file = {
    formatVersion: SAVE_FORMAT_VERSION,
    project: {
      graph: createGraph(),
      rootNodeId: 'placeholder',
      subgraphs: [sg],
    },
  } as const;
  const text = serializeSaveFile(file);
  const reparsed = parseSaveFile(text);
  const round = reparsed.project.subgraphs[0]!;
  assert.equal(round.owner, undefined);
  assert.equal(round.iterationKind, undefined);
  assert.equal(round.version, undefined);
});
