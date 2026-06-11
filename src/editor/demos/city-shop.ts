import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Modular parametric shop, Houdini-style. Same decomposition pattern
// as city-office / city-apartment:
//
//   1. `shop-ground-floor` — 4 m big-glass storefront band (3 panels).
//   2. `shop-upper-floor`  — 3.6 m offices-over-retail band (6×2 grid).
//   3. `shop-roof-cap`     — 0.4 m bright concrete cornice that
//                            overhangs the body by 0.5 m on each side
//                            (the "awning" / cornice silhouette).
//   4. `shop-assembled`    — composes ground + ONE upper + roof.
//
// Visual differentiation from office / apartment:
//   • Bright cream-concrete frames (warmer than office's cool gray)
//   • TALL ground-floor storefront with 3 huge glass panels (vs the
//     office's 10 narrow ones) — the small-business look
//   • Cornice overhang at the roofline — distinctive silhouette
//   • Always exactly 2 floors regardless of num_floors — semantically
//     a "shop" is a low-rise mixed-use, so the variant pins its own
//     height. The picker still routes shops to the NARROWEST lots so
//     they sit alongside taller apartments / offices without clipping.
//
// Surface contract (width, depth, num_floors → scene) matches the
// other variants so the per-lot bridge can route them all through one
// scene/switch. `num_floors` is accepted but IGNORED inside the
// assembled subgraph (no upper-floor scatter, just one fixed module).

const COL = 240;
const ROW = 160;

const GROUND_HEIGHT = 4;
const UPPER_HEIGHT = 3.6;
const ROOF_HEIGHT = 0.4;
const CORNICE_OVERHANG = 1;

const CREAM_CONCRETE: [number, number, number, number] = [0.85, 0.83, 0.78, 1];
const STOREFRONT_GLASS: [number, number, number, number] = [0.18, 0.22, 0.26, 1];
const OFFICE_GLASS: [number, number, number, number] = [0.22, 0.24, 0.26, 1];

// ────────────────────────────────────────────────────────────────────
// Module 1: ground floor (4 m big-glass storefront).
// ────────────────────────────────────────────────────────────────────

export function buildShopGroundFloorSubgraph(): SubgraphDef {
  const id = 'shop-ground-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // Three huge glass panels — the small-business storefront look.
  const tex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: CREAM_CONCRETE,
      bg: STOREFRONT_GLASS,
      divisions: [3, 1],
      line_width: 0.06,
      resolution: 256,
    },
  });

  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 1.5 },
    inputValues: { width: 14, height: GROUND_HEIGHT, depth: 15 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: ROW * 1.5 },
    inputValues: {
      translate: [0, GROUND_HEIGHT / 2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 2.5 },
    inputValues: { roughness: 0.4, metallic: 0.15 },
  });
  addEdge(g, { node: tex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id,  socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Shop · ground floor',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 14 },
      { name: 'depth', type: 'Float', default: 15 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 2: upper floor (3.6 m offices-over-retail with 6×2 grid).
// ────────────────────────────────────────────────────────────────────

export function buildShopUpperFloorSubgraph(): SubgraphDef {
  const id = 'shop-upper-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  const tex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: CREAM_CONCRETE,
      bg: OFFICE_GLASS,
      divisions: [6, 2],
      line_width: 0.16,
      resolution: 256,
    },
  });

  // Authored centred at local origin. The assembled subgraph places
  // it above the ground floor.
  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { width: 14, height: UPPER_HEIGHT, depth: 15 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { roughness: 0.5, metallic: 0.1 },
  });
  addEdge(g, { node: tex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Shop · upper floor',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 14 },
      { name: 'depth', type: 'Float', default: 15 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 3: roof cap (cornice that overhangs the body).
// ────────────────────────────────────────────────────────────────────
//
// Authored at LOCAL Y=0 with the cornice's CENTRE at Y=0. The
// assembled subgraph applies the world-Y lift. Width / depth come
// from the caller PLUS a CORNICE_OVERHANG so the cornice extends
// beyond the body's footprint on every side — distinct silhouette
// from the office's flush parapet and apartment's flush parapet.

export function buildShopRoofCapSubgraph(): SubgraphDef {
  const id = 'shop-roof-cap';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // width + 1 (0.5 overhang per side). Same on depth.
  const widthPlus = addNode(g, 'math/add', {
    position: { x: COL, y: ROW * 0.5 },
    inputValues: { b: CORNICE_OVERHANG },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: widthPlus.id, socket: 'a' });
  const depthPlus = addNode(g, 'math/add', {
    position: { x: COL, y: ROW * 1 },
    inputValues: { b: CORNICE_OVERHANG },
  });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: depthPlus.id, socket: 'a' });

  const box = addNode(g, 'geom/box', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { width: 15, height: ROOF_HEIGHT, depth: 16 },
  });
  addEdge(g, { node: widthPlus.id, socket: 'result' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: depthPlus.id, socket: 'result' }, { node: box.id, socket: 'depth' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { basecolor: CREAM_CONCRETE, roughness: 0.75, metallic: 0.05 },
  });
  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Shop · roof cap',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 14 },
      { name: 'depth', type: 'Float', default: 15 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Assembly: ground + ONE upper + roof. num_floors is ignored.
// ────────────────────────────────────────────────────────────────────

export function buildShopAssembledSubgraph(): SubgraphDef {
  const id = 'shop-assembled';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 7, y: ROW * 3 } });

  // ── Ground floor (sits at Y=0..GROUND_HEIGHT) ──────────────────────
  const groundWrap = addNode(g, 'subgraph/shop-ground-floor', {
    position: { x: COL * 2, y: ROW * 1 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: groundWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: groundWrap.id, socket: 'depth' });

  // ── Upper floor (centred at GROUND_HEIGHT + UPPER_HEIGHT/2) ────────
  const upperWrap = addNode(g, 'subgraph/shop-upper-floor', {
    position: { x: COL * 2, y: ROW * 2.5 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: upperWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: upperWrap.id, socket: 'depth' });
  const upperLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 2.5 },
    inputValues: {
      translate: [0, GROUND_HEIGHT + UPPER_HEIGHT / 2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  addEdge(g, { node: upperWrap.id, socket: 'scene' }, { node: upperLift.id, socket: 'scene' });

  // ── Roof cap (centred at GROUND_HEIGHT + UPPER_HEIGHT + ROOF/2) ────
  const roofWrap = addNode(g, 'subgraph/shop-roof-cap', {
    position: { x: COL * 2, y: ROW * 4 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: roofWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: roofWrap.id, socket: 'depth' });
  const roofLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 4 },
    inputValues: {
      translate: [0, GROUND_HEIGHT + UPPER_HEIGHT + ROOF_HEIGHT / 2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  addEdge(g, { node: roofWrap.id, socket: 'scene' }, { node: roofLift.id, socket: 'scene' });

  // ── Merge ──────────────────────────────────────────────────────────
  const merge = addNode(g, 'scene/merge', { position: { x: COL * 6, y: ROW * 2.5 } });
  addEdge(g, { node: groundWrap.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: upperLift.id,  socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: roofLift.id,   socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Shop (assembled)',
    category: 'Subgraphs',
    inputs: [
      { name: 'width',      type: 'Float', default: 14 },
      { name: 'depth',      type: 'Float', default: 15 },
      // num_floors accepted for signature parity with the other
      // variants; the shop ignores it (always exactly 2 floors).
      { name: 'num_floors', type: 'Float', default: 2 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
